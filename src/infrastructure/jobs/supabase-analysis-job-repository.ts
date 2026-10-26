import type { ProjectExplanation } from "@/domain/ai-explanation";
import type { AnalysisJobPatch, AnalysisJobRepository } from "@/application/jobs/analysis-job-repository";
import type { AnalysisJobRecord, AnalysisResult } from "@/domain/analysis";
import type { Diagram } from "@/domain/diagram";
import { AppError } from "@/domain/errors";
import { redactPathValues } from "@/shared/redaction";
import { nowIso } from "@/shared/ids";

type JsonRecord = Record<string, unknown>;

interface SupabaseOptions {
  url?: string;
  secretKey?: string;
  maxAnalyses?: number;
  ttlMs?: number;
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRows<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function rowToJob(row: JsonRecord): AnalysisJobRecord {
  return {
    jobId: String(row.job_id),
    analysisId: typeof row.analysis_id === "string" ? row.analysis_id : null,
    repositoryUrl: String(row.repository_url),
    branch: String(row.branch),
    ...(typeof row.requested_branch === "string" ? { requestedBranch: row.requested_branch } : {}),
    ownerId: String(row.owner_id),
    cacheKey: String(row.cache_key),
    status: row.status as AnalysisJobRecord["status"],
    stage: row.stage as AnalysisJobRecord["stage"],
    progress: Number(row.progress),
    message: String(row.message),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    expiresAt: String(row.expires_at),
    retryCount: Number(row.retry_count),
    explanationRequested: Boolean(row.explanation_requested),
    ...(typeof row.cancellation_requested === "boolean" ? { cancellationRequested: row.cancellation_requested } : {}),
    ...(isRecord(row.error) ? { error: row.error as unknown as AnalysisJobRecord["error"] } : {}),
    ...(isRecord(row.coverage) ? { coverage: row.coverage as unknown as AnalysisJobRecord["coverage"] } : {}),
  };
}

function jobToRow(job: AnalysisJobRecord): JsonRecord {
  return {
    job_id: job.jobId,
    analysis_id: job.analysisId,
    repository_url: job.repositoryUrl,
    branch: job.branch,
    requested_branch: job.requestedBranch ?? null,
    owner_id: job.ownerId,
    cache_key: job.cacheKey,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    expires_at: job.expiresAt,
    retry_count: job.retryCount,
    explanation_requested: job.explanationRequested,
    cancellation_requested: job.cancellationRequested ?? null,
    error: job.error ?? null,
    coverage: job.coverage ?? null,
  };
}

/** Supabase REST-backed repository for one or more long-running app instances. */
export class SupabaseAnalysisJobRepository implements AnalysisJobRepository {
  private readonly baseUrl: string;
  private readonly secretKey: string;
  private readonly maxAnalyses: number;
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: SupabaseOptions) {
    this.baseUrl = `${options.url?.replace(/\/$/, "") ?? ""}/rest/v1`;
    this.secretKey = options.secretKey ?? "";
    this.maxAnalyses = options.maxAnalyses ?? 100;
    this.ttlMs = options.ttlMs ?? 3_600_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private storageError(operation: string, cause?: unknown): AppError {
    const status = cause && typeof cause === "object" && "status" in cause && typeof cause.status === "number" ? cause.status : undefined;
    return new AppError({
      code: "ANALYSIS_STORAGE_UNAVAILABLE",
      message: `Analysis storage is unavailable while ${operation}. Check the Supabase server credentials and migration.`,
      retryable: true,
      details: { provider: "supabase", ...(status ? { status } : {}) },
    });
  }

  private async request<T>(operation: string, table: string, init: RequestInit = {}, query = ""): Promise<T> {
    if (!this.baseUrl || !this.secretKey) throw this.storageError(operation);
    const response = await this.fetchImpl(`${this.baseUrl}/${table}${query ? `?${query}` : ""}`, {
      ...init,
      headers: {
        apikey: this.secretKey,
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    }).catch((error: unknown) => { throw this.storageError(operation, error); });
    if (!response.ok) {
      console.error(`[RepoStory] Supabase ${operation} failed`, response.status);
      throw this.storageError(operation, { status: response.status });
    }
    if (response.status === 204) return undefined as T;
    const body = await response.text();
    return (body ? JSON.parse(body) : undefined) as T;
  }

  private async jobs(query: string): Promise<AnalysisJobRecord[]> {
    const rows = await this.request<unknown>("reading analysis jobs", "repo_story_jobs", { method: "GET" }, query);
    return asRows<JsonRecord>(rows).map(rowToJob);
  }

  private async job(jobId: string, ownerId?: string): Promise<AnalysisJobRecord | undefined> {
    const params = new URLSearchParams({ select: "*", job_id: `eq.${jobId}` });
    if (ownerId) params.set("owner_id", `eq.${ownerId}`);
    params.set("limit", "1");
    return (await this.jobs(params.toString()))[0];
  }

  private async upsertJob(job: AnalysisJobRecord): Promise<void> {
    await this.request("saving analysis job", "repo_story_jobs", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(jobToRow(job)) });
  }

  public async createJob(job: AnalysisJobRecord): Promise<AnalysisJobRecord> {
    await this.upsertJob(job);
    return structuredClone(job);
  }

  public async createOrReuseJob(job: AnalysisJobRecord): Promise<{ job: AnalysisJobRecord; created: boolean }> {
    const reusable = await this.findReusableJob(job.cacheKey, job.ownerId);
    if (reusable) return { job: reusable, created: false };
    return { job: await this.createJob(job), created: true };
  }

  public async getJob(jobId: string, ownerId?: string): Promise<AnalysisJobRecord | undefined> {
    return this.job(jobId, ownerId);
  }

  public async updateJob(jobId: string, patch: AnalysisJobPatch, ownerId?: string): Promise<AnalysisJobRecord | undefined> {
    const current = await this.job(jobId, ownerId);
    if (!current) return undefined;
    if (["completed", "cancelled", "expired"].includes(current.status) && (patch.status === undefined || patch.status !== current.status)) return current;
    if (current.status === "failed" && patch.status !== undefined && patch.status !== "queued" && patch.status !== "failed") return current;
    const updated = redactPathValues({ ...current, ...patch, updatedAt: patch.updatedAt ?? nowIso() });
    await this.upsertJob(updated);
    return structuredClone(updated);
  }

  public async findReusableJob(cacheKey: string, ownerId: string, now = Date.now()): Promise<AnalysisJobRecord | undefined> {
    const params = new URLSearchParams({ select: "*", owner_id: `eq.${ownerId}`, cache_key: `eq.${cacheKey}`, expires_at: `gt.${new Date(now).toISOString()}`, order: "updated_at.desc", limit: "1" });
    params.set("status", "in.(queued,fetching,analyzing,explaining,completed)");
    return (await this.jobs(params.toString()))[0];
  }

  public async getJobByAnalysisId(analysisId: string, ownerId?: string): Promise<AnalysisJobRecord | undefined> {
    const params = new URLSearchParams({ select: "*", analysis_id: `eq.${analysisId}`, limit: "1" });
    if (ownerId) params.set("owner_id", `eq.${ownerId}`);
    return (await this.jobs(params.toString()))[0];
  }

  public async markExpiredJobs(now = Date.now()): Promise<number> {
    const params = new URLSearchParams({ select: "*", expires_at: `lte.${new Date(now).toISOString()}`, status: "in.(queued,fetching,analyzing,explaining)" });
    const expired = await this.jobs(params.toString());
    for (const job of expired) await this.updateJob(job.jobId, { status: "expired", stage: "completed", progress: 100, message: "This analysis job expired before it completed.", updatedAt: new Date(now).toISOString(), error: { code: "JOB_EXPIRED", message: "This analysis job expired before it completed.", retryable: false } });
    return expired.length;
  }

  public async deleteExpiredJobs(now = Date.now()): Promise<number> {
    const cutoff = new Date(now - this.ttlMs).toISOString();
    const params = new URLSearchParams({ select: "job_id,analysis_id", status: "eq.expired", updated_at: `lte.${cutoff}` });
    const expired = asRows<JsonRecord>(await this.request<unknown>("listing expired jobs", "repo_story_jobs", { method: "GET" }, params.toString()));
    for (const row of expired) {
      const jobId = String(row.job_id);
      await this.request("deleting expired job", "repo_story_jobs", { method: "DELETE" }, new URLSearchParams({ job_id: `eq.${jobId}` }).toString());
      if (typeof row.analysis_id === "string") await this.deleteAnalysis(row.analysis_id);
    }
    return expired.length;
  }

  private async deleteAnalysis(analysisId: string): Promise<void> {
    for (const table of ["repo_story_results", "repo_story_explanations", "repo_story_diagrams"]) {
      await this.request("deleting expired analysis", table, { method: "DELETE" }, new URLSearchParams({ analysis_id: `eq.${analysisId}` }).toString());
    }
  }

  public async saveAnalysisResult(result: AnalysisResult, ownerId?: string): Promise<boolean> {
    const job = await this.getJobByAnalysisId(result.id, ownerId) ?? await this.job(result.id, ownerId);
    if (job && (job.status === "cancelled" || job.status === "expired" || job.cancellationRequested)) return false;
    if (job && ownerId && job.ownerId !== ownerId) return false;
    await this.request("saving analysis result", "repo_story_results", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ analysis_id: result.id, owner_id: job?.ownerId ?? ownerId ?? "system", result: redactPathValues(result), updated_at: nowIso() }) });
    if (job && job.analysisId !== result.id) await this.upsertJob({ ...job, analysisId: result.id, updatedAt: nowIso() });
    return true;
  }

  public async getAnalysisResult(analysisId: string, ownerId?: string): Promise<AnalysisResult | undefined> {
    const job = await this.getJobByAnalysisId(analysisId, ownerId);
    if (ownerId && !job) return undefined;
    const params = new URLSearchParams({ select: "result", analysis_id: `eq.${analysisId}`, limit: "1" });
    const rows = asRows<JsonRecord>(await this.request<unknown>("reading analysis result", "repo_story_results", { method: "GET" }, params.toString()));
    return rows[0]?.result as AnalysisResult | undefined;
  }

  public async saveExplanation(analysisId: string, explanation: ProjectExplanation, ownerId?: string): Promise<void> {
    const job = await this.getJobByAnalysisId(analysisId, ownerId);
    if (!job || job.status === "cancelled" || job.status === "expired" || job.cancellationRequested) return;
    await this.request("saving explanation", "repo_story_explanations", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ analysis_id: analysisId, owner_id: job.ownerId, explanation: redactPathValues(explanation), unavailable: null, updated_at: nowIso() }) });
  }

  public async getExplanation(analysisId: string, ownerId?: string): Promise<ProjectExplanation | undefined> {
    const job = await this.getJobByAnalysisId(analysisId, ownerId);
    if (ownerId && !job) return undefined;
    const params = new URLSearchParams({ select: "explanation", analysis_id: `eq.${analysisId}`, limit: "1" });
    const rows = asRows<JsonRecord>(await this.request<unknown>("reading explanation", "repo_story_explanations", { method: "GET" }, params.toString()));
    return rows[0]?.explanation as ProjectExplanation | undefined;
  }

  public async saveExplanationUnavailable(analysisId: string, unavailable: { code: string; message: string }, ownerId?: string): Promise<void> {
    const job = await this.getJobByAnalysisId(analysisId, ownerId);
    if (!job || job.status === "cancelled" || job.status === "expired" || job.cancellationRequested) return;
    await this.request("saving explanation status", "repo_story_explanations", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ analysis_id: analysisId, owner_id: job.ownerId, explanation: null, unavailable, updated_at: nowIso() }) });
  }

  public async getExplanationUnavailable(analysisId: string, ownerId?: string): Promise<{ code: string; message: string } | undefined> {
    const job = await this.getJobByAnalysisId(analysisId, ownerId);
    if (ownerId && !job) return undefined;
    const params = new URLSearchParams({ select: "unavailable", analysis_id: `eq.${analysisId}`, limit: "1" });
    const rows = asRows<JsonRecord>(await this.request<unknown>("reading explanation status", "repo_story_explanations", { method: "GET" }, params.toString()));
    return rows[0]?.unavailable as { code: string; message: string } | undefined;
  }

  private async diagramRow(diagramId: string, ownerId?: string): Promise<JsonRecord | undefined> {
    const params = new URLSearchParams({ select: "*", diagram_id: `eq.${diagramId}`, limit: "1" });
    if (ownerId) params.set("owner_id", `eq.${ownerId}`);
    const rows = asRows<JsonRecord>(await this.request<unknown>("reading diagram", "repo_story_diagrams", { method: "GET" }, params.toString()));
    return rows[0];
  }

  public async saveAnalysisDiagram(diagram: Diagram, ownerId?: string): Promise<void> {
    const job = await this.getJobByAnalysisId(diagram.analysisId, ownerId);
    if (!job || job.status === "cancelled" || job.status === "expired" || job.cancellationRequested) return;
    const existing = await this.diagramRow(diagram.id, job.ownerId);
    await this.request("saving diagram", "repo_story_diagrams", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ diagram_id: diagram.id, analysis_id: diagram.analysisId, owner_id: job.ownerId, diagram: redactPathValues(diagram), original_diagram: existing?.original_diagram ?? redactPathValues(diagram), updated_at: nowIso() }) });
  }

  public async getAnalysisDiagram(diagramId: string, ownerId?: string): Promise<Diagram | undefined> {
    return (await this.diagramRow(diagramId, ownerId))?.diagram as Diagram | undefined;
  }

  public async listAnalysisDiagrams(analysisId: string, ownerId?: string): Promise<Diagram[]> {
    const params = new URLSearchParams({ select: "diagram", analysis_id: `eq.${analysisId}`, order: "diagram_id.asc" });
    if (ownerId) params.set("owner_id", `eq.${ownerId}`);
    const rows = asRows<JsonRecord>(await this.request<unknown>("listing diagrams", "repo_story_diagrams", { method: "GET" }, params.toString()));
    return rows.map((row) => row.diagram as Diagram);
  }

  public async resetAnalysisDiagram(diagramId: string, ownerId?: string): Promise<Diagram | undefined> {
    const existing = await this.diagramRow(diagramId, ownerId);
    if (!existing?.original_diagram) return undefined;
    const original = existing.original_diagram as Diagram;
    await this.request("resetting diagram", "repo_story_diagrams", { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ diagram: original, updated_at: nowIso() }) }, new URLSearchParams({ diagram_id: `eq.${diagramId}` }).toString());
    return structuredClone(original);
  }
}
