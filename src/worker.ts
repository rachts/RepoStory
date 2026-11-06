import { jobQueue, analysisRepository, analysisJobRunner } from "@/composition/container";
import { JobWorker } from "@/application/jobs/job-worker";
import { logger } from "@/shared/logger";
import { initSentry } from "@/shared/sentry";

initSentry();

const workerId = process.env.WORKER_ID || `worker-${process.pid}`;
logger.info({ workerId }, `[RepoStory Worker] Starting worker ${workerId}...`);

const worker = new JobWorker(jobQueue, analysisRepository, analysisJobRunner, {
  workerId,
  pollIntervalMs: 1_000,
  heartbeatIntervalMs: 15_000,
  concurrency: 2,
});

worker.start();

const shutdown = async (signal: string) => {
  logger.info({ workerId, signal }, `[RepoStory Worker] Received ${signal}. Shutting down gracefully...`);
  await worker.stop();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
