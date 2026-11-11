import http from "node:http";

// Register module alias resolution before importing @/... modules
import "./shared/alias-register";

// Dummy health-check HTTP server for platforms (like Render Web Services) that scan for an open port
const port = process.env.PORT || 10000;
const healthServer = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "healthy" }));
});

healthServer.on("error", (err) => {
  console.error(`[RepoStory Worker] Health check server error:`, err);
});

healthServer.listen(port, () => {
  console.log(`Health check server listening on port ${port}`);
});

import { assertProductionGuards } from "@/config/production-guards";

assertProductionGuards();

import { jobQueue, analysisRepository, analysisJobRunner } from "@/composition/container";
import { JobWorker } from "@/application/jobs/job-worker";
import type { JobQueueItem } from "@/application/jobs/job-queue";
import { logger } from "@/shared/logger";
import { initSentry } from "@/shared/sentry";

initSentry();

// Process-level guards against silent termination
process.on("unhandledRejection", (reason) => {
  console.error("[RepoStory Worker] Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[RepoStory Worker] Uncaught exception:", error);
});

const workerId = process.env.WORKER_ID || `worker-${process.pid}`;
logger.info({ workerId }, `[RepoStory Worker] Starting worker ${workerId}...`);

const pollIntervalMs = process.env.WORKER_POLL_INTERVAL_MS ? Number(process.env.WORKER_POLL_INTERVAL_MS) : 1_000;
const heartbeatIntervalMs = process.env.WORKER_HEARTBEAT_INTERVAL_MS ? Number(process.env.WORKER_HEARTBEAT_INTERVAL_MS) : 15_000;
const concurrency = process.env.WORKER_CONCURRENCY ? Number(process.env.WORKER_CONCURRENCY) : 2;

/**
 * Main job processing handler with comprehensive error handling.
 * Wrapped in a top-level try/catch block so that unexpected crashes
 * during validation or execution are caught, logged with full stack traces,
 * marked as failed in the Supabase analysis_jobs table, and the worker
 * continues polling without silently crashing.
 */
export async function processJob(item: JobQueueItem): Promise<void> {
  console.log(`[Worker] Starting validation for job ${item.jobId}`);
  try {
    await analysisJobRunner.runNow(item.jobId);
    console.log(`[Worker] Validation complete for job ${item.jobId}`);

    const finalJob = await analysisRepository.getJob(item.jobId);
    if (finalJob?.status === "completed") {
      await jobQueue.complete(item.jobId, workerId);
    } else if (finalJob?.status === "cancelled") {
      await jobQueue.cancel(item.jobId);
    } else if (finalJob?.status === "failed") {
      const error = finalJob.error ?? {
        code: "ANALYSIS_FAILED",
        message: finalJob.message || "Analysis failed.",
        retryable: false,
      };
      await jobQueue.fail(item.jobId, workerId, error);
    } else {
      await jobQueue.complete(item.jobId, workerId);
    }
  } catch (error) {
    console.error(`[Worker] Fatal error processing job ${item.jobId}:`, error);
    if (error instanceof Error && error.stack) {
      console.error(`[Worker] Stack trace for job ${item.jobId}:\n${error.stack}`);
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    const failureMessage = `Worker crashed during validation: ${errorMessage}`;

    try {
      await analysisRepository.updateJob(item.jobId, {
        status: "failed",
        stage: "completed",
        progress: 100,
        message: failureMessage,
        error: {
          code: "WORKER_CRASHED",
          message: failureMessage,
          retryable: false,
          details: error instanceof Error ? { name: error.name, ...(error.stack ? { stack: error.stack } : {}) } : undefined,
        },
        updatedAt: new Date().toISOString(),
      });
      console.log(`[Worker] Updated job ${item.jobId} to failed in database with message: "${failureMessage}"`);
    } catch (repoErr) {
      console.error(`[Worker] Failed to update job ${item.jobId} in repository:`, repoErr);
    }

    try {
      await jobQueue.fail(item.jobId, workerId, {
        code: "WORKER_CRASHED",
        message: failureMessage,
        retryable: false,
      });
    } catch (queueErr) {
      console.error(`[Worker] Failed to mark job ${item.jobId} as failed in queue:`, queueErr);
    }
  }
}

const worker = new JobWorker(jobQueue, analysisRepository, analysisJobRunner, {
  workerId,
  pollIntervalMs,
  heartbeatIntervalMs,
  concurrency,
  processJob,
});

worker.start();

const shutdown = async (signal: string) => {
  logger.info({ workerId, signal }, `[RepoStory Worker] Received ${signal}. Shutting down gracefully...`);
  healthServer.close();
  await worker.stop();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
