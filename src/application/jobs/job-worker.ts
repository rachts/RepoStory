import type { JobQueue, JobQueueItem } from "@/application/jobs/job-queue";
import type { AnalysisJobRepository } from "@/application/jobs/analysis-job-repository";
import type { AnalysisJobRunner } from "@/application/jobs/analysis-job-runner";
import { opaqueId } from "@/shared/ids";
import { logger } from "@/shared/logger";

export interface JobWorkerOptions {
  workerId?: string;
  heartbeatIntervalMs?: number; // default: 15_000 (15 seconds)
  pollIntervalMs?: number; // default: 1_000 (1 second)
  concurrency?: number; // default: 1
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  processJob?: (item: JobQueueItem) => Promise<void>;
}

export class JobWorker {
  public readonly workerId: string;
  private readonly queue: JobQueue;
  private readonly repository: AnalysisJobRepository;
  private readonly runner: AnalysisJobRunner;
  private readonly heartbeatIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly concurrency: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly processJobHandler?: (item: JobQueueItem) => Promise<void>;
  private isRunning = false;
  private activeJobs = new Set<string>();
  private loopPromise?: Promise<void>;

  public constructor(
    queue: JobQueue,
    repository: AnalysisJobRepository,
    runner: AnalysisJobRunner,
    options: JobWorkerOptions = {},
  ) {
    this.queue = queue;
    this.repository = repository;
    this.runner = runner;
    this.workerId = options.workerId ?? `worker-${opaqueId("w")}`;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.concurrency = options.concurrency ?? 1;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.processJobHandler = options.processJob;
  }

  public get activeCount(): number {
    return this.activeJobs.size;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.loopPromise = this.pollLoop();
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    if (this.loopPromise) {
      await this.loopPromise;
    }
  }

  /**
   * Run one iteration: try to claim and execute one job if slots available.
   * Useful for deterministic testing or single-step processing.
   */
  public async tick(): Promise<JobQueueItem | undefined> {
    if (this.activeJobs.size >= this.concurrency) return undefined;
    const claimed = await this.queue.claim(this.workerId);
    if (!claimed) return undefined;

    this.activeJobs.add(claimed.jobId);
    void this.processJob(claimed).finally(() => {
      this.activeJobs.delete(claimed.jobId);
    });
    return claimed;
  }

  private async pollLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        if (this.activeJobs.size < this.concurrency) {
          const item = await this.queue.claim(this.workerId);
          if (item) {
            this.activeJobs.add(item.jobId);
            void this.processJob(item).finally(() => {
              this.activeJobs.delete(item.jobId);
            });
            continue;
          }
        }
      } catch (err) {
        console.error(`[Worker ${this.workerId}] error claiming job:`, err);
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  /**
   * Process a claimed queue job with comprehensive error handling.
   * Guarantees errors during validation or execution are caught, logged
   * with full stack traces, reported to the job repository, and the worker
   * continues polling.
   */
  public async processJob(item: JobQueueItem): Promise<void> {
    logger.info({
      event: "claimed",
      jobId: item.jobId,
      workerId: this.workerId,
      attempt: item.attempts,
    }, `[Worker ${this.workerId}] claimed job ${item.jobId} (attempt ${item.attempts})`);

    let heartbeatActive = true;
    const heartbeatTimer = setInterval(() => {
      if (!heartbeatActive) return;
      void this.queue.heartbeat(item.jobId, this.workerId).catch((err) => {
        console.error(`[Worker ${this.workerId}] Heartbeat ping failed for job ${item.jobId}:`, err);
      });
    }, this.heartbeatIntervalMs);

    try {
      if (this.processJobHandler) {
        await this.processJobHandler(item);
      } else {
        console.log(`[Worker] Starting validation for job ${item.jobId}`);
        await this.runner.runNow(item.jobId);
        console.log(`[Worker] Validation complete for job ${item.jobId}`);

        const finalJob = await this.repository.getJob(item.jobId);
        if (finalJob?.status === "completed") {
          await this.queue.complete(item.jobId, this.workerId);
        } else if (finalJob?.status === "cancelled") {
          await this.queue.cancel(item.jobId);
        } else if (finalJob?.status === "failed") {
          const error = finalJob.error ?? {
            code: "ANALYSIS_FAILED",
            message: finalJob.message || "Analysis failed.",
            retryable: false,
          };
          await this.queue.fail(item.jobId, this.workerId, error);
        } else {
          await this.queue.complete(item.jobId, this.workerId);
        }
      }
    } catch (error) {
      console.error(`[Worker ${this.workerId}] Fatal error processing job ${item.jobId}:`, error);
      if (error instanceof Error && error.stack) {
        console.error(`[Worker ${this.workerId}] Error stack trace:\n${error.stack}`);
      }

      const rawMessage = error instanceof Error ? error.message : String(error);
      const crashMessage = `Worker crashed during validation: ${rawMessage}`;

      try {
        await this.repository.updateJob(item.jobId, {
          status: "failed",
          stage: "completed",
          progress: 100,
          message: crashMessage,
          error: {
            code: "WORKER_CRASHED",
            message: crashMessage,
            retryable: false,
            details: error instanceof Error ? { name: error.name, ...(error.stack ? { stack: error.stack } : {}) } : undefined,
          },
          updatedAt: new Date().toISOString(),
        });
        console.log(`[Worker ${this.workerId}] Updated job ${item.jobId} to failed in repository: "${crashMessage}"`);
      } catch (repoErr) {
        console.error(`[Worker ${this.workerId}] Failed to update job ${item.jobId} status in repository:`, repoErr);
      }

      try {
        await this.queue.fail(item.jobId, this.workerId, {
          code: "WORKER_CRASHED",
          message: crashMessage,
          retryable: false,
        });
      } catch (queueErr) {
        console.error(`[Worker ${this.workerId}] Failed to mark queue item ${item.jobId} as failed:`, queueErr);
      }
    } finally {
      heartbeatActive = false;
      clearInterval(heartbeatTimer);
    }
  }
}
