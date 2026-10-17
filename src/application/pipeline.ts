import type { AnalysisError, AnalysisJob, DiagramAvailability } from "@/domain/analysis";
import type { RepositoryProvider, RepositoryReference } from "@/domain/repository";
import { repositoryStructureDiagram, systemOverviewDiagram } from "@/analysis/diagrams";
import { analyzeDirectories, analyzeEntryPoints, analyzePhase3, analyzeTechnologies, apiRequestFlowDiagram, authenticationFlowDiagram } from "@/analysis";
import { filterFiles } from "@/analysis/filter-files";
import { AppError } from "@/domain/errors";
import type { AnalysisStore } from "@/application/store";
import { nowIso, opaqueId } from "@/shared/ids";
import { err, ok, type Result } from "@/shared/result";
import { createAnalysisBudget, DEFAULT_LIMITS, type AnalysisLimits } from "@/shared/limits";

export interface AnalysisRunOptions {
  limits?: AnalysisLimits;
  now?: () => number;
}

export async function runAnalysis(
  reference: RepositoryReference,
  provider: RepositoryProvider,
  store: AnalysisStore,
  options: AnalysisRunOptions = {},
): Promise<Result<AnalysisJob, AppError>> {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const id = opaqueId("analysis");
  const started = nowIso();
  let job: AnalysisJob = {
    id,
    repository: { id: "pending", owner: reference.owner, name: reference.name, url: reference.url, defaultBranch: reference.branch ?? "main", selectedBranch: reference.branch ?? "main", sizeBytes: 0, fileCount: 0 },
    status: "running",
    stage: "fetching-metadata",
    progressPercent: 10,
    filesDiscovered: 0,
    filesAnalyzed: 0,
    technologies: [],
    findings: [],
    diagramIds: [],
    createdAt: started,
  };
  store.save(job);
  const signal = AbortSignal.timeout(limits.maxAnalysisMs);
  const budget = createAnalysisBudget(limits.maxAnalysisMs, options.now, signal);
  const fail = (error: AppError): Result<AnalysisJob, AppError> => {
    const failed: AnalysisJob = { ...job, status: "failed", stage: "completed", error: { code: error.code as AnalysisError["code"], message: error.message, retryable: error.retryable, details: error.details } };
    store.save(failed);
    return err(error);
  };

  try {
    const snapshot = await provider.getSnapshot(reference, signal);
    if (!snapshot.ok) return fail(snapshot.error);
    budget.check();

    const files = filterFiles(snapshot.value.files, limits, budget);
    budget.check();
    const technologies = analyzeTechnologies(files, budget);
    budget.check();
    const phase3 = analyzePhase3(files, budget);
    budget.check();
    const findings = [...technologies, ...analyzeDirectories(files, budget), ...analyzeEntryPoints(files, budget), ...phase3.findings];
    budget.check();
    const diagrams = [
      repositoryStructureDiagram(id, snapshot.value.repository, files, findings),
      (budget.check(), systemOverviewDiagram(id, snapshot.value.repository, findings)),
      apiRequestFlowDiagram(id, snapshot.value.repository, findings, phase3.moduleRelationships, budget),
      authenticationFlowDiagram(id, snapshot.value.repository, findings, phase3.moduleRelationships, budget),
    ].filter((diagram): diagram is NonNullable<typeof diagram> => diagram !== null);
    budget.check();
    const diagramTypes = new Set(diagrams.map((diagram) => diagram.type));
    const diagramAvailability: DiagramAvailability[] = [
      { type: "repository-structure", available: diagramTypes.has("repository-structure"), confidence: "high" },
      { type: "system-overview", available: diagramTypes.has("system-overview"), confidence: diagramTypes.has("system-overview") ? "medium" : undefined, reason: diagramTypes.has("system-overview") ? undefined : "Not enough technology evidence was found." },
      { type: "api-request-flow", available: diagramTypes.has("api-request-flow"), confidence: phase3.apiRoutes.some((route) => route.confidence === "needs-verification") ? "needs-verification" : phase3.apiRoutes.length ? "medium" : undefined, reason: diagramTypes.has("api-request-flow") ? undefined : "No evidence-backed API routes were detected." },
      { type: "authentication-flow", available: diagramTypes.has("authentication-flow"), confidence: phase3.authentication.some((finding) => finding.confidence === "needs-verification") ? "needs-verification" : phase3.authentication.length ? "medium" : undefined, reason: diagramTypes.has("authentication-flow") ? undefined : "No meaningful authentication evidence was detected." },
    ];
    for (const diagram of diagrams) { budget.check(); store.saveDiagram(diagram); }

    budget.check();
    job = { ...job, repository: snapshot.value.repository, status: "completed", stage: "completed", progressPercent: 100, filesDiscovered: snapshot.value.files.length, filesAnalyzed: files.length, technologies, findings, apiRoutes: phase3.apiRoutes, moduleRelationships: phase3.moduleRelationships, databases: phase3.databases, externalIntegrations: phase3.externalIntegrations, authentication: phase3.authentication, diagramAvailability, diagramIds: diagrams.map((diagram) => diagram.id), completedAt: nowIso() };
    store.save(job);
    return ok(job);
  } catch (error) {
    return fail(error instanceof AppError ? error : new AppError({ code: "ANALYSIS_FAILED", message: "The analysis could not be completed.", retryable: true }));
  }
}
