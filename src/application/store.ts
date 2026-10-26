import type { AnalysisJobPatch, AnalysisJobRepository, PersistedAnalysisRepositoryState } from "@/application/jobs/analysis-job-repository";
import type { AnalysisJobRecord as DurableAnalysisJob, AnalysisResult } from "@/domain/analysis";
import type { ProjectExplanation } from "@/domain/ai-explanation";
import type { Diagram } from "@/domain/diagram";
import { DEFAULT_STORE_LIMITS } from "@/shared/limits";
import { redactPathValues } from "@/shared/redaction";
import { nowIso } from "@/shared/ids";

export interface InMemoryAnalysisStoreOptions {
  maxAnalyses?: number;
  ttlMs?: number;
  now?: () => number;
}

export interface AnalysisStore {
  startAnalysis?(id: string): void;
  finishAnalysis?(id: string): void;
  save(job: AnalysisResult): void;
  get(id: string): AnalysisResult | undefined;
  update(job: AnalysisResult): void;
  saveDiagram(diagram: Diagram): void;
  getDiagram(id: string): Diagram | undefined;
  listDiagrams(analysisId: string): Diagram[];
  delete(id: string): void;
  resetDiagram(id: string): Diagram | undefined;
}

export class InMemoryAnalysisStore implements AnalysisStore, AnalysisJobRepository {
  private readonly jobs = new Map<string, AnalysisResult>();
  private readonly durableJobs = new Map<string, DurableAnalysisJob>();
  private readonly explanations = new Map<string, ProjectExplanation>();
  private readonly explanationUnavailable = new Map<string, { code: string; message: string }>();
  private readonly diagrams = new Map<string, Diagram>();
  private readonly generatedDiagrams = new Map<string, Diagram>();
  private readonly entries = new Map<string, { lastAccessed: number; expiresAt: number }>();
  private readonly activeAnalysisIds = new Set<string>();
  private readonly retiredAnalysisIds = new Set<string>();
  private readonly maxAnalyses: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  public constructor(options: InMemoryAnalysisStoreOptions = {}) {
    this.maxAnalyses = options.maxAnalyses ?? DEFAULT_STORE_LIMITS.maxAnalyses;
    this.ttlMs = options.ttlMs ?? DEFAULT_STORE_LIMITS.ttlMs;
    this.now = options.now ?? Date.now;
  }

  private purgeExpired(now = this.now()): void {
    for (const [analysisId, entry] of this.entries) if (entry.expiresAt <= now) this.removeAnalysis(analysisId);
  }

  private touch(analysisId: string): void {
    const now = this.now();
    this.entries.set(analysisId, { lastAccessed: now, expiresAt: now + this.ttlMs });
    while (this.entries.size > this.maxAnalyses) {
      const oldest = [...this.entries.entries()].sort((left, right) => left[1].lastAccessed - right[1].lastAccessed)[0]?.[0];
      if (!oldest) break;
      this.removeAnalysis(oldest);
    }
  }

  private removeAnalysis(id: string): void {
    if (this.activeAnalysisIds.has(id)) this.retiredAnalysisIds.add(id);
    this.entries.delete(id);
    this.jobs.delete(id);
    for (const [diagramId, diagram] of this.diagrams) {
      if (diagram.analysisId !== id) continue;
      this.diagrams.delete(diagramId);
      this.generatedDiagrams.delete(diagramId);
    }
  }

  public save(job: AnalysisResult): void {
    this.purgeExpired();
    if (this.retiredAnalysisIds.has(job.id)) return;
    this.touch(job.id);
    this.jobs.set(job.id, structuredClone(redactPathValues(job)));
  }

  public async createJob(job: DurableAnalysisJob): Promise<DurableAnalysisJob> {
    this.purgeExpired();
    this.durableJobs.set(job.jobId, structuredClone(redactPathValues(job)));
    return structuredClone(job);
  }

  public async createOrReuseJob(job: DurableAnalysisJob): Promise<{ job: DurableAnalysisJob; created: boolean }> {
    const reusable = await this.findReusableJob(job.cacheKey, job.ownerId);
    if (reusable) return { job: reusable, created: false };
    return { job: await this.createJob(job), created: true };
  }

  public async getJob(jobId: string, ownerId?: string): Promise<DurableAnalysisJob | undefined> {
    this.purgeExpired();
    const job = this.durableJobs.get(jobId);
    if (!job || ownerId && job.ownerId !== ownerId) return undefined;
    return structuredClone(job);
  }

  public async updateJob(jobId: string, patch: AnalysisJobPatch, ownerId?: string): Promise<DurableAnalysisJob | undefined> {
    const current = await this.getJob(jobId, ownerId);
    if (!current) return undefined;
    if ((current.status === "completed" || current.status === "cancelled" || current.status === "expired") && (patch.status === undefined || patch.status !== current.status)) return current;
    if (current.status === "failed" && patch.status !== undefined && patch.status !== "queued" && patch.status !== "failed") return current;
    const updated = redactPathValues({ ...current, ...patch, updatedAt: patch.updatedAt ?? nowIso() });
    this.durableJobs.set(jobId, structuredClone(updated));
    return structuredClone(updated);
  }

