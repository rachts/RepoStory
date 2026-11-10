import type { AnalysisError, AnalysisResult, AnalysisCoverage, DiagramAvailability } from "@/domain/analysis";
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
import { logger } from "@/shared/logger";
import { withSpan } from "@/shared/tracer";
import { repostoryJobsTotal, repostoryJobDurationSeconds } from "@/shared/metrics";

export interface AnalysisRunOptions {
  limits?: AnalysisLimits;
  now?: () => number;
  budget?: AnalysisBudget;
  analysisId?: string;
  signal?: AbortSignal;
  files?: RepositoryFile[] | AsyncIterable<RepositoryFile>;
  onProgress?: (progress: { stage: AnalysisResult["stage"]; progress: number; message: string }) => void;
  cacheStore?: import("@/application/cache/cache-store").CacheStore;
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

function fileSize(file: RepositoryFile): number {
  if (Number.isSafeInteger(file.sizeBytes) && (file.sizeBytes ?? 0) >= 0) return file.sizeBytes ?? 0;
  return file.content === undefined ? 0 : new TextEncoder().encode(file.content).byteLength;
}

function isSupportedPath(path: string): boolean {
  return /\.(tsx?|jsx?|css|scss|json|md|yml|yaml|toml|sql|prisma|py|go|rs|java|kt|rb|php|swift)$/i.test(path)
    || /(^|\/)(Dockerfile(?:\..*)?|Makefile|Gemfile|Procfile|Rakefile|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pom\.xml|composer\.json)$/.test(path);
}

function buildCoverage(
  discovered: readonly RepositoryFile[],
  analyzed: readonly RepositoryFile[],
  limits: AnalysisLimits,
  snapshotCoverage?: Partial<AnalysisCoverage>,
): AnalysisCoverage {
  const analyzedPaths = new Set(analyzed.map((file) => file.path));
  let tooLarge = snapshotCoverage?.filesSkippedByReason?.tooLarge ?? 0;
  let unsupported = snapshotCoverage?.filesSkippedByReason?.unsupported ?? 0;
  let limitReached = snapshotCoverage?.filesSkippedByReason?.limitReached ?? 0;
  const lfsPointer = snapshotCoverage?.filesSkippedByReason?.lfsPointer ?? 0;
  const submodule = snapshotCoverage?.filesSkippedByReason?.submodule ?? 0;
  const unsupportedEncoding = snapshotCoverage?.filesSkippedByReason?.unsupportedEncoding ?? 0;
  const pathCollision = snapshotCoverage?.filesSkippedByReason?.pathCollision ?? 0;

  for (const file of discovered) {
    if (analyzedPaths.has(file.path)) continue;
    if (fileSize(file) > limits.maxFileBytes) tooLarge += 1;
    else if (!isSupportedPath(file.path)) unsupported += 1;
    else limitReached += 1;
  }

  const filesSkippedDetails = [...(snapshotCoverage?.filesSkippedDetails ?? [])];
  const warnings = [...(snapshotCoverage?.warnings ?? [])];

  const totalDiscovered = (snapshotCoverage?.filesConsidered !== undefined && snapshotCoverage?.filesSkipped !== undefined)
    ? (snapshotCoverage.filesConsidered + snapshotCoverage.filesSkipped)
    : Math.max(discovered.length, analyzed.length);
  const filesSkipped = Math.max(0, totalDiscovered - analyzed.length);
  const analyzedPercent = snapshotCoverage?.analyzedPercent ?? (totalDiscovered > 0 ? Math.round((analyzed.length / totalDiscovered) * 100) : 100);
  const confidence: AnalysisCoverage["analysisConfidence"] =
    filesSkipped === 0 ? "high" : filesSkipped <= Math.max(1, totalDiscovered * 0.1) ? "medium" : "low";

  return {
    filesConsidered: analyzed.length,
    filesSkipped,
    filesSkippedByReason: {
      tooLarge,
      unsupported,
      limitReached,
      ...(lfsPointer > 0 ? { lfsPointer } : {}),
      ...(submodule > 0 ? { submodule } : {}),
      ...(unsupportedEncoding > 0 ? { unsupportedEncoding } : {}),
      ...(pathCollision > 0 ? { pathCollision } : {}),
    },
    filesSkippedDetails,
    skippedFiles: filesSkippedDetails.map((f) => ({ path: f.path, reason: f.reason })),
    warnings,
    analyzedPercent,
    treeTruncated: snapshotCoverage?.treeTruncated ?? false,
    analysisConfidence: confidence,
  };
}

export async function runAnalysis(
  reference: RepositoryReference,
  provider: RepositoryProvider,
  store: AnalysisStore,
  options: AnalysisRunOptions = {},
): Promise<Result<AnalysisResult, AppError>> {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const id = options.analysisId ?? opaqueId("analysis");
  store.startAnalysis?.(id);
  const started = nowIso();
  let job: AnalysisResult = {
    id,
    repository: { id: "pending", owner: reference.owner, name: reference.name, url: reference.url, defaultBranch: reference.branch ?? "main", selectedBranch: reference.branch ?? "main", sizeBytes: 0, fileCount: 0 },
    status: "running",
    stage: "fetch-metadata",
    progressPercent: 10,
    filesDiscovered: 0,
    filesAnalyzed: 0,
    technologies: [],
    findings: [],
    diagramIds: [],
    createdAt: started,
  };
  store.save(job);
  const signal = options.signal ?? AbortSignal.timeout(limits.maxAnalysisMs);
  const budget = options.budget ?? createAnalysisBudget(limits.maxAnalysisMs, options.now, signal);
  const progress = (stage: AnalysisResult["stage"], progressPercent: number, message: string): void => {
    job = { ...job, stage, progressPercent, status: "running" };
    store.save(job);
    options.onProgress?.({ stage, progress: progressPercent, message });
  };
  const fail = (error: AppError): Result<AnalysisResult, AppError> => {
    let finalError = error;
    if (error.code === "ANALYSIS_TIMEOUT") {
      finalError = new AppError({
        code: "ANALYSIS_TIMEOUT",
        message: `Analysis timed out during stage '${job.stage}'.`,
        retryable: false,
        details: { stage: job.stage },
      });
    }
    logger.warn({ analysisId: id, stage: job.stage, code: finalError.code }, finalError.message);
    repostoryJobsTotal.inc({ status: "failed" });
    const failed: AnalysisResult = redactPathValues({
      ...job,
      status: "failed",
      stage: "completed",
      error: {
        code: finalError.code as AnalysisError["code"],
        message: finalError.message,
        retryable: false,
        details: finalError.details,
      },
    });
    store.save(failed);
    return err(finalError);
  };

  const cacheStore = options.cacheStore ?? provider.cacheStore;
  const isCommitSha = reference.branch && /^[0-9a-f]{40}$/i.test(reference.branch);

  if (isCommitSha && cacheStore) {
    const analysisCacheKey = `${reference.owner.toLowerCase()}/${reference.name.toLowerCase()}@${reference.branch}:analysis`;
    const cached = await cacheStore.get<AnalysisResult>(analysisCacheKey);
    if (cached) {
      job = {
        ...cached,
        id,
        createdAt: started,
        completedAt: nowIso(),
      };
      store.save(job);
      progress("completed", 100, "Analysis complete (cached)");
      return ok(job);
    }
  }

  try {
    let repository: typeof job.repository;
    const rawFiles: RepositoryFile[] = [];
    let snapshotCoverage: Partial<AnalysisCoverage> | undefined;

    if (options.files) {
      repository = { id: reference.name, owner: reference.owner, name: reference.name, url: reference.url, defaultBranch: reference.branch ?? "main", selectedBranch: reference.branch ?? "main", sizeBytes: 0, fileCount: 0 };
      if (Symbol.asyncIterator in options.files) {
        for await (const file of options.files) {
          budget.check();
          rawFiles.push(file);
        }
      } else {
        rawFiles.push(...options.files);
      }
    } else {
      progress("fetch-metadata", 12, "Reading repository metadata");
      const snapshot = await withSpan("fetch-metadata", async () => provider.getSnapshot(reference, signal, budget, (p) => {
        progress(p.stage as AnalysisResult["stage"], p.progress, p.message);
      }));
      if (!snapshot.ok) return fail(snapshot.error);
      budget.check();
      repository = redactPathValues(snapshot.value.repository, budget);
      snapshotCoverage = snapshot.value.coverage;

      const resolvedCommitSha = snapshot.value.repository.commitSha ?? reference.branch;
      if (resolvedCommitSha && cacheStore) {
        const analysisCacheKey = `${reference.owner.toLowerCase()}/${reference.name.toLowerCase()}@${resolvedCommitSha}:analysis`;
        const cached = await cacheStore.get<AnalysisResult>(analysisCacheKey);
        if (cached) {
          job = {
            ...cached,
            id,
            repository: snapshot.value.repository,
            createdAt: started,
            completedAt: nowIso(),
          };
          store.save(job);
          progress("completed", 100, "Analysis complete (cached)");
          return ok(job);
        }
      }

      if (Symbol.asyncIterator in snapshot.value.files) {
        for await (const file of snapshot.value.files) {
          budget.check();
          rawFiles.push(file);
        }
      } else {
        rawFiles.push(...snapshot.value.files);
      }
    }

    progress("fetch-archive", 45, "Fetching bounded repository content");
    const files = filterFiles(rawFiles, limits, budget);
    budget.check();
    const totalDiscovered = (snapshotCoverage?.filesConsidered !== undefined && snapshotCoverage?.filesSkipped !== undefined)
      ? (snapshotCoverage.filesConsidered + snapshotCoverage.filesSkipped)
      : rawFiles.length;
    const filesDiscovered = totalDiscovered;
    const filesAnalyzed = files.length;
    const bytesDiscovered = totalFileBytes(rawFiles);
    const bytesAnalyzed = totalFileBytes(files);
    const coverage: AnalysisCoverage = buildCoverage(rawFiles, files, limits, snapshotCoverage);
    progress("filtering-files", 55, "Filtering for useful repository signal");
    const technologies = redactPathValues(analyzeTechnologies(files, budget), budget);
    budget.check();
    const phase3 = redactPathValues(analyzePhase3(files, budget, limits), budget);
    budget.check();
    progress("analyze", 65, "Finding architecture and entry points");
    const safeFindings = await withSpan("analyze", async () => {
      const findings: typeof phase3.findings = [];
      for (const collection of [technologies, analyzeDirectories(files, budget), analyzeEntryPoints(files, budget), phase3.findings]) {
        for (const finding of collection) {
          budget.check();
          findings.push(finding);
        }
      }
      return redactPathValues(findings, budget);
    });
    budget.check();
    progress("generate-diagrams", 85, "Generating evidence-backed story maps");
    const diagrams = await withSpan("generate-diagrams", async () => {
      const resultDiagrams = [] as NonNullable<ReturnType<typeof repositoryStructureDiagram>>[];
      budget.check();
      resultDiagrams.push(repositoryStructureDiagram(id, repository, files, safeFindings, budget));
      budget.check();
      const overview = systemOverviewDiagram(id, repository, safeFindings, budget);
      if (overview) resultDiagrams.push(overview);
      budget.check();
      const requestFlow = apiRequestFlowDiagram(id, repository, safeFindings, phase3.moduleRelationships, budget);
      if (requestFlow) resultDiagrams.push(requestFlow);
      budget.check();
      const authFlow = authenticationFlowDiagram(id, repository, safeFindings, phase3.moduleRelationships, budget);
      if (authFlow) resultDiagrams.push(authFlow);
      return resultDiagrams;
    });
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
    progress("completed", 100, "Analysis complete");
    repostoryJobsTotal.inc({ status: "succeeded" });
    repostoryJobDurationSeconds.observe({ stage: "completed" }, (Date.now() - new Date(started).getTime()) / 1000);
    job = redactPathValues({ ...job, repository, status: "completed", stage: "completed", progressPercent: 100, filesDiscovered, filesAnalyzed, technologies, findings: safeFindings, apiRoutes: phase3.apiRoutes, moduleRelationships: phase3.moduleRelationships, databases: phase3.databases, externalIntegrations: phase3.externalIntegrations, authentication: phase3.authentication, diagramAvailability, diagramIds: diagrams.map((diagram) => diagram.id), diagrams, architectureStory, coverage, completedAt: nowIso() }, budget);
    store.save(job);

    const resolvedCommitSha = repository.commitSha ?? reference.branch;
    if (resolvedCommitSha && cacheStore) {
      const analysisCacheKey = `${reference.owner.toLowerCase()}/${reference.name.toLowerCase()}@${resolvedCommitSha}:analysis`;
      await cacheStore.set(analysisCacheKey, job, 3_600_000);
    }
    if (reference.branch && cacheStore && reference.branch !== resolvedCommitSha) {
      const branchCacheKey = `${reference.owner.toLowerCase()}/${reference.name.toLowerCase()}@${reference.branch}:analysis`;
      await cacheStore.set(branchCacheKey, job, 3_600_000);
    }

    return ok(job);
  } catch (error) {
    if (error instanceof AppError) return fail(error);
    if (signal?.aborted) {
      return fail(new AppError({ code: "ANALYSIS_TIMEOUT", message: `Analysis timed out during stage '${job.stage}'.`, retryable: false, details: { stage: job.stage } }));
    }
    logger.error({ analysisId: id, stage: job.stage, err: error }, "[RepoStory] unexpected analysis pipeline error");
    return fail(new AppError({ code: "ANALYSIS_FAILED", message: "The analysis encountered an unexpected server error. Please retry. If it continues, check the server logs.", retryable: true }));
  } finally {
    store.finishAnalysis?.(id);
  }
}
