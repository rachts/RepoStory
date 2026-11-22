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
  get githubToken() { return process.env.GITHUB_TOKEN; },
  get supabaseUrl() { return process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(); },
  get supabaseSecretKey() { return process.env.SUPABASE_SECRET_KEY?.trim(); },
  get maxAnalyses() { return positiveInteger(process.env.REPO_STORY_MAX_ANALYSES, DEFAULT_STORE_LIMITS.maxAnalyses); },
  get analysisTtlMs() { return positiveInteger(process.env.REPO_STORY_ANALYSIS_TTL_MS, DEFAULT_STORE_LIMITS.ttlMs); },
  get groqApiKey() { return process.env.GROQ_API_KEY; },
  get groqModel() { return process.env.GROQ_MODEL?.trim() || "openai/gpt-oss-120b"; },
  get groqTimeoutMs() { return positiveInteger(process.env.GROQ_TIMEOUT_MS, 30_000); },
  get groqMaxInputChars() { return positiveInteger(process.env.GROQ_MAX_INPUT_CHARS, 60_000); },
  get groqEnabled() { return booleanValue(process.env.GROQ_ENABLED, true); },
  get jobStoreMode() {
    return process.env.REPO_STORY_JOB_STORE === "file"
      ? "file"
      : process.env.REPO_STORY_JOB_STORE === "memory"
        ? "memory"
        : process.env.REPO_STORY_JOB_STORE === "supabase"
          ? "supabase"
          : (process.env.NODE_ENV === "production" ? "supabase" : "memory");
  },
  get cacheStoreMode() {
    return process.env.REPO_STORY_CACHE_STORE === "memory"
      ? "memory"
      : process.env.REPO_STORY_CACHE_STORE === "supabase"
        ? "supabase"
        : (process.env.NODE_ENV === "production" ? "supabase" : "memory");
  },
  get queueMode() {
    return process.env.REPO_STORY_QUEUE_MODE === "memory"
      ? "memory"
      : process.env.REPO_STORY_QUEUE_MODE === "supabase"
        ? "supabase"
        : (process.env.NODE_ENV === "production" && process.env.ALLOW_IN_MEMORY_QUEUE !== "true" ? "supabase" : "memory");
  },
  get jobStorePath() { return process.env.REPO_STORY_JOB_STORE_PATH?.trim() || ".repo-story-data/state.json"; },
  get maxConcurrentJobs() { return positiveInteger(process.env.REPO_STORY_MAX_CONCURRENT_JOBS, 2); },
  get maxJobRetries() { return positiveInteger(process.env.REPO_STORY_MAX_JOB_RETRIES, 2); },
  get jobRetryBackoffMs() { return positiveInteger(process.env.REPO_STORY_JOB_RETRY_BACKOFF_MS, 250); },
  get maxAnalysisMs() { return positiveInteger(process.env.REPO_STORY_MAX_ANALYSIS_MS, DEFAULT_LIMITS.maxAnalysisMs); },
  get jobTtlMs() { return positiveInteger(process.env.REPO_STORY_JOB_TTL_MS, DEFAULT_LIMITS.maxAnalysisMs * 20); },
  get analyzerVersion() { return process.env.REPO_STORY_ANALYZER_VERSION?.trim() || "phase-async-1"; },
  get configVersion() { return process.env.REPO_STORY_CONFIG_VERSION?.trim() || "1"; },
};
