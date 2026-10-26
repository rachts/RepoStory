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

export interface AnalysisJobRunnerOptions {
  maxConcurrentJobs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

function safeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) {
    console.error("[RepoStory] unexpected analysis error", error);
    return new AppError({ code: "ANALYSIS_FAILED", message: "The analysis encountered an unexpected server error. Please retry. If it continues, check the server logs.", retryable: true });
  }
  console.error("[RepoStory] unexpected analysis failure", error);
  return new AppError({ code: "ANALYSIS_FAILED", message: "The analysis encountered an unexpected server error. Please retry. If it continues, check the server logs.", retryable: true });
}

function repositoryReference(job: AnalysisJobRecord): RepositoryReference {
  const url = new URL(job.repositoryUrl);
  return { owner: decodeURIComponent(url.pathname.split("/")[1] ?? ""), name: decodeURIComponent(url.pathname.split("/")[2] ?? ""), url: job.repositoryUrl, ...(job.requestedBranch && job.requestedBranch !== "default" ? { branch: job.requestedBranch } : {}) };
}

function progressFor(result: { stage: string; progress: number; message: string }): { status: AnalysisJobRecord["status"]; stage: AnalysisJobRecord["stage"]; progress: number; message: string } {
  const stage = result.stage === "fetching-metadata" ? "fetching-metadata" : result.stage === "fetching-files" ? "fetching-content" : result.stage === "filtering-files" ? "analyzing-repository" : result.stage === "analyzing" ? "analyzing-repository" : result.stage === "generating-diagrams" ? "analyzing-repository" : "storing-result";
  const status: AnalysisJobRecord["status"] = stage === "fetching-metadata" || stage === "fetching-content" ? "fetching" : "analyzing";
  return { status, stage, progress: result.progress, message: result.message };
}

export class AnalysisJobRunner {
  private readonly queued = new Set<string>();
  private readonly running = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly options: Required<AnalysisJobRunnerOptions>;
  private drainScheduled = false;

  public constructor(private readonly repository: AnalysisJobRepository, private readonly provider: RepositoryProvider, options: AnalysisJobRunnerOptions = {}) {
    this.options = {
      maxConcurrentJobs: options.maxConcurrentJobs ?? serverConfig.maxConcurrentJobs,
      maxRetries: options.maxRetries ?? serverConfig.maxJobRetries,
      retryBackoffMs: options.retryBackoffMs ?? serverConfig.jobRetryBackoffMs,
      sleep: options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
      now: options.now ?? Date.now,
    };
  }

  public enqueue(jobId: string): void {
    if (this.running.has(jobId) || this.queued.has(jobId)) return;
    this.queued.add(jobId);
    this.scheduleDrain();
  }

  public async runNow(jobId: string): Promise<void> {
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
    return this.repository.updateJob(jobId, { status: "cancelled", stage: "completed", progress: 100, message: "Cancellation requested.", cancellationRequested: true, updatedAt: nowIso(), error: { code: "CANCELLED", message: "The analysis was cancelled.", retryable: false } }, ownerId);
  }

  public async retry(jobId: string, ownerId?: string): Promise<AnalysisJobRecord | undefined> {
    const job = await this.repository.getJob(jobId, ownerId);
    if (!job || job.status !== "failed" || !job.error?.retryable || job.retryCount >= this.options.maxRetries) return undefined;
    const retried = await this.repository.updateJob(jobId, { status: "queued", stage: "validating-input", progress: 0, message: "Retry queued.", retryCount: job.retryCount + 1, cancellationRequested: false, error: undefined, updatedAt: nowIso() }, ownerId);
    if (retried) this.enqueue(jobId);
    return retried;
  }

  public async waitForIdle(): Promise<void> {
    while (this.queued.size || this.running.size) await this.options.sleep(0);
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    while (this.running.size < this.options.maxConcurrentJobs && this.queued.size) {
      const jobId = this.queued.values().next().value as string | undefined;
      if (!jobId) break;
      this.queued.delete(jobId);
      void this.runWithSlot(jobId).finally(() => this.scheduleDrain());
    }
  }

  private async runWithSlot(jobId: string): Promise<void> {
    this.running.add(jobId);
    try {
      await this.execute(jobId);
    } finally {
      this.running.delete(jobId);
      this.controllers.delete(jobId);
    }
  }

  private async execute(jobId: string): Promise<void> {
    const initial = await this.repository.getJob(jobId);
    if (!initial || initial.status === "cancelled" || initial.status === "expired") return;
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    let retryCount = initial.retryCount;

    while (true) {
      const current = await this.repository.getJob(jobId);
      if (!current || current.status === "cancelled" || current.cancellationRequested) return;
      const analysisId = current.analysisId ?? opaqueId("analysis");
      await this.repository.updateJob(jobId, { analysisId, status: "fetching", stage: "fetching-metadata", progress: 8, message: "Starting repository analysis.", updatedAt: nowIso() });
      const scratchStore = new InMemoryAnalysisStore({ maxAnalyses: 2, ttlMs: DEFAULT_LIMITS.maxAnalysisMs * 4 });
      const result = await runAnalysis(repositoryReference(current), this.provider, scratchStore, {
        analysisId,
        signal: controller.signal,
        onProgress: (progress) => {
          const mapped = progressFor(progress);
          void this.repository.updateJob(jobId, { ...mapped, analysisId, updatedAt: nowIso() });
        },
      });

      if (controller.signal.aborted || (await this.repository.getJob(jobId))?.cancellationRequested) {
        await this.repository.updateJob(jobId, { status: "cancelled", stage: "completed", progress: 100, message: "The analysis was cancelled.", error: { code: "CANCELLED", message: "The analysis was cancelled.", retryable: false }, updatedAt: nowIso() });
        return;
      }

      if (!result.ok) {
        const error = safeError(result.error);
        if (error.retryable && retryCount < this.options.maxRetries) {
          retryCount += 1;
          await this.repository.updateJob(jobId, { retryCount, status: "queued", stage: "validating-input", progress: 0, message: "A temporary provider failure occurred. Retrying…", error: { code: error.code, message: error.message, retryable: true }, updatedAt: nowIso() });
          await this.options.sleep(this.options.retryBackoffMs * 2 ** (retryCount - 1));
          continue;
        }
        await this.repository.updateJob(jobId, { status: "failed", stage: "completed", progress: 100, message: "The repository analysis failed.", error: { code: error.code, message: error.message, retryable: error.retryable, details: error.details }, updatedAt: nowIso() });
        return;
      }

      const analysisResult: AnalysisResult = result.value;
      await this.repository.updateJob(jobId, { analysisId, status: "analyzing", stage: "storing-result", progress: 92, message: "Saving the deterministic analysis result.", coverage: analysisResult.coverage, updatedAt: nowIso() });
      const persisted = await this.repository.saveAnalysisResult(analysisResult, current.ownerId);
      if (!persisted) return;
      for (const diagram of analysisResult.diagrams ?? scratchStore.listDiagrams(analysisId)) await this.repository.saveAnalysisDiagram(diagram, current.ownerId);

      if (current.explanationRequested) await this.generateExplanation(jobId, current.ownerId, analysisResult);
      const finalJob = await this.repository.getJob(jobId, current.ownerId);
      if (!finalJob || finalJob.status === "cancelled" || finalJob.cancellationRequested) return;
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
