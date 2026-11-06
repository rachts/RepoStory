import type { JobQueue, JobQueueItem } from "@/application/jobs/job-queue";
import type { AnalysisJobRepository } from "@/application/jobs/analysis-job-repository";
import type { AnalysisJobRunner } from "@/application/jobs/analysis-job-runner";
import { opaqueId } from "@/shared/ids";

export interface JobWorkerOptions {
  workerId?: string;
  heartbeatIntervalMs?: number; // default: 15_000 (15 seconds)
  pollIntervalMs?: number; // default: 1_000 (1 second)
  concurrency?: number; // default: 1
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
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
    void this.processClaimed(claimed).finally(() => {
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
            void this.processClaimed(item).finally(() => {
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

  private async processClaimed(item: JobQueueItem): Promise<void> {
    let heartbeatActive = true;
    const heartbeatTimer = setInterval(() => {
      if (!heartbeatActive) return;
      void this.queue.heartbeat(item.jobId, this.workerId).catch(() => {});
    }, this.heartbeatIntervalMs);

    try {
      await this.runner.runNow(item.jobId);
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
    } catch (error) {
      const errObj = error instanceof Error
        ? { code: "UNEXPECTED_ERROR", message: error.message, retryable: true }
        : { code: "UNEXPECTED_ERROR", message: "Unexpected worker execution failure", retryable: true };
      await this.queue.fail(item.jobId, this.workerId, errObj);
    } finally {
      heartbeatActive = false;
      clearInterval(heartbeatTimer);
    }
  }
}
