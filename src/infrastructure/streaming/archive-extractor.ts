import { Readable } from "node:stream";
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

  const nodeReadable = "getReader" in options.stream
    ? Readable.fromWeb(options.stream as unknown as import("node:stream/web").ReadableStream)
    : (options.stream as NodeJS.ReadableStream);

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

  return new Promise<ArchiveExtractionResult>((resolve, reject) => {
    const gunzip = createGunzip();
    const extract = tar.extract();

    const cleanup = () => {
      gunzip.removeAllListeners();
      extract.removeAllListeners();
    };

    const abort = (err: Error) => {
      if (extractionAborted) return;
      extractionAborted = true;
      cleanup();
      try { extract.destroy(); } catch { /* ignore */ }
      try { gunzip.destroy(); } catch { /* ignore */ }
      reject(err);
    };

    if (signal) {
      if (signal.aborted) {
        return abort(new AppError({ code: "ANALYSIS_TIMEOUT", message: "Archive extraction aborted by timeout.", retryable: true }));
      }
      signal.addEventListener("abort", () => {
        abort(new AppError({ code: "ANALYSIS_TIMEOUT", message: "Archive extraction aborted by timeout.", retryable: true }));
      }, { once: true });
    }

    gunzip.on("error", (err) => {
      abort(new AppError({ code: "ARCHIVE_DECOMPRESSION_FAILED", message: `Archive decompression failed: ${err.message}`, retryable: true }));
    });

    extract.on("error", (err) => {
      abort(new AppError({ code: "ARCHIVE_EXTRACTION_FAILED", message: `Archive extraction failed: ${err.message}`, retryable: true }));
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
            await cacheStore.set(`${cacheKeyPrefix}${relativePath}`, content, 3_600_000);
          }

          next();
        } catch (err) {
          abort(err instanceof Error ? err : new Error(String(err)));
        }
      });

      entryStream.on("error", (err) => {
        abort(new AppError({ code: "ARCHIVE_ENTRY_FAILED", message: `Failed to read archive entry ${relativePath}: ${err.message}`, retryable: true }));
      });
    });

    extract.on("finish", () => {
      if (extractionAborted) return;
      cleanup();
      files.sort((a, b) => a.path.localeCompare(b.path));
      resolve({
        files,
        coverageDetails,
        skippedByReason,
        totalExtractedBytes,
      });
    });

    nodeReadable.pipe(gunzip).pipe(extract);
  });
}
