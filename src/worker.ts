import { loadEnvConfig } from "@next/env";
// Load .env and .env.local if running outside Next.js
loadEnvConfig(process.cwd());

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

const workerId = process.env.WORKER_ID || `worker-${process.pid}`;
logger.info({ workerId }, `[RepoStory Worker] Starting worker ${workerId}...`);

const activeJobIds = new Set<string>();
let isCrashing = false;

async function handleFatalCrash(type: string, error: unknown): Promise<void> {
  if (isCrashing) return;
  isCrashing = true;
  console.error(`[RepoStory Worker] Fatal ${type}:`, error);

  for (const jobId of activeJobIds) {
    try {
      const crashMessage = `Worker crashed unexpectedly (${type}): ${error instanceof Error ? error.message : String(error)}`;
      await analysisRepository.updateJob(jobId, {
        status: "failed",
        stage: "completed",
        progress: 100,
        message: crashMessage,
        error: {
          code: "WORKER_CRASHED",
          stage: "analyze",
          reason: crashMessage,
          hint: "The worker crashed. Retrying the analysis may succeed.",
          message: crashMessage,
          retryable: true,
          details: error instanceof Error ? { name: error.name, ...(error.stack ? { stack: error.stack } : {}) } : undefined,
        },
        updatedAt: new Date().toISOString(),
      });
      await jobQueue.fail(jobId, workerId, {
        code: "WORKER_CRASHED",
        stage: "analyze",
        reason: crashMessage,
        hint: "The worker crashed. Retrying the analysis may succeed.",
        message: crashMessage,
        retryable: true,
      });
    } catch (cleanupErr) {
      console.error(`[RepoStory Worker] Failed to update job ${jobId} during fatal crash:`, cleanupErr);
    }
  }

  process.exit(1);
}

// Process-level guards against silent termination: log, fail active jobs, and exit non-zero for orchestrator restart
process.on("unhandledRejection", (reason) => {
  void handleFatalCrash("unhandledRejection", reason);
});

process.on("uncaughtException", (error) => {
  void handleFatalCrash("uncaughtException", error);
});

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
  activeJobIds.add(item.jobId);
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
          stage: "analyze",
          reason: failureMessage,
          hint: "Check worker logs for unhandled exception or crash details.",
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
        stage: "analyze",
        reason: failureMessage,
        hint: "Check worker logs for unhandled exception or crash details.",
        message: failureMessage,
        retryable: false,
      });
    } catch (queueErr) {
      console.error(`[Worker] Failed to mark job ${item.jobId} as failed in queue:`, queueErr);
    }
  } finally {
    activeJobIds.delete(item.jobId);
  }
}

const worker = new JobWorker(jobQueue, analysisRepository, analysisJobRunner, {
  workerId,
  pollIntervalMs,
  heartbeatIntervalMs,
  concurrency,
  processJob,
});

async function startupSweep(): Promise<void> {
  console.log(`[RepoStory Worker ${workerId}] Running startup sweep for orphaned or stuck jobs...`);
  try {
    if (analysisRepository.recoverStuckJobs) {
      const recovered = await analysisRepository.recoverStuckJobs();
      if (recovered.length > 0) {
        console.log(`[RepoStory Worker ${workerId}] Recovered ${recovered.length} stuck jobs during startup sweep.`);
        for (const job of recovered) {
          try {
            const queueItem = await jobQueue.get(job.jobId);
            if (queueItem && queueItem.status === "running") {
              await jobQueue.fail(job.jobId, queueItem.workerId ?? workerId, {
                code: "JOB_STALLED",
                stage: "analyze",
                message: "Analysis worker stopped responding",
                retryable: true,
              });
            }
          } catch { /* ignore */ }
        }
      }
    }
  } catch (err) {
    console.error(`[RepoStory Worker ${workerId}] Startup sweep failed:`, err);
  }
}

void startupSweep();
worker.start();

const shutdown = async (signal: string) => {
  logger.info({ workerId, signal }, `[RepoStory Worker] Received ${signal}. Shutting down gracefully...`);
  healthServer.close();
  await worker.stop();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
