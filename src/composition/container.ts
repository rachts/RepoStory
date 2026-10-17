import { runAnalysis } from "@/application/pipeline";
import { InMemoryAnalysisStore } from "@/application/store";
import { GitHubPublicRepositoryProvider } from "@/infrastructure/providers/github-provider";
import { serverConfig } from "@/shared/config";

const globalContainer = globalThis as typeof globalThis & {
  repoStoryStore?: InMemoryAnalysisStore;
};

export const analysisStore = globalContainer.repoStoryStore ?? new InMemoryAnalysisStore({ maxAnalyses: serverConfig.maxAnalyses, ttlMs: serverConfig.analysisTtlMs });
globalContainer.repoStoryStore = analysisStore;

export const repositoryProvider = new GitHubPublicRepositoryProvider({
  token: serverConfig.githubToken,
});

export { runAnalysis };
