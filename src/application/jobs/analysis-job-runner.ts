import type { AnalysisJobRecord, AnalysisResult } from "@/domain/analysis";
import { AppError } from "@/domain/errors";
import type { RepositoryProvider, RepositoryReference } from "@/domain/repository";
import { runAnalysis } from "@/application/pipeline";
import { InMemoryAnalysisStore } from "@/application/store";
import type { AnalysisJobRepository } from "@/application/jobs/analysis-job-repository";
import { buildExplanationInput, collectExplanationEvidenceIds } from "@/application/ai/build-explanation-input";
import { unknownExplanationEvidenceIds } from "@/domain/ai-explanation";
import { nowIso, opaqueId } from "@/shared/ids";
import { serverConfig } from "@/shared/config";
import { DEFAULT_LIMITS } from "@/shared/limits";

import { jobTokenRegistry, decryptToken, type EncryptedTokenPayload } from "@/infrastructure/jobs/job-token-registry";
export { jobTokenRegistry };

export interface AnalysisJobRunnerOptions {
  maxConcurrentJobs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  analysisTimeoutMs?: number;
}

function safeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) {
    console.error("[RepoStory] unexpected analysis error", error);
    return new AppError({
      code: "ANALYSIS_FAILED",
      stage: "analyze",
      message: "The analysis encountered an unexpected server error. Please retry. If it continues, check the server logs.",
      reason: `Unexpected analysis failure: ${error.message}`,
      hint: "Check server logs or retry the request.",
      retryable: true,
    });
  }
  console.error("[RepoStory] unexpected analysis failure", error);
  return new AppError({
    code: "ANALYSIS_FAILED",
    stage: "analyze",
    message: "The analysis encountered an unexpected server error. Please retry. If it continues, check the server logs.",
    reason: "Unexpected analysis failure.",
    hint: "Check server logs or retry the request.",
    retryable: true,
  });
}

function repositoryReference(job: AnalysisJobRecord): RepositoryReference {
  const url = new URL(job.repositoryUrl);
  return { owner: decodeURIComponent(url.pathname.split("/")[1] ?? ""), name: decodeURIComponent(url.pathname.split("/")[2] ?? ""), url: job.repositoryUrl, ...(job.requestedBranch && job.requestedBranch !== "default" ? { branch: job.requestedBranch } : {}) };
}

function progressFor(result: { stage: string; progress: number; message: string }): { status: AnalysisJobRecord["status"]; stage: AnalysisJobRecord["stage"]; progress: number; message: string } {
  let stage: AnalysisJobRecord["stage"] = "analyzing-repository";
  let status: AnalysisJobRecord["status"] = "analyzing";

  if (result.stage === "fetch-metadata" || result.stage === "fetching-metadata") {
    stage = "fetch-metadata";
    status = "fetching";
  } else if (result.stage === "fetch-tree" || result.stage === "fetching-tree") {
    stage = "fetch-tree";
    status = "fetching";
  } else if (result.stage === "fetch-archive" || result.stage === "fetching-content" || result.stage === "fetching-files") {
    stage = "fetch-archive";
    status = "fetching";
  } else if (result.stage === "analyze" || result.stage === "analyzing" || result.stage === "filtering-files") {
    stage = "analyze";
    status = "analyzing";
  } else if (result.stage === "generate-diagrams" || result.stage === "generating-diagrams") {
    stage = "generate-diagrams";
    status = "analyzing";
  } else if (result.stage === "completed") {
    stage = "completed";
    status = "completed";
  }
  return { status, stage, progress: result.progress, message: result.message };
}

export class AnalysisJobRunner {
  private readonly queued = new Set<string>();
  private readonly running = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly options: Required<AnalysisJobRunnerOptions>;
  private drainScheduled = false;

  private notifyIfIdle(): void {
    if (this.queued.size === 0 && this.running.size === 0) {
      for (const waiter of this.idleWaiters) {
        waiter();
      }
      this.idleWaiters.clear();
    }
  }

