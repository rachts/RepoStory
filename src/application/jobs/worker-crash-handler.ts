import type { AnalysisJobRepository } from "@/application/jobs/analysis-job-repository";
import type { JobQueue } from "@/application/jobs/job-queue";

export const activeJobIds = new Set<string>();
let isCrashing = false;

export function resetCrashStateForTesting(): void {
  isCrashing = false;
  activeJobIds.clear();
}

export async function failActiveJobsOnCrash(
  type: string,
  error: unknown,
  repository: AnalysisJobRepository,
  queue: JobQueue,
  currentWorkerId: string,
  exitFn: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
  if (isCrashing) return;
  isCrashing = true;
  console.error(`[RepoStory Worker] Fatal ${type}:`, error);

  for (const jobId of activeJobIds) {
    try {
      const crashDetails = error instanceof Error ? error.message : String(error);
      const crashReason = `Worker crashed unexpectedly (${type}): ${crashDetails}`;
      await repository.updateJob(jobId, {
        status: "failed",
        stage: "completed",
        progress: 100,
        message: "Analysis worker stopped responding",
        error: {
          code: "JOB_STALLED",
          stage: "analyze",
          reason: crashReason,
          hint: "The worker crashed or stopped responding. Retrying the analysis may succeed.",
          message: "Analysis worker stopped responding",
          retryable: true,
          details: error instanceof Error ? { name: error.name, ...(error.stack ? { stack: error.stack } : {}) } : undefined,
        },
        updatedAt: new Date().toISOString(),
      });
      await queue.fail(jobId, currentWorkerId, {
        code: "JOB_STALLED",
        stage: "analyze",
        reason: crashReason,
        hint: "The worker crashed or stopped responding. Retrying the analysis may succeed.",
        message: "Analysis worker stopped responding",
        retryable: true,
      });
    } catch (cleanupErr) {
      console.error(`[RepoStory Worker] Failed to update job ${jobId} during fatal crash:`, cleanupErr);
    }
  }

  exitFn(1);
}
