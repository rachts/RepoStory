import { DEFAULT_STORE_LIMITS } from "@/shared/limits";

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const serverConfig = {
  githubToken: process.env.GITHUB_TOKEN,
  maxAnalyses: positiveInteger(process.env.REPO_STORY_MAX_ANALYSES, DEFAULT_STORE_LIMITS.maxAnalyses),
  analysisTtlMs: positiveInteger(process.env.REPO_STORY_ANALYSIS_TTL_MS, DEFAULT_STORE_LIMITS.ttlMs),
};