  public async findReusableJob(cacheKey: string, ownerId: string, now = Date.now()): Promise<DurableAnalysisJob | undefined> {
    this.purgeExpired(now);
    const candidates = [...this.durableJobs.values()]
      .filter((job) => job.ownerId === ownerId && job.cacheKey === cacheKey && new Date(job.expiresAt).getTime() > now)
      .filter((job) => job.status === "queued" || job.status === "fetching" || job.status === "analyzing" || job.status === "explaining" || job.status === "completed")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return candidates[0] ? structuredClone(candidates[0]) : undefined;
  }

  public async getJobByAnalysisId(analysisId: string, ownerId?: string): Promise<DurableAnalysisJob | undefined> {
    this.purgeExpired();
    const job = [...this.durableJobs.values()].find((candidate) => candidate.analysisId === analysisId && (!ownerId || candidate.ownerId === ownerId));
    return job ? structuredClone(job) : undefined;
  }

  public async markExpiredJobs(now = Date.now()): Promise<number> {
    let count = 0;
    for (const [jobId, job] of this.durableJobs) {
      if (job.status === "expired" || job.status === "cancelled" || job.status === "failed" || job.status === "completed") continue;
      if (new Date(job.expiresAt).getTime() > now) continue;
      const expired: DurableAnalysisJob = { ...job, status: "expired", stage: "completed", progress: 100, message: "This analysis job expired before it completed.", updatedAt: new Date(now).toISOString(), error: { code: "JOB_EXPIRED", message: "This analysis job expired before it completed.", retryable: false } };
      this.durableJobs.set(jobId, expired);
      count += 1;
    }
    return count;
  }

  public async deleteExpiredJobs(now = Date.now()): Promise<number> {
    let count = 0;
    for (const [jobId, job] of this.durableJobs) {
      if (job.status !== "expired" || new Date(job.updatedAt).getTime() + this.ttlMs > now) continue;
      this.durableJobs.delete(jobId);
      if (job.analysisId) {
        this.jobs.delete(job.analysisId);
        this.explanations.delete(job.analysisId);
        this.explanationUnavailable.delete(job.analysisId);
      }
      count += 1;
    }
    return count;
  }

  public async saveAnalysisResult(result: AnalysisResult, ownerId?: string): Promise<boolean> {
    const job = [...this.durableJobs.values()].find((candidate) => candidate.analysisId === result.id || candidate.jobId === result.id);
    if (job && ownerId && job.ownerId !== ownerId) return false;
    if (job && (job.status === "cancelled" || job.status === "expired" || job.cancellationRequested)) return false;
    this.save(result);
    if (job) this.durableJobs.set(job.jobId, structuredClone({ ...job, analysisId: result.id, updatedAt: nowIso() }));
    return true;
  }

  public async getAnalysisResult(analysisId: string, ownerId?: string): Promise<AnalysisResult | undefined> {
    const job = await this.getJobByAnalysisId(analysisId, ownerId);
    if (job?.status === "expired") return undefined;
    return this.get(analysisId);
  }

  public async saveExplanation(analysisId: string, explanation: ProjectExplanation, ownerId?: string): Promise<void> {
    const job = await this.getJobByAnalysisId(analysisId, ownerId);
    if (!job || job.status === "cancelled" || job.status === "expired" || job.cancellationRequested || ownerId && job.ownerId !== ownerId) return;
    this.explanations.set(analysisId, structuredClone(redactPathValues(explanation)));
    this.explanationUnavailable.delete(analysisId);
    const result = this.jobs.get(analysisId);
    if (result) this.jobs.set(analysisId, structuredClone({ ...result, explanation: structuredClone(explanation), explanationUnavailable: undefined }));
  }

  public async getExplanation(analysisId: string, ownerId?: string): Promise<ProjectExplanation | undefined> {
    const job = await this.getJobByAnalysisId(analysisId, ownerId);
    if (ownerId && !job) return undefined;
    const explanation = this.explanations.get(analysisId) ?? this.jobs.get(analysisId)?.explanation;
    return explanation ? structuredClone(explanation) : undefined;
  }

  public async saveExplanationUnavailable(analysisId: string, unavailable: { code: string; message: string }, ownerId?: string): Promise<void> {
    const job = await this.getJobByAnalysisId(analysisId, ownerId);
    if (!job || job.status === "cancelled" || job.status === "expired" || job.cancellationRequested || ownerId && job.ownerId !== ownerId) return;
    this.explanationUnavailable.set(analysisId, structuredClone(unavailable));
    const result = this.jobs.get(analysisId);
    if (result) this.jobs.set(analysisId, structuredClone({ ...result, explanationUnavailable: unavailable }));
  }

  public async getExplanationUnavailable(analysisId: string, ownerId?: string): Promise<{ code: string; message: string } | undefined> {
    const job = await this.getJobByAnalysisId(analysisId, ownerId);
    if (ownerId && !job) return undefined;
    const unavailable = this.explanationUnavailable.get(analysisId) ?? this.jobs.get(analysisId)?.explanationUnavailable;
    return unavailable ? structuredClone(unavailable) : undefined;
  }

