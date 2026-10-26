import { DEFAULT_LIMITS, DEFAULT_STORE_LIMITS } from "@/shared/limits";

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true";
}

export const serverConfig = {
  githubToken: process.env.GITHUB_TOKEN,
  supabaseUrl: process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(),
  supabaseSecretKey: process.env.SUPABASE_SECRET_KEY?.trim(),
  maxAnalyses: positiveInteger(process.env.REPO_STORY_MAX_ANALYSES, DEFAULT_STORE_LIMITS.maxAnalyses),
  analysisTtlMs: positiveInteger(process.env.REPO_STORY_ANALYSIS_TTL_MS, DEFAULT_STORE_LIMITS.ttlMs),
  groqApiKey: process.env.GROQ_API_KEY,
  groqModel: process.env.GROQ_MODEL?.trim() || "openai/gpt-oss-120b",
  groqTimeoutMs: positiveInteger(process.env.GROQ_TIMEOUT_MS, 30_000),
  groqMaxInputChars: positiveInteger(process.env.GROQ_MAX_INPUT_CHARS, 60_000),
  groqEnabled: booleanValue(process.env.GROQ_ENABLED, true),
  jobStoreMode: process.env.NODE_ENV === "test"
    ? "memory"
    : process.env.REPO_STORY_JOB_STORE === "memory"
      ? "memory"
      : process.env.REPO_STORY_JOB_STORE === "supabase" || Boolean(process.env.SUPABASE_SECRET_KEY?.trim() && (process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()))
        ? "supabase"
        : "file",
  jobStorePath: process.env.REPO_STORY_JOB_STORE_PATH?.trim() || ".repo-story-data/state.json",
  maxConcurrentJobs: positiveInteger(process.env.REPO_STORY_MAX_CONCURRENT_JOBS, 2),
  maxJobRetries: positiveInteger(process.env.REPO_STORY_MAX_JOB_RETRIES, 2),
  jobRetryBackoffMs: positiveInteger(process.env.REPO_STORY_JOB_RETRY_BACKOFF_MS, 250),
  jobTtlMs: positiveInteger(process.env.REPO_STORY_JOB_TTL_MS, DEFAULT_LIMITS.maxAnalysisMs * 20),
  analyzerVersion: process.env.REPO_STORY_ANALYZER_VERSION?.trim() || "phase-async-1",
  configVersion: process.env.REPO_STORY_CONFIG_VERSION?.trim() || "1",
};
