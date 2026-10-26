import { runAnalysis as runAnalysisPipeline, type AnalysisRunOptions } from "@/application/pipeline";
import { InMemoryAnalysisStore, type AnalysisStore } from "@/application/store";
import type { AnalysisJobRepository } from "@/application/jobs/analysis-job-repository";
import { AnalysisJobRunner } from "@/application/jobs/analysis-job-runner";
import { GitHubPublicRepositoryProvider } from "@/infrastructure/providers/github-provider";
import { FileAnalysisJobRepository } from "@/infrastructure/jobs/file-analysis-job-repository";
import { serverConfig } from "@/shared/config";
import type { AnalysisJob } from "@/domain/analysis";
import { AppError } from "@/domain/errors";
import type { RepositoryProvider, RepositoryReference } from "@/domain/repository";
import { err, type Result } from "@/shared/result";

const globalContainer = globalThis as typeof globalThis & {
  repoStoryStore?: InMemoryAnalysisStore;
  repoStoryAnalysisRepository?: AnalysisJobRepository;
  repoStoryJobRunner?: AnalysisJobRunner;
};

export const analysisStore = globalContainer.repoStoryStore ?? new InMemoryAnalysisStore({ maxAnalyses: serverConfig.maxAnalyses, ttlMs: serverConfig.analysisTtlMs });
globalContainer.repoStoryStore = analysisStore;

export const repositoryProvider = new GitHubPublicRepositoryProvider({
  token: serverConfig.githubToken,
});

export const analysisRepository: AnalysisJobRepository = globalContainer.repoStoryAnalysisRepository ?? (serverConfig.jobStoreMode === "file"
  ? new FileAnalysisJobRepository({ filePath: serverConfig.jobStorePath, maxAnalyses: serverConfig.maxAnalyses, ttlMs: serverConfig.jobTtlMs })
  : analysisStore);
globalContainer.repoStoryAnalysisRepository = analysisRepository;

export const analysisJobRunner = globalContainer.repoStoryJobRunner ?? new AnalysisJobRunner(analysisRepository, repositoryProvider);
globalContainer.repoStoryJobRunner = analysisJobRunner;

const MAX_ACTIVE_ANALYSES = 2;
let activeAnalyses = 0;

/** Bound synchronous upstream work so a burst cannot multiply fetch and analysis memory. */
export async function runAnalysis(
  reference: RepositoryReference,
  provider: RepositoryProvider,
  store: AnalysisStore,
  options?: AnalysisRunOptions,
): Promise<Result<AnalysisJob, AppError>> {
  if (activeAnalyses >= MAX_ACTIVE_ANALYSES) {
    return err(new AppError({ code: "ANALYSIS_BUSY", message: "Too many analyses are already running. Please retry shortly.", retryable: true }));
  }

  activeAnalyses += 1;
  try {
    return await runAnalysisPipeline(reference, provider, store, options);
  } finally {
    activeAnalyses -= 1;
  }
}