  public constructor(private readonly repository: AnalysisJobRepository, private readonly provider: RepositoryProvider, options: AnalysisJobRunnerOptions = {}) {
    this.options = {
      maxConcurrentJobs: options.maxConcurrentJobs ?? serverConfig.maxConcurrentJobs,
      maxRetries: options.maxRetries ?? serverConfig.maxJobRetries,
      retryBackoffMs: options.retryBackoffMs ?? serverConfig.jobRetryBackoffMs,
      sleep: options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
      now: options.now ?? Date.now,
      analysisTimeoutMs: options.analysisTimeoutMs ?? DEFAULT_LIMITS.maxAnalysisMs,
    };
  }

  public enqueue(jobId: string, options?: { token?: string }): void {
    if (options?.token) {
      jobTokenRegistry.set(jobId, { token: options.token, expiresAt: Date.now() + 15 * 60 * 1000 });
    }
    if (this.running.has(jobId) || this.queued.has(jobId)) return;
    this.queued.add(jobId);
    this.scheduleDrain();
  }

  public async runNow(jobId: string, options?: { token?: string }): Promise<void> {
    if (options?.token) {
      jobTokenRegistry.set(jobId, { token: options.token, expiresAt: Date.now() + 15 * 60 * 1000 });
    }
    if (this.running.has(jobId)) return;
    this.queued.delete(jobId);
    await this.runWithSlot(jobId);
  }

  public async cancel(jobId: string, ownerId?: string): Promise<AnalysisJobRecord | undefined> {
    const job = await this.repository.getJob(jobId, ownerId);
    if (!job) return undefined;
    if (job.status === "completed" || job.status === "failed" || job.status === "expired" || job.status === "cancelled") return job;
    this.controllers.get(jobId)?.abort();
    this.queued.delete(jobId);
    this.notifyIfIdle();
    jobTokenRegistry.delete(jobId);
    return this.repository.updateJob(jobId, {
      status: "cancelled",
      stage: "completed",
      progress: 100,
      message: "Cancellation requested.",
      cancellationRequested: true,
      updatedAt: nowIso(),
      error: {
        code: "CANCELLED",
        stage: "analyze",
        reason: "The analysis was cancelled by the user.",
        hint: "You can retry the analysis at any time.",
        message: "The analysis was cancelled.",
        retryable: false,
      },
    }, ownerId);
  }

  public async retry(jobId: string, ownerId?: string): Promise<AnalysisJobRecord | undefined> {
    const job = await this.repository.getJob(jobId, ownerId);
    if (!job || job.status !== "failed" || !job.error?.retryable || job.retryCount >= this.options.maxRetries) return undefined;
    this.controllers.get(jobId)?.abort();
    this.controllers.delete(jobId);
    this.running.delete(jobId);
    const retried = await this.repository.updateJob(jobId, { status: "queued", stage: "validating-input", progress: 0, message: "Retry queued.", retryCount: job.retryCount + 1, cancellationRequested: false, error: undefined, updatedAt: nowIso() }, ownerId);
    if (retried) this.enqueue(jobId);
    return retried;
  }

  public async waitForIdle(): Promise<void> {
    if (this.queued.size === 0 && this.running.size === 0) return;
    return new Promise<void>((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      void this.drain().catch(() => {});
    });
  }

  private async drain(): Promise<void> {
    while (this.running.size < this.options.maxConcurrentJobs && this.queued.size) {
      const jobId = this.queued.values().next().value as string | undefined;
      if (!jobId) break;
      this.queued.delete(jobId);
      void this.runWithSlot(jobId).catch(() => {}).finally(() => this.scheduleDrain());
    }
    this.notifyIfIdle();
  }

  private async runWithSlot(jobId: string): Promise<void> {
    this.running.add(jobId);
    try {
      await this.execute(jobId);
    } finally {
      this.running.delete(jobId);
      this.controllers.delete(jobId);
      this.notifyIfIdle();
    }
  }

