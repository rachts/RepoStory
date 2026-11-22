import { describe, expect, it, vi } from "vitest";
import { GitHubPublicRepositoryProvider } from "@/infrastructure/providers/github-provider";
import { createAnalysisBudget } from "@/shared/limits";
import { AppError } from "@/domain/errors";

describe("Fix 11: GitHub Rate Limit Backoff & Fail Fast", () => {
  it("removes the 100ms cap and backs off with full retry-after duration and jitter when budget permits", async () => {
    let callCount = 0;
    const recordedSleepDurations: number[] = [];

    const mockFetch = vi.fn().mockImplementation(async (url: string | URL) => {
      callCount++;
      const urlStr = url.toString();

      // Return metadata
      if (urlStr.includes("/commits/")) {
        return new Response(JSON.stringify({ sha: "c1", commit: { message: "init" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (urlStr.includes("/git/trees/")) {
        return new Response(JSON.stringify({ sha: "t1", tree: [], truncated: false }), { status: 200, headers: { "content-type": "application/json" } });
      }

      // First attempt for repo metadata returns 429 with retry-after: 5
      if (callCount === 1) {
        return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 429,
          headers: {
            "retry-after": "5",
            "content-type": "application/json",
          },
        });
      }

      // Subsequent attempt succeeds
      return new Response(
        JSON.stringify({
          id: 1,
          name: "test-repo",
          owner: { login: "test-owner" },
          default_branch: "main",
          size: 10,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const mockSleep = vi.fn().mockImplementation(async (ms: number) => {
      recordedSleepDurations.push(ms);
    });

    const provider = new GitHubPublicRepositoryProvider({
      fetchImpl: mockFetch as unknown as typeof fetch,
      sleep: mockSleep,
    });

    // Budget has 60 seconds (60,000ms), which is plenty for 5s backoff
    const budget = createAnalysisBudget(60_000);

    const snapshot = await provider.getSnapshot(
      { owner: "test-owner", name: "test-repo", url: "https://github.com/test-owner/test-repo" },
      undefined,
      budget,
    );

    expect(snapshot.ok).toBe(true);
    // Verified: sleep was called
    expect(mockSleep).toHaveBeenCalledTimes(1);
    expect(recordedSleepDurations).toHaveLength(1);

    const sleepMs = recordedSleepDurations[0]!;
    // CRITICAL: Must be >= 5000ms (5s base) and <= 5600ms (base + jitter), proving Math.min(..., 100) is GONE
    expect(sleepMs).toBeGreaterThanOrEqual(5000);
    expect(sleepMs).toBeLessThanOrEqual(5600);
  });

  it("fails fast with retryable GITHUB_RATE_LIMITED when retry-after exceeds remaining budget", async () => {
    let callCount = 0;
    const mockSleep = vi.fn().mockResolvedValue(undefined);

    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return new Response(JSON.stringify({ message: "Rate limit exceeded" }), {
        status: 429,
        headers: {
          "retry-after": "30", // 30 seconds
          "content-type": "application/json",
        },
      });
    });

    const provider = new GitHubPublicRepositoryProvider({
      fetchImpl: mockFetch as unknown as typeof fetch,
      sleep: mockSleep,
    });

    // Budget has ONLY 10 seconds (10,000ms), whereas backoff is ~30 seconds (30,000ms)
    const budget = createAnalysisBudget(10_000);

    let thrownError: AppError | undefined;
    try {
      const result = await provider.getSnapshot(
        { owner: "test-owner", name: "test-repo", url: "https://github.com/test-owner/test-repo" },
        undefined,
        budget,
      );
      if (!result.ok) thrownError = result.error;
    } catch (err) {
      if (err instanceof AppError) thrownError = err;
    }

    // Must fail fast without sleeping!
    expect(mockSleep).not.toHaveBeenCalled();
    expect(thrownError).toBeDefined();
    expect(thrownError?.code).toBe("GITHUB_RATE_LIMITED");
    expect(thrownError?.retryable).toBe(true);
    expect(thrownError?.details?.retryAfterSeconds).toBeGreaterThanOrEqual(30);
  });

  it("aborts sleep immediately when fetchOptions.signal fires during rate-limit backoff", async () => {
    const controller = new AbortController();

    const mockFetch = vi.fn().mockImplementation(async () => {
      return new Response(JSON.stringify({ message: "Rate limit exceeded" }), {
        status: 429,
        headers: {
          "retry-after": "5",
          "content-type": "application/json",
        },
      });
    });

    // In this test, do NOT inject mock sleep so the real signal-aware setTimeout in dispatch is tested
    const provider = new GitHubPublicRepositoryProvider({
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const budget = createAnalysisBudget(60_000);

    // Abort after 50ms (well before the 5000ms backoff)
    setTimeout(() => {
      controller.abort();
    }, 50);

    const promise = provider.getSnapshot(
      { owner: "test-owner", name: "test-repo", url: "https://github.com/test-owner/test-repo" },
      controller.signal,
      budget,
    );

    const startTime = Date.now();
    const result = await promise;
    const elapsed = Date.now() - startTime;
    expect(result.ok).toBe(false);
    // Aborted in ~50-200ms, did not sleep for 5000ms
    expect(elapsed).toBeLessThan(1500);
  });
});
