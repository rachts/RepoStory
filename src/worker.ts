// Register module alias resolution before importing @/... modules
require("./shared/alias-register");

import { jobQueue, analysisRepository, analysisJobRunner } from "@/composition/container";
import { JobWorker } from "@/application/jobs/job-worker";
import { logger } from "@/shared/logger";
import { initSentry } from "@/shared/sentry";

initSentry();

const workerId = process.env.WORKER_ID || `worker-${process.pid}`;
logger.info({ workerId }, `[RepoStory Worker] Starting worker ${workerId}...`);

const pollIntervalMs = process.env.WORKER_POLL_INTERVAL_MS ? Number(process.env.WORKER_POLL_INTERVAL_MS) : 1_000;
const heartbeatIntervalMs = process.env.WORKER_HEARTBEAT_INTERVAL_MS ? Number(process.env.WORKER_HEARTBEAT_INTERVAL_MS) : 15_000;
const concurrency = process.env.WORKER_CONCURRENCY ? Number(process.env.WORKER_CONCURRENCY) : 2;

const worker = new JobWorker(jobQueue, analysisRepository, analysisJobRunner, {
  workerId,
  pollIntervalMs,
  heartbeatIntervalMs,
  concurrency,
});

worker.start();

const shutdown = async (signal: string) => {
  logger.info({ workerId, signal }, `[RepoStory Worker] Received ${signal}. Shutting down gracefully...`);
  await worker.stop();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
