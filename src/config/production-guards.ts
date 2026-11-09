import { AppError } from "@/domain/errors";

export function assertProductionGuards(
  customEnv: Record<string, string | undefined> = process.env,
  exitOnError: boolean = process.env.NODE_ENV !== "test",
): void {
  if (customEnv.NODE_ENV !== "production") {
    return;
  }

  // Skip guard enforcement during Next.js build-time static generation
  if (customEnv.NEXT_PHASE === "phase-production-build") {
    return;
  }

  // 1. REPO_STORY_JOB_STORE must be explicitly set in production
  if (!customEnv.REPO_STORY_JOB_STORE) {
    const errorMsg = "[RepoStory Config Error] In production, REPO_STORY_JOB_STORE must be explicitly set ('supabase' or 'memory').";
    console.error(errorMsg);
    if (exitOnError) {
      process.exit(1);
    }
    throw new AppError({
      code: "INVALID_CONFIGURATION",
      message: errorMsg,
      retryable: false,
    });
  }

  // 2. If memory queue or memory store is chosen, explicit bypass flags are required
  if (customEnv.REPO_STORY_JOB_STORE === "memory" || customEnv.REPO_STORY_QUEUE_MODE === "memory") {
    if (customEnv.ALLOW_IN_MEMORY_QUEUE !== "true") {
      const errorMsg = "[RepoStory Config Error] InMemoryJobQueue is not allowed in production unless ALLOW_IN_MEMORY_QUEUE=true is explicitly set.";
      console.error(errorMsg);
      if (exitOnError) {
        process.exit(1);
      }
      throw new AppError({
        code: "INVALID_CONFIGURATION",
        message: errorMsg,
        retryable: false,
      });
    }

    if (customEnv.ALLOW_IN_MEMORY_STORE !== "true") {
      const errorMsg = "[RepoStory Config Error] InMemoryAnalysisStore is not allowed in production unless ALLOW_IN_MEMORY_STORE=true is explicitly set.";
      console.error(errorMsg);
      if (exitOnError) {
        process.exit(1);
      }
      throw new AppError({
        code: "INVALID_CONFIGURATION",
        message: errorMsg,
        retryable: false,
      });
    }
  }

  // 3. If Supabase is chosen, credentials must be present
  if (customEnv.REPO_STORY_JOB_STORE === "supabase" || customEnv.REPO_STORY_QUEUE_MODE === "supabase") {
    const hasSupabaseUrl = Boolean(customEnv.SUPABASE_URL?.trim() || customEnv.NEXT_PUBLIC_SUPABASE_URL?.trim());
    const hasSupabaseKey = Boolean(customEnv.SUPABASE_SECRET_KEY?.trim());

    if (!hasSupabaseUrl || !hasSupabaseKey) {
      const errorMsg = "[RepoStory Config Error] In production with Supabase mode, SUPABASE_URL and SUPABASE_SECRET_KEY are required.";
      console.error(errorMsg);
      if (exitOnError) {
        process.exit(1);
      }
      throw new AppError({
        code: "INVALID_CONFIGURATION",
        message: errorMsg,
        retryable: false,
      });
    }
  }
}
