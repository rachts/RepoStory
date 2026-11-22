import { Readable, PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import tar from "tar-stream";
import type { RepositoryFile } from "@/domain/repository";
import type { AnalysisLimits, AnalysisBudget } from "@/shared/limits";
import type { CacheStore } from "@/application/cache/cache-store";
import { decodeFileBuffer, normalizeRepositoryPath, type SkipReason } from "@/analysis/file-decoder";
import { AppError } from "@/domain/errors";

export interface SkippedFileDetail {
  path: string;
  reason: SkipReason;
  details?: string;
}

export interface ArchiveExtractionResult {
  files: RepositoryFile[];
  coverageDetails: SkippedFileDetail[];
  skippedByReason: {
    tooLarge: number;
    unsupported: number;
    limitReached: number;
    lfsPointer: number;
    submodule: number;
    unsupportedEncoding: number;
    pathCollision: number;
  };
  totalExtractedBytes: number;
}

export interface ArchiveExtractionOptions {
  stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>;
  candidatePaths: Set<string>;
  limits: AnalysisLimits;
  budget?: AnalysisBudget;
  cacheStore?: CacheStore;
  cacheKeyPrefix?: string;
  signal?: AbortSignal;
  inactivityTimeoutMs?: number;
  totalBytes?: number;
  throttleMs?: number;
  onProgress?: (progress: { stage: string; progress: number; message: string }) => void;
}

function normalizeExtractionError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && (err.name === "AbortError" || message.includes("aborted"))) {
    return new AppError({
      code: "ANALYSIS_TIMEOUT",
      stage: "fetch",
      message: `Archive extraction aborted: ${message}`,
      retryable: true,
    });
  }
  if (
    message.includes("decompress") ||
    message.includes("incorrect header check") ||
    message.includes("invalid block type") ||
    message.includes("zlib")
  ) {
    return new AppError({
      code: "ARCHIVE_DECOMPRESSION_FAILED",
      stage: "blob",
      message: `Archive decompression failed: ${message}`,
      retryable: true,
    });
  }
  return new AppError({
    code: "ARCHIVE_EXTRACTION_FAILED",
    stage: "blob",
    message: `Archive extraction failed: ${message}`,
    retryable: true,
  });
}