  private async execute(jobId: string): Promise<void> {
    console.log(`[Worker] Starting validation for job ${jobId}`);
    const initial = await this.repository.getJob(jobId);
    if (!initial || initial.status === "completed" || initial.status === "cancelled" || initial.status === "expired" || initial.status === "failed") {
      console.log(`[Worker] Job ${jobId} not found, already completed, cancelled, expired, or failed.`);
      return;
    }
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    let retryCount = initial.retryCount;

    let registered = jobTokenRegistry.get(jobId);
    if (!registered && this.provider.cacheStore) {
      try {
        const encrypted = await this.provider.cacheStore.get<EncryptedTokenPayload>(`job-token:${jobId}`);
        if (encrypted) {
          const decrypted = decryptToken(encrypted);
          jobTokenRegistry.set(jobId, { token: decrypted, expiresAt: Date.now() + 15 * 60 * 1000 });
          registered = jobTokenRegistry.get(jobId);
        }
      } catch { /* ignore */ }
    }
    let token = registered?.token;
    if (registered && registered.expiresAt < Date.now()) {
      jobTokenRegistry.delete(jobId);
      token = undefined;
    }

    while (true) {
      const current = await this.repository.getJob(jobId);
      if (!current || current.status === "completed" || current.status === "failed" || current.status === "cancelled" || current.cancellationRequested) {
        jobTokenRegistry.delete(jobId);
        return;
      }
      const analysisId = current.analysisId ?? opaqueId("analysis");
      console.log(`[Worker] Validation complete for job ${jobId}`);
      await this.repository.updateJob(jobId, { analysisId, status: "fetching", stage: "fetching-metadata", progress: 8, message: "Starting repository analysis.", heartbeatAt: nowIso(), updatedAt: nowIso() });
      if (process.env.REPO_STORY_TEST_JOB_DELAY_MS) {
        const delay = Number(process.env.REPO_STORY_TEST_JOB_DELAY_MS);
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
      const scratchStore = new InMemoryAnalysisStore({ maxAnalyses: 2, ttlMs: DEFAULT_LIMITS.maxAnalysisMs * 4, isScratch: true });
      const timeoutMs = this.options.analysisTimeoutMs ?? DEFAULT_LIMITS.maxAnalysisMs;
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combinedSignal = AbortSignal.any([controller.signal, timeoutSignal]);

      let heartbeatActive = true;
      const heartbeatTimer = setInterval(() => {
        if (!heartbeatActive) return;
        void this.repository.updateJob(jobId, { heartbeatAt: nowIso() }).catch(() => {});
      }, 15_000);

      let result;
      try {
        result = await runAnalysis(repositoryReference(current), this.provider, scratchStore, {
          analysisId,
          signal: combinedSignal,
          limits: { ...DEFAULT_LIMITS, maxAnalysisMs: timeoutMs },
          cacheStore: this.provider.cacheStore,
          token,
          onProgress: (progress) => {
            const mapped = progressFor(progress);
            void this.repository.updateJob(jobId, { ...mapped, analysisId, heartbeatAt: nowIso(), updatedAt: nowIso() }).catch(() => {});
          },
        });
      } finally {
        heartbeatActive = false;
        clearInterval(heartbeatTimer);
      }

      if (controller.signal.aborted || (await this.repository.getJob(jobId))?.cancellationRequested) {
        jobTokenRegistry.delete(jobId);
        await this.repository.updateJob(jobId, {
          status: "cancelled",
          stage: "completed",
          progress: 100,
          message: "The analysis was cancelled.",
          error: {
            code: "CANCELLED",
            stage: "analyze",
            reason: "The analysis was cancelled by the user.",
            hint: "You can retry the analysis at any time.",
            message: "The analysis was cancelled.",
            retryable: false,
          },
          updatedAt: nowIso(),
        });
        return;
      }

      if (!result.ok) {
        const error = safeError(result.error);
        const structuredError = {
          code: error.code,
          stage: error.stage,
          reason: error.reason,
          message: error.message,
          retryable: error.retryable ?? false,
          hint: error.hint,
          details: error.details,
        };
        if (error.retryable && retryCount < this.options.maxRetries) {
          retryCount += 1;
          await this.repository.updateJob(jobId, {
            retryCount,
            status: "queued",
            stage: "validating-input",
            progress: 0,
            message: "A temporary provider failure occurred. Retrying…",
            error: structuredError,
            updatedAt: nowIso(),
          });
          await this.options.sleep(this.options.retryBackoffMs * 2 ** (retryCount - 1));
          continue;
        }
        jobTokenRegistry.delete(jobId);
        await this.repository.updateJob(jobId, {
          status: "failed",
          stage: "completed",
          progress: 100,
          message: "The repository analysis failed.",
          error: structuredError,
          updatedAt: nowIso(),
        });
        return;
      }

      const analysisResult: AnalysisResult = {
        ...result.value,
        id: analysisId,
        diagrams: (result.value.diagrams ?? scratchStore.listDiagrams(analysisId)).map((d) => ({ ...d, analysisId })),
      };
      const preSaveJob = await this.repository.getJob(jobId, current.ownerId);
      if (!preSaveJob || preSaveJob.status === "failed" || preSaveJob.status === "cancelled" || preSaveJob.cancellationRequested) {
        jobTokenRegistry.delete(jobId);
        return;
      }

      await this.repository.updateJob(jobId, { analysisId, status: "analyzing", stage: "storing-result", progress: 92, message: "Saving the deterministic analysis result.", coverage: analysisResult.coverage, updatedAt: nowIso() });
      const persisted = await this.repository.saveAnalysisResult(analysisResult, current.ownerId);
      if (!persisted) {
        jobTokenRegistry.delete(jobId);
        return;
      }
      for (const diagram of analysisResult.diagrams ?? []) await this.repository.saveAnalysisDiagram(diagram, current.ownerId);

      if (current.explanationRequested) await this.generateExplanation(jobId, current.ownerId, analysisResult);
      const finalJob = await this.repository.getJob(jobId, current.ownerId);
      if (!finalJob || finalJob.status === "failed" || finalJob.status === "cancelled" || finalJob.cancellationRequested) {
        jobTokenRegistry.delete(jobId);
        return;
      }
      jobTokenRegistry.delete(jobId);
      await this.repository.updateJob(jobId, { analysisId, status: "completed", stage: "completed", progress: 100, message: "Analysis complete.", coverage: analysisResult.coverage, updatedAt: nowIso() }, current.ownerId);
      return;
    }
  }

  private async generateExplanation(jobId: string, ownerId: string, analysis: AnalysisResult): Promise<void> {
    await this.repository.updateJob(jobId, { status: "explaining", stage: "generating-explanation", progress: 94, message: "Generating the optional plain-English explanation.", updatedAt: nowIso() }, ownerId);
    try {
      const diagrams = await this.repository.listAnalysisDiagrams(analysis.id, ownerId);
      const input = buildExplanationInput(analysis, diagrams, serverConfig.groqMaxInputChars);
      const { generateProjectExplanation } = await import("@/infrastructure/ai/groq-client");
      const explanation = await generateProjectExplanation(input.serialized);
      const unknown = unknownExplanationEvidenceIds(explanation, collectExplanationEvidenceIds(input.payload));
      if (unknown.length) throw new AppError({ code: "AI_INVALID_RESPONSE", message: "The AI explanation referenced evidence that was not supplied by the analysis.", retryable: true });
      await this.repository.saveExplanation(analysis.id, explanation, ownerId);
    } catch (error) {
      const safe = safeError(error);
      await this.repository.saveExplanationUnavailable(analysis.id, { code: safe.code, message: safe.message }, ownerId);
    }
  }
}
