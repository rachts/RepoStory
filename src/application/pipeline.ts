import type { AnalysisError, AnalysisJob, DiagramAvailability } from "@/domain/analysis";
import type { RepositoryFile, RepositoryProvider, RepositoryReference } from "@/domain/repository";
import { repositoryStructureDiagram, systemOverviewDiagram } from "@/analysis/diagrams";
import { analyzeDirectories, analyzeEntryPoints, analyzePhase3, analyzeTechnologies, apiRequestFlowDiagram, authenticationFlowDiagram, generateArchitectureStory } from "@/analysis";
import { filterFiles } from "@/analysis/filter-files";
import { AppError } from "@/domain/errors";
import type { AnalysisStore } from "@/application/store";
import { nowIso, opaqueId } from "@/shared/ids";
import { err, ok, type Result } from "@/shared/result";
import { createAnalysisBudget, DEFAULT_LIMITS, type AnalysisBudget, type AnalysisLimits } from "@/shared/limits";
import { redactPathValues } from "@/shared/redaction";

export interface AnalysisRunOptions {
  limits?: AnalysisLimits;
  now?: () => number;
  budget?: AnalysisBudget;
}

function fileBytes(file: RepositoryFile): number {
  if (Number.isSafeInteger(file.sizeBytes) && (file.sizeBytes ?? 0) >= 0) return file.sizeBytes ?? 0;
  return file.content === undefined ? 0 : new TextEncoder().encode(file.content).byteLength;
}

function totalFileBytes(files: readonly RepositoryFile[]): number {
  let total = 0;
  for (const file of files) {
    const bytes = fileBytes(file);
    total = Math.min(Number.MAX_SAFE_INTEGER, total + bytes);
  }
  return total;
}

export async function runAnalysis(
  reference: RepositoryReference,
  provider: RepositoryProvider,
  store: AnalysisStore,
  options: AnalysisRunOptions = {},
): Promise<Result<AnalysisJob, AppError>> {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const id = opaqueId("analysis");
  store.startAnalysis?.(id);
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
  const budget = options.budget ?? createAnalysisBudget(limits.maxAnalysisMs, options.now, signal);
  const fail = (error: AppError): Result<AnalysisJob, AppError> => {
    const failed: AnalysisJob = redactPathValues({ ...job, status: "failed", stage: "completed", error: { code: error.code as AnalysisError["code"], message: error.message, retryable: error.retryable, details: error.details } });
    store.save(failed);
    return err(error);
  };

  try {
    const snapshot = await provider.getSnapshot(reference, signal, budget);
    if (!snapshot.ok) return fail(snapshot.error);
    budget.check();
    const repository = redactPathValues(snapshot.value.repository, budget);

    const files = filterFiles(snapshot.value.files, limits, budget);
    budget.check();
    const filesDiscovered = snapshot.value.files.length;
    const filesAnalyzed = files.length;
    const bytesDiscovered = totalFileBytes(snapshot.value.files);
    const bytesAnalyzed = totalFileBytes(files);
    const technologies = redactPathValues(analyzeTechnologies(files, budget), budget);
    budget.check();
    const phase3 = redactPathValues(analyzePhase3(files, budget, limits), budget);
    budget.check();
    const findings: typeof phase3.findings = [];
    for (const collection of [technologies, analyzeDirectories(files, budget), analyzeEntryPoints(files, budget), phase3.findings]) {
      for (const finding of collection) {
        budget.check();
        findings.push(finding);
      }
    }
    const safeFindings = redactPathValues(findings, budget);
    budget.check();
    const diagrams = [] as NonNullable<ReturnType<typeof repositoryStructureDiagram>>[];
    budget.check();
    diagrams.push(repositoryStructureDiagram(id, repository, files, safeFindings, budget));
    budget.check();
    const overview = systemOverviewDiagram(id, repository, safeFindings, budget);
    if (overview) diagrams.push(overview);
    budget.check();
    const requestFlow = apiRequestFlowDiagram(id, repository, safeFindings, phase3.moduleRelationships, budget);
    if (requestFlow) diagrams.push(requestFlow);
    budget.check();
    const authFlow = authenticationFlowDiagram(id, repository, safeFindings, phase3.moduleRelationships, budget);
    if (authFlow) diagrams.push(authFlow);
    budget.check();
    const diagramTypes = new Set(diagrams.map((diagram) => diagram.type));
    const diagramAvailability: DiagramAvailability[] = [
      { type: "repository-structure", available: diagramTypes.has("repository-structure"), confidence: "high" },
      { type: "system-overview", available: diagramTypes.has("system-overview"), confidence: diagramTypes.has("system-overview") ? "medium" : undefined, reason: diagramTypes.has("system-overview") ? undefined : "Not enough technology evidence was found." },
      { type: "api-request-flow", available: diagramTypes.has("api-request-flow"), confidence: phase3.apiRoutes.some((route) => route.confidence === "needs-verification") ? "needs-verification" : phase3.apiRoutes.length ? "medium" : undefined, reason: diagramTypes.has("api-request-flow") ? undefined : "No evidence-backed API routes were detected." },
      { type: "authentication-flow", available: diagramTypes.has("authentication-flow"), confidence: phase3.authentication.some((finding) => finding.confidence === "needs-verification") ? "needs-verification" : phase3.authentication.length ? "medium" : undefined, reason: diagramTypes.has("authentication-flow") ? undefined : "No meaningful authentication evidence was detected." },
    ];
    budget.check();
    const architectureStory = redactPathValues(generateArchitectureStory({ repository, findings: safeFindings, diagrams, diagramAvailability, filesAnalyzed, filesDiscovered, filesSkipped: Math.max(0, filesDiscovered - filesAnalyzed), bytesAnalyzed, bytesDiscovered }, budget), budget);
    for (const diagram of diagrams) { budget.check(); store.saveDiagram(redactPathValues(diagram, budget)); }

    budget.check();
    job = redactPathValues({ ...job, repository, status: "completed", stage: "completed", progressPercent: 100, filesDiscovered, filesAnalyzed, technologies, findings: safeFindings, apiRoutes: phase3.apiRoutes, moduleRelationships: phase3.moduleRelationships, databases: phase3.databases, externalIntegrations: phase3.externalIntegrations, authentication: phase3.authentication, diagramAvailability, diagramIds: diagrams.map((diagram) => diagram.id), architectureStory, completedAt: nowIso() }, budget);
    store.save(job);
    return ok(job);
  } catch (error) {
    return fail(error instanceof AppError ? error : new AppError({ code: "ANALYSIS_FAILED", message: "The analysis could not be completed.", retryable: true }));
  } finally {
    store.finishAnalysis?.(id);
  }
}