export async function extractRepositoryArchive(
  options: ArchiveExtractionOptions,
): Promise<ArchiveExtractionResult> {
  const {
    candidatePaths,
    limits,
    budget,
    cacheStore,
    cacheKeyPrefix,
    signal,
  } = options;

  const nodeReadable: Readable = "getReader" in options.stream
    ? Readable.fromWeb(options.stream as unknown as import("node:stream/web").ReadableStream)
    : (options.stream as unknown as Readable);

  const files: RepositoryFile[] = [];
  const coverageDetails: SkippedFileDetail[] = [];
  const skippedByReason = {
    tooLarge: 0,
    unsupported: 0,
    limitReached: 0,
    lfsPointer: 0,
    submodule: 0,
    unsupportedEncoding: 0,
    pathCollision: 0,
  };

  let totalExtractedBytes = 0;
  let extractionAborted = false;
  const processedPaths = new Set<string>();

  const gunzip = createGunzip();
  const extract = tar.extract();

  const internalController = new AbortController();
  let fatalError: AppError | undefined;
  let watchdogTimer: NodeJS.Timeout | undefined;
  let deadlineTimer: NodeJS.Timeout | undefined;

  const defaultInactivityMs = 15_000;
  const inactivityTimeoutMs = options.inactivityTimeoutMs ?? (
    process.env.ARCHIVE_INACTIVITY_TIMEOUT_MS ? Number(process.env.ARCHIVE_INACTIVITY_TIMEOUT_MS) : defaultInactivityMs
  );

  const destroyAll = (err?: Error) => {
    if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = undefined; }
    if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = undefined; }

    try { nodeReadable.destroy(err); } catch { /* ignore */ }
    try { watchdogPassThrough.destroy(err); } catch { /* ignore */ }
    try { gunzip.destroy(err); } catch { /* ignore */ }
    try { extract.destroy(err); } catch { /* ignore */ }

    if ("cancel" in options.stream && typeof options.stream.cancel === "function") {
      if (!("locked" in options.stream && (options.stream as { locked?: boolean }).locked)) {
        try {
          void (options.stream.cancel(err) as Promise<unknown> | undefined)?.catch(() => {});
        } catch { /* ignore */ }
      }
    } else if ("destroy" in options.stream && typeof (options.stream as unknown as { destroy: (e?: Error) => void }).destroy === "function") {
      try { (options.stream as unknown as { destroy: (e?: Error) => void }).destroy(err); } catch { /* ignore */ }
    }
  };

  const abort = (err: Error) => {
    if (extractionAborted) return;
    extractionAborted = true;
    if (!fatalError) {
      fatalError = err instanceof AppError ? err : new AppError({
        code: "ARCHIVE_EXTRACTION_FAILED",
        stage: "blob",
        message: err.message,
        retryable: true,
      });
    }
    destroyAll(fatalError);
    internalController.abort(fatalError);
  };

  const resetWatchdog = () => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      if (extractionAborted) return;
      extractionAborted = true;
      fatalError = new AppError({
        code: "ARCHIVE_DOWNLOAD_STALLED",
        stage: "fetch",
        message: `Archive download stalled: no data received for ${inactivityTimeoutMs / 1000}s.`,
        reason: "Archive download stalled: connection became inactive.",
        hint: "The connection to GitHub stalled during archive download. Retrying may succeed.",
        retryable: true,
      });
      destroyAll(fatalError);
      internalController.abort(fatalError);
    }, inactivityTimeoutMs);
  };

  // Start the watchdog initially in case stream never produces any chunks
  resetWatchdog();

  // Watchdog monitor pass-through stream with byte-level & time-based progress reporting (45 -> 60)
  let receivedBytes = 0;
  let lastReportedProgress = 44;
  let lastReportTime = 0;
  const streamStartTime = Date.now();
  const throttleIntervalMs = options.throttleMs ?? 1000;

  const watchdogPassThrough = new PassThrough();
  watchdogPassThrough.on("data", (chunk: Buffer | Uint8Array) => {
    resetWatchdog();
    receivedBytes += chunk.length;
    const now = Date.now();
    let currentProgress: number;
    let message: string;

    if (options.totalBytes && options.totalBytes > 0) {
      const ratio = Math.min(1, receivedBytes / options.totalBytes);
      currentProgress = Math.min(60, Math.max(45, Math.round(45 + ratio * 15)));
      const totalMb = (options.totalBytes / (1024 * 1024)).toFixed(1);
      message = `Downloading repository archive (${currentProgress}% of ${totalMb}MB)`;
    } else {
      const elapsedSec = (now - streamStartTime) / 1000;
      // Asymptotic time curve: 45 + 15 * (1 - e^(-elapsed/8)), strictly capped at 60
      const timeCurve = 45 + Math.round(15 * (1 - Math.exp(-elapsedSec / 8)));
      // Byte factor: scale with bytes received
      const byteFactor = 45 + Math.floor(Math.log2(1 + receivedBytes / 512));
      currentProgress = Math.min(60, Math.max(45, Math.max(timeCurve, byteFactor)));
      const receivedMb = (receivedBytes / (1024 * 1024)).toFixed(1);
      message = `Downloading repository archive (${currentProgress}% - ${receivedMb}MB received)`;
    }

    // Guarantee progress never goes backwards
    if (currentProgress < lastReportedProgress) {
      currentProgress = lastReportedProgress;
    }

    const isThrottled = lastReportTime > 0 && now - lastReportTime < throttleIntervalMs;
    if (currentProgress > lastReportedProgress && (!isThrottled || currentProgress >= 60)) {
      lastReportedProgress = currentProgress;
      lastReportTime = now;
      options.onProgress?.({
        stage: "fetch-archive",
        progress: currentProgress,
        message,
      });
    }
  });

  // Calculate remaining budget deadline
  const remainingMs = budget?.remainingMs ? budget.remainingMs() : limits.maxAnalysisMs;
  if (Number.isFinite(remainingMs) && remainingMs > 0) {
    deadlineTimer = setTimeout(() => {
      if (extractionAborted) return;
      extractionAborted = true;
      fatalError = new AppError({
        code: "ANALYSIS_TIMEOUT",
        stage: "fetch",
        message: `Archive extraction timed out after ${remainingMs}ms (analysis budget exceeded).`,
        reason: "Analysis execution exceeded time budget during archive extraction.",
        hint: "Try analyzing a smaller branch or increasing the timeout limit.",
        retryable: true,
      });
      destroyAll(fatalError);
      internalController.abort(fatalError);
    }, remainingMs);
  }

  // Handle external abort signal
  if (signal) {
    if (signal.aborted) {
      extractionAborted = true;
      fatalError = new AppError({ code: "ANALYSIS_TIMEOUT", stage: "fetch", message: "Archive extraction aborted by timeout.", retryable: true });
      destroyAll(fatalError);
      throw fatalError;
    }
    signal.addEventListener("abort", () => {
      if (extractionAborted) return;
      extractionAborted = true;
      fatalError = new AppError({ code: "ANALYSIS_TIMEOUT", stage: "fetch", message: "Archive extraction aborted by timeout.", retryable: true });
      destroyAll(fatalError);
      internalController.abort(fatalError);
    }, { once: true });
  }

  gunzip.on("error", (err) => {
    if (extractionAborted) return;
    abort(new AppError({ code: "ARCHIVE_DECOMPRESSION_FAILED", stage: "blob", message: `Archive decompression failed: ${err.message}`, retryable: true }));
  });

  extract.on("error", (err) => {
    if (extractionAborted) return;
    abort(new AppError({ code: "ARCHIVE_EXTRACTION_FAILED", stage: "blob", message: `Archive extraction failed: ${err.message}`, retryable: true }));
  });

  extract.on("entry", (header, entryStream, next) => {
    if (extractionAborted) {
      entryStream.resume();
      return;
    }

    try {
      budget?.check();
    } catch (err) {
      abort(err instanceof Error ? err : new Error(String(err)));
      entryStream.resume();
      return;
    }

    // Root entry in GitHub tarballs is typically `{owner}-{repo}-{sha}/`
    const slashIndex = header.name.indexOf("/");
    if (slashIndex === -1) {
      entryStream.resume();
      next();
      return;
    }

    const rawPath = header.name.slice(slashIndex + 1);
    if (!rawPath) {
      entryStream.resume();
      next();
      return;
    }

    const relativePath = normalizeRepositoryPath(rawPath);

    // Only extract regular files
    if (header.type !== "file") {
      entryStream.resume();
      next();
      return;
    }

    // If this file is not among the filtered candidates, skip without buffering
    if (!candidatePaths.has(relativePath)) {
      entryStream.resume();
      next();
      return;
    }

    // If header says file is already larger than maxContentBytes, skip immediately
    if (typeof header.size === "number" && header.size > limits.maxContentBytes) {
      coverageDetails.push({ path: relativePath, reason: "too-large" });
      skippedByReason.tooLarge += 1;
      processedPaths.add(relativePath);
      entryStream.resume();
      next();
      return;
    }

    const chunks: Buffer[] = [];
    let entryBytes = 0;
    let fileTooLarge = false;

    entryStream.on("data", (chunk: unknown) => {
      if (fileTooLarge || extractionAborted) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      entryBytes += buf.byteLength;
      if (entryBytes > limits.maxContentBytes) {
        fileTooLarge = true;
        coverageDetails.push({ path: relativePath, reason: "too-large" });
        skippedByReason.tooLarge += 1;
        processedPaths.add(relativePath);
        chunks.length = 0;
        return;
      }
      chunks.push(buf);
    });

    entryStream.on("end", async () => {
      if (extractionAborted || fileTooLarge) {
        next();
        return;
      }

      try {
        budget?.check();

        const mem = process.memoryUsage().heapUsed;
        const maxHeapBytes = Number(process.env.MAX_HEAP_BYTES) || 512 * 1024 * 1024;
        if (mem > maxHeapBytes) {
          coverageDetails.push({ path: relativePath, reason: "limit-reached", details: "Memory budget reached" });
          skippedByReason.limitReached += 1;
          processedPaths.add(relativePath);
          next();
          return;
        }

        if (totalExtractedBytes + entryBytes > limits.maxTotalBytes) {
          coverageDetails.push({ path: relativePath, reason: "limit-reached", details: "Total bytes limit reached" });
          skippedByReason.limitReached += 1;
          processedPaths.add(relativePath);
          next();
          return;
        }

        const fileBuffer = Buffer.concat(chunks);
        const decoded = decodeFileBuffer(fileBuffer, {
          fetchLfs: process.env.FETCH_LFS === "true",
          maxLfsBytes: Number(process.env.MAX_LFS_BYTES) || 5 * 1024 * 1024,
        });

        if (!decoded.ok) {
          const reason = decoded.reason ?? "unsupported-encoding";
          coverageDetails.push({ path: relativePath, reason });
          if (reason === "lfs-pointer") skippedByReason.lfsPointer += 1;
          else if (reason === "unsupported-encoding") skippedByReason.unsupportedEncoding += 1;
          else if (reason === "too-large") skippedByReason.tooLarge += 1;
          processedPaths.add(relativePath);
          next();
          return;
        }

        const content = decoded.content ?? "";
        const actualBytes = Buffer.byteLength(content, "utf8");
        totalExtractedBytes += actualBytes;

        files.push({
          path: relativePath,
          type: "file",
          sizeBytes: entryBytes || actualBytes,
          content,
          isAnalyzable: true,
        });
        processedPaths.add(relativePath);

        if (cacheStore && cacheKeyPrefix) {
          void cacheStore.set(`${cacheKeyPrefix}${relativePath}`, content, 3_600_000).catch(() => {});
        }

        next();
      } catch (err) {
        abort(err instanceof Error ? err : new Error(String(err)));
      }
    });

    entryStream.on("error", (err) => {
      abort(new AppError({ code: "ARCHIVE_ENTRY_FAILED", stage: "blob", message: `Failed to read archive entry ${relativePath}: ${err.message}`, retryable: true }));
    });
  });

  try {
    await pipeline(nodeReadable, watchdogPassThrough, gunzip, extract, { signal: internalController.signal });
  } catch (err: unknown) {
    destroyAll(fatalError ?? (err instanceof Error ? err : undefined));
    if (fatalError) throw fatalError;
    throw normalizeExtractionError(err);
  } finally {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    files,
    coverageDetails,
    skippedByReason,
    totalExtractedBytes,
  };
}
