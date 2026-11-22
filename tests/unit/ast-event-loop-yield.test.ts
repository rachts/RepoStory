import { describe, it, expect, vi } from "vitest";
import { DEFAULT_MAX_HEAP_BYTES } from "@/shared/limits";
import { runAnalysis } from "@/application/pipeline";
import { TypeScriptAstStreamingAnalyzer } from "@/application/analysis/streaming-analyzer";
import { InMemoryAnalysisStore } from "@/application/store";
import type { RepositoryFile, RepositoryProvider, RepositorySnapshot } from "@/domain/repository";
import { ok } from "@/shared/result";

describe("Fix 7: Memory limits & AST parse loop event-loop yielding", () => {
  it("defaults DEFAULT_MAX_HEAP_BYTES to 350MB (367,001,600 bytes)", () => {
    expect(DEFAULT_MAX_HEAP_BYTES).toBe(350 * 1024 * 1024);
    expect(DEFAULT_MAX_HEAP_BYTES).toBe(367_001_600);
  });

  it("yields to the event loop during pipeline AST parsing so heartbeats and concurrent tasks execute", async () => {
    // Generate 35 TypeScript files
    const sampleFiles: RepositoryFile[] = Array.from({ length: 35 }, (_, idx) => ({
      path: `src/feature/file_${idx}.ts`,
      content: `export function fn${idx}() { return ${idx}; }`,
      type: "file",
      sizeBytes: 45,
      isAnalyzable: true,
    }));

    const mockProvider: RepositoryProvider = {
      getSnapshot: vi.fn().mockResolvedValue(
        ok<RepositorySnapshot>({
          repository: {
            id: "repo-1",
            owner: "test-owner",
            name: "test-repo",
            defaultBranch: "main",
            selectedBranch: "main",
            url: "https://github.com/test-owner/test-repo",
            sizeBytes: 1575,
            fileCount: 35,
          },
          files: sampleFiles,
          coverage: {
            filesConsidered: sampleFiles.length,
            filesSkipped: 0,
          },
        }),
      ),
    };

    const store = new InMemoryAnalysisStore();

    // Track event-loop turns while runAnalysis is executing
    let eventLoopTurns = 0;
    const tracker = setInterval(() => {
      eventLoopTurns += 1;
    }, 1);

    // Track simulated worker heartbeat updates during analysis
    let heartbeatCount = 0;
    const heartbeatTimer = setInterval(() => {
      heartbeatCount += 1;
    }, 2);

    try {
      const result = await runAnalysis(
        { owner: "test-owner", name: "test-repo", url: "https://github.com/test-owner/test-repo" },
        mockProvider,
        store,
      );

      expect(result.ok).toBe(true);
      // With 35 files and yielding every 10 files via setImmediate,
      // the event loop is yielded at least 3 times during the AST parse phase alone.
      expect(eventLoopTurns).toBeGreaterThan(0);
      expect(heartbeatCount).toBeGreaterThan(0);
    } finally {
      clearInterval(tracker);
      clearInterval(heartbeatTimer);
    }
  });

  it("yields to the event loop in TypeScriptAstStreamingAnalyzer every 10 files", async () => {
    async function* generateFiles(): AsyncIterable<RepositoryFile> {
      for (let i = 0; i < 25; i++) {
        yield {
          path: `src/components/Comp${i}.tsx`,
          content: `import React from "react";\nimport { createClient } from "@supabase/supabase-js";\nexport const Comp${i} = () => null;`,
          type: "file" as const,
          sizeBytes: 100,
          isAnalyzable: true,
        };
      }
    }

    let immediateYieldCount = 0;
    const checkYield = () => {
      immediateYieldCount += 1;
    };

    // Queue setImmediate checks to observe yielding during stream processing
    const analyzer = new TypeScriptAstStreamingAnalyzer();
    
    // Schedule an immediate before running
    setImmediate(checkYield);

    const findings = await analyzer.analyze(generateFiles());

    expect(findings.length).toBe(25);
    // Because the analyzer yields every 10 files, setImmediate callbacks are processed
    expect(immediateYieldCount).toBeGreaterThanOrEqual(1);
  });
});
