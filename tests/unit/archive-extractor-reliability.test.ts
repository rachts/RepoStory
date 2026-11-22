import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import tar from "tar-stream";
import { extractRepositoryArchive } from "@/infrastructure/streaming/archive-extractor";
import { DEFAULT_LIMITS, createAnalysisBudget } from "@/shared/limits";

async function createTarGzBuffer(files: Array<{ path: string; content: string }>): Promise<Buffer> {
  const pack = tar.pack();
  for (const file of files) {
    pack.entry({ name: `repo-main/${file.path}` }, file.content);
  }
  pack.finalize();
  const gzip = createGzip();
  const stream = pack.pipe(gzip);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

describe("Archive Extractor Reliability", () => {
  it("happy path: extracts repository files from a valid tar.gz stream", async () => {
    const tarGzBuffer = await createTarGzBuffer([
      { path: "src/index.ts", content: "export const x = 1;" },
      { path: "package.json", content: JSON.stringify({ name: "test-repo" }) },
    ]);

    const stream = Readable.from(tarGzBuffer);

    const result = await extractRepositoryArchive({
      stream,
      candidatePaths: new Set(["src/index.ts", "package.json"]),
      limits: DEFAULT_LIMITS,
    });

    expect(result.files).toHaveLength(2);
    expect(result.files.map((f) => f.path)).toEqual(["package.json", "src/index.ts"]);
    expect(result.files.find((f) => f.path === "src/index.ts")?.content).toBe("export const x = 1;");
  });

  it("reports byte-level progress from 45 to 60 as chunks arrive", async () => {
    const tarGzBuffer = await createTarGzBuffer([
      { path: "src/index.ts", content: "export const x = 1;".repeat(500) },
      { path: "package.json", content: JSON.stringify({ name: "test-repo" }) },
    ]);

    const progressReports: number[] = [];
    const stream = Readable.from(tarGzBuffer);

    const result = await extractRepositoryArchive({
      stream,
      candidatePaths: new Set(["src/index.ts", "package.json"]),
      limits: DEFAULT_LIMITS,
      totalBytes: tarGzBuffer.length,
      onProgress: (p) => {
        progressReports.push(p.progress);
      },
    });

    expect(result.files).toHaveLength(2);
    expect(progressReports.length).toBeGreaterThan(0);
    expect(progressReports[0]).toBeGreaterThanOrEqual(45);
    expect(progressReports[progressReports.length - 1]).toBeLessThanOrEqual(60);
    expect(progressReports[progressReports.length - 1]).toBeGreaterThanOrEqual(55);
  });

  it("stream that errors mid-download: rejects promptly and does not hang or leak uncaught exceptions", async () => {
    const tarGzBuffer = await createTarGzBuffer([
      { path: "src/index.ts", content: "export const x = 1;" },
    ]);

    let pushed = false;
    const brokenStream = new Readable({
      read() {
        if (!pushed) {
          pushed = true;
          this.push(tarGzBuffer.subarray(0, 50));
          process.nextTick(() => {
            this.destroy(new Error("undici body timeout: connection reset by peer"));
          });
        }
      },
    });

    await expect(
      extractRepositoryArchive({
        stream: brokenStream,
        candidatePaths: new Set(["src/index.ts"]),
        limits: DEFAULT_LIMITS,
      }),
    ).rejects.toThrow();
  }, 3000);

  it("stream that stalls mid-download: watchdog rejects with ARCHIVE_DOWNLOAD_STALLED", async () => {
    const tarGzBuffer = await createTarGzBuffer([
      { path: "src/index.ts", content: "export const x = 1;" },
    ]);

    let pushed = false;
    const stalledStream = new Readable({
      read() {
        if (!pushed) {
          pushed = true;
          this.push(tarGzBuffer.subarray(0, 50));
          // Stall: no more pushes, does not end
        }
      },
    });

    const promise = extractRepositoryArchive({
      stream: stalledStream,
      candidatePaths: new Set(["src/index.ts"]),
      limits: DEFAULT_LIMITS,
      inactivityTimeoutMs: 50, // 50ms watchdog for test
    });

    await expect(promise).rejects.toMatchObject({
      code: "ARCHIVE_DOWNLOAD_STALLED",
      retryable: true,
    });
  }, 3000);

  it("overall budget deadline: rejects when remaining budget expires while stream is slow", async () => {
    const tarGzBuffer = await createTarGzBuffer([
      { path: "src/index.ts", content: "export const x = 1;" },
    ]);

    let offset = 0;
    const slowStream = new Readable({
      read() {
        if (offset < tarGzBuffer.length) {
          const chunk = tarGzBuffer.subarray(offset, offset + 10);
          offset += 10;
          setTimeout(() => {
            try {
              this.push(chunk);
            } catch {
              // ignore if destroyed
            }
          }, 25);
        }
      },
    });

    const budget = createAnalysisBudget(50); // 50ms budget

    const promise = extractRepositoryArchive({
      stream: slowStream,
      candidatePaths: new Set(["src/index.ts"]),
      limits: DEFAULT_LIMITS,
      budget,
      inactivityTimeoutMs: 150, // watchdog won't trigger
    });

    await expect(promise).rejects.toMatchObject({
      code: "ANALYSIS_TIMEOUT",
      retryable: true,
    });
  }, 3000);
});
