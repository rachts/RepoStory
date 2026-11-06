import { jobQueue, analysisRepository, analysisJobRunner } from "@/composition/container";
import { JobWorker } from "@/application/jobs/job-worker";

const workerId = process.env.WORKER_ID || `worker-${process.pid}`;
console.log(`[RepoStory Worker] Starting worker ${workerId}...`);

const worker = new JobWorker(jobQueue, analysisRepository, analysisJobRunner, {
  workerId,
  pollIntervalMs: 1_000,
  heartbeatIntervalMs: 15_000,
  concurrency: 2,
});

worker.start();

const shutdown = async (signal: string) => {
  console.log(`[RepoStory Worker] Received ${signal}. Shutting down gracefully...`);
  await worker.stop();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
