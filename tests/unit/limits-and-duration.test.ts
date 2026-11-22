import { describe, it, expect } from "vitest";
import { DEFAULT_LIMITS } from "@/shared/limits";
import { maxDuration } from "@/app/api/analyze/route";
import { ANALYSIS_ROUTE_MAX_DURATION_SECONDS } from "@/application/jobs/job-execution-mode";

describe("Execution Duration and Analysis Limits Headroom", () => {
  it("enforces maxAnalysisMs is strictly less than maxDuration with at least 5s headroom", () => {
    const maxDurationMs = maxDuration * 1000;
    const analysisLimitMs = DEFAULT_LIMITS.maxAnalysisMs;

    expect(ANALYSIS_ROUTE_MAX_DURATION_SECONDS).toBe(60);
    expect(maxDuration).toBe(60);
    expect(analysisLimitMs).toBeLessThanOrEqual(50_000);

    const headroomMs = maxDurationMs - analysisLimitMs;
    // Must have at least 5 seconds (5,000 ms) of headroom before Vercel serverless timeout
    expect(headroomMs).toBeGreaterThanOrEqual(5_000);
  });
});