  public async saveAnalysisDiagram(diagram: Diagram, ownerId?: string): Promise<void> {
    const job = await this.getJobByAnalysisId(diagram.analysisId, ownerId);
    if (!job || job.status === "cancelled" || job.status === "expired" || job.cancellationRequested || ownerId && job.ownerId !== ownerId) return;
    this.saveDiagram(diagram);
  }

  public async getAnalysisDiagram(diagramId: string, ownerId?: string): Promise<Diagram | undefined> {
    const diagram = this.getDiagram(diagramId);
    if (!diagram) return undefined;
    const job = await this.getJobByAnalysisId(diagram.analysisId, ownerId);
    return ownerId && !job ? undefined : diagram;
  }

  public async listAnalysisDiagrams(analysisId: string, ownerId?: string): Promise<Diagram[]> {
    const job = await this.getJobByAnalysisId(analysisId, ownerId);
    if (ownerId && !job) return [];
    return this.listDiagrams(analysisId);
  }

  public async resetAnalysisDiagram(diagramId: string, ownerId?: string): Promise<Diagram | undefined> {
    const diagram = this.getDiagram(diagramId);
    if (!diagram) return undefined;
    const job = await this.getJobByAnalysisId(diagram.analysisId, ownerId);
    if (ownerId && !job) return undefined;
    return this.resetDiagram(diagramId);
  }

  public exportState(): PersistedAnalysisRepositoryState {
    return {
      version: 1,
      jobs: [...this.durableJobs.values()].map((job) => structuredClone(job)),
      results: [...this.jobs.values()].map((result) => structuredClone(result)),
      explanations: [...this.explanations.entries()].map(([analysisId, explanation]) => ({ analysisId, explanation: structuredClone(explanation) })),
      explanationUnavailable: [...this.explanationUnavailable.entries()].map(([analysisId, unavailable]) => ({ analysisId, unavailable: structuredClone(unavailable) })),
      diagrams: [...this.diagrams.values()].map((diagram) => structuredClone(diagram)),
      generatedDiagrams: [...this.generatedDiagrams.values()].map((diagram) => structuredClone(diagram)),
    };
  }

  public importState(state: PersistedAnalysisRepositoryState): void {
    if (state.version !== 1) return;
    this.durableJobs.clear(); this.jobs.clear(); this.explanations.clear(); this.explanationUnavailable.clear(); this.diagrams.clear(); this.generatedDiagrams.clear();
    for (const job of state.jobs) this.durableJobs.set(job.jobId, structuredClone(job));
    for (const result of state.results) this.jobs.set(result.id, structuredClone(result));
    for (const item of state.explanations) this.explanations.set(item.analysisId, structuredClone(item.explanation));
    for (const item of state.explanationUnavailable) this.explanationUnavailable.set(item.analysisId, structuredClone(item.unavailable));
    for (const diagram of state.diagrams) this.diagrams.set(diagram.id, structuredClone(diagram));
    for (const diagram of state.generatedDiagrams) this.generatedDiagrams.set(diagram.id, structuredClone(diagram));
  }

  public startAnalysis(id: string): void {
    this.activeAnalysisIds.add(id);
    this.retiredAnalysisIds.delete(id);
  }

  public finishAnalysis(id: string): void {
    this.activeAnalysisIds.delete(id);
    this.retiredAnalysisIds.delete(id);
  }

  public update(job: AnalysisResult): void {
    this.save(job);
  }

  public get(id: string): AnalysisResult | undefined {
    this.purgeExpired();
    const job = this.jobs.get(id);
    if (job) this.touch(id);
    return job ? structuredClone(job) : undefined;
  }

  public saveDiagram(diagram: Diagram): void {
    this.purgeExpired();
    if (this.retiredAnalysisIds.has(diagram.analysisId)) return;
    this.touch(diagram.analysisId);
    const safeDiagram = redactPathValues(diagram);
    if (!this.generatedDiagrams.has(diagram.id)) this.generatedDiagrams.set(diagram.id, structuredClone(safeDiagram));
    this.diagrams.set(diagram.id, structuredClone(safeDiagram));
  }

  public getDiagram(id: string): Diagram | undefined {
    this.purgeExpired();
    const diagram = this.diagrams.get(id);
    if (diagram) this.touch(diagram.analysisId);
    return diagram ? structuredClone(diagram) : undefined;
  }

  public listDiagrams(analysisId: string): Diagram[] {
    this.purgeExpired();
    if (this.entries.has(analysisId)) this.touch(analysisId);
    return [...this.diagrams.values()]
      .filter((diagram) => diagram.analysisId === analysisId)
      .map((diagram) => structuredClone(diagram));
  }

  public delete(id: string): void {
    this.removeAnalysis(id);
  }

  public resetDiagram(id: string): Diagram | undefined {
    this.purgeExpired();
    const original = this.generatedDiagrams.get(id);
    if (!original) return undefined;
    this.touch(original.analysisId);
    const reset = structuredClone(original);
    this.diagrams.set(id, reset);
    return structuredClone(reset);
  }
}
