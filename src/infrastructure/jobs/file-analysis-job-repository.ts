import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProjectExplanation } from "@/domain/ai-explanation";
import type { AnalysisJobRecord, AnalysisResult } from "@/domain/analysis";
import type { Diagram } from "@/domain/diagram";
import type { AnalysisJobPatch, AnalysisJobRepository, PersistedAnalysisRepositoryState } from "@/application/jobs/analysis-job-repository";
import { InMemoryAnalysisStore } from "@/application/store";
import { AppError } from "@/domain/errors";

/**
 * Single-process durable adapter. It persists redacted state atomically to a
 * local JSON file and is intentionally replaceable by a database adapter later.
 */
export class FileAnalysisJobRepository implements AnalysisJobRepository {
  private readonly delegate: InMemoryAnalysisStore;
  private readonly filePath: string;
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(options: { filePath: string; maxAnalyses?: number; ttlMs?: number }) {
    this.filePath = options.filePath;
    this.delegate = new InMemoryAnalysisStore({ maxAnalyses: options.maxAnalyses, ttlMs: options.ttlMs });
  }

  private storageError(operation: string, cause?: unknown): AppError {
    const causeCode = cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
    return new AppError({
      code: "ANALYSIS_STORAGE_UNAVAILABLE",
      message: `Analysis storage is unavailable while ${operation}. Configure a writable REPO_STORY_JOB_STORE_PATH or use a durable database-backed deployment adapter.`,
      retryable: true,
      details: { path: this.filePath, ...(causeCode ? { cause: causeCode } : {}) },
    });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const state = JSON.parse(raw) as PersistedAnalysisRepositoryState;
      this.delegate.importState(state);
      await this.delegate.markExpiredJobs();
      this.loaded = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.loaded = true;
      } else {
        console.error("[RepoStory] unable to load analysis storage", error);
        throw this.storageError("loading the job store", error);
      }
    }
  }

  private async persist(): Promise<void> {
    const state = this.delegate.exportState();
    const operation = this.writeQueue.catch(() => undefined).then(async () => {
      try {
        await mkdir(dirname(this.filePath), { recursive: true });
        const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
        await writeFile(temporaryPath, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
        await rename(temporaryPath, this.filePath);
      } catch (error) {
        console.error("[RepoStory] unable to persist analysis storage", error);
        throw this.storageError("saving the job store", error);
      }
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }

  public async createJob(job: AnalysisJobRecord): Promise<AnalysisJobRecord> { await this.ensureLoaded(); const result = await this.delegate.createJob(job); await this.persist(); return result; }
  public async createOrReuseJob(job: AnalysisJobRecord): Promise<{ job: AnalysisJobRecord; created: boolean }> { await this.ensureLoaded(); const result = await this.delegate.createOrReuseJob(job); if (result.created) await this.persist(); return result; }
  public async getJob(jobId: string, ownerId?: string): Promise<AnalysisJobRecord | undefined> { await this.ensureLoaded(); return this.delegate.getJob(jobId, ownerId); }
  public async updateJob(jobId: string, patch: AnalysisJobPatch, ownerId?: string): Promise<AnalysisJobRecord | undefined> { await this.ensureLoaded(); const result = await this.delegate.updateJob(jobId, patch, ownerId); if (result) await this.persist(); return result; }
  public async findReusableJob(cacheKey: string, ownerId: string, now?: number): Promise<AnalysisJobRecord | undefined> { await this.ensureLoaded(); return this.delegate.findReusableJob(cacheKey, ownerId, now); }
  public async getJobByAnalysisId(analysisId: string, ownerId?: string): Promise<AnalysisJobRecord | undefined> { await this.ensureLoaded(); return this.delegate.getJobByAnalysisId(analysisId, ownerId); }
  public async markExpiredJobs(now?: number): Promise<number> { await this.ensureLoaded(); const result = await this.delegate.markExpiredJobs(now); if (result) await this.persist(); return result; }
  public async deleteExpiredJobs(now?: number): Promise<number> { await this.ensureLoaded(); const result = await this.delegate.deleteExpiredJobs(now); if (result) await this.persist(); return result; }
  public async saveAnalysisResult(result: AnalysisResult, ownerId?: string): Promise<boolean> { await this.ensureLoaded(); const saved = await this.delegate.saveAnalysisResult(result, ownerId); if (saved) await this.persist(); return saved; }
  public async getAnalysisResult(analysisId: string, ownerId?: string): Promise<AnalysisResult | undefined> { await this.ensureLoaded(); return this.delegate.getAnalysisResult(analysisId, ownerId); }
  public async saveExplanation(analysisId: string, explanation: ProjectExplanation, ownerId?: string): Promise<void> { await this.ensureLoaded(); await this.delegate.saveExplanation(analysisId, explanation, ownerId); await this.persist(); }
  public async getExplanation(analysisId: string, ownerId?: string): Promise<ProjectExplanation | undefined> { await this.ensureLoaded(); return this.delegate.getExplanation(analysisId, ownerId); }
  public async saveExplanationUnavailable(analysisId: string, unavailable: { code: string; message: string }, ownerId?: string): Promise<void> { await this.ensureLoaded(); await this.delegate.saveExplanationUnavailable(analysisId, unavailable, ownerId); await this.persist(); }
  public async getExplanationUnavailable(analysisId: string, ownerId?: string): Promise<{ code: string; message: string } | undefined> { await this.ensureLoaded(); return this.delegate.getExplanationUnavailable(analysisId, ownerId); }
  public async saveAnalysisDiagram(diagram: Diagram, ownerId?: string): Promise<void> { await this.ensureLoaded(); await this.delegate.saveAnalysisDiagram(diagram, ownerId); await this.persist(); }
  public async getAnalysisDiagram(diagramId: string, ownerId?: string): Promise<Diagram | undefined> { await this.ensureLoaded(); return this.delegate.getAnalysisDiagram(diagramId, ownerId); }
  public async listAnalysisDiagrams(analysisId: string, ownerId?: string): Promise<Diagram[]> { await this.ensureLoaded(); return this.delegate.listAnalysisDiagrams(analysisId, ownerId); }
  public async resetAnalysisDiagram(diagramId: string, ownerId?: string): Promise<Diagram | undefined> { await this.ensureLoaded(); const result = await this.delegate.resetAnalysisDiagram(diagramId, ownerId); if (result) await this.persist(); return result; }
}
