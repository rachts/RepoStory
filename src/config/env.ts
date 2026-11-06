import { z } from "zod";

function positiveInt(defaultValue: number) {
  return z
    .string()
    .optional()
    .transform((val) => (val ? Number(val) : defaultValue))
    .refine((val) => Number.isSafeInteger(val) && val > 0, {
      message: "Must be a positive safe integer",
    });
}

function bool(defaultValue: boolean) {
  return z
    .string()
    .optional()
    .transform((val) => {
      if (val === undefined) return defaultValue;
      return val.toLowerCase() === "true";
    });
}

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: positiveInt(3000),

    // GitHub Upstream
    GITHUB_TOKEN: z.string().optional(),
    GITHUB_TOKENS: z.string().optional(),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),

    // NextAuth / Auth.js
    NEXTAUTH_SECRET: z.string().optional(),
    AUTH_SECRET: z.string().optional(),
    NEXTAUTH_URL: z.string().optional(),

    // Supabase
    SUPABASE_URL: z.string().optional(),
    SUPABASE_SECRET_KEY: z.string().optional(),
    NEXT_PUBLIC_SUPABASE_URL: z.string().optional(),
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().optional(),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),

    // Analysis and Store Options
    REPO_STORY_MAX_ANALYSES: positiveInt(100),
    REPO_STORY_ANALYSIS_TTL_MS: positiveInt(3_600_000),
    REPO_STORY_JOB_STORE: z.enum(["memory", "file", "supabase"]).optional(),
    REPO_STORY_JOB_STORE_PATH: z.string().default(".repo-story-data/state.json"),
    REPO_STORY_JOB_TTL_MS: positiveInt(3_600_000),
    REPO_STORY_MAX_CONCURRENT_JOBS: positiveInt(2),
    REPO_STORY_MAX_JOB_RETRIES: positiveInt(2),
    REPO_STORY_JOB_RETRY_BACKOFF_MS: positiveInt(250),
    REPO_STORY_ANALYZER_VERSION: z.string().default("phase-async-1"),
    REPO_STORY_CONFIG_VERSION: z.string().default("1"),

    // Safety and bypass flags
    ALLOW_IN_MEMORY_QUEUE: z.string().optional(),
    ALLOW_IN_MEMORY_STORE: z.string().optional(),
    ANONYMOUS_ANALYSIS_ENABLED: z.string().optional(),
    ANALYSIS_DAILY_QUOTA: positiveInt(5),

    // Groq AI
    GROQ_API_KEY: z.string().optional(),
    GROQ_MODEL: z.string().default("openai/gpt-oss-120b"),
    GROQ_TIMEOUT_MS: positiveInt(30_000),
    GROQ_MAX_INPUT_CHARS: positiveInt(60_000),
    GROQ_ENABLED: bool(true),

    // Observability & Rate Limiting
    METRICS_BEARER_TOKEN: z.string().optional(),
    UPSTASH_REDIS_REST_URL: z.string().optional(),
    UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
    CORS_ALLOWED_ORIGINS: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.NODE_ENV === "production") {
      const hasSupabase = Boolean(
        (data.SUPABASE_URL || data.NEXT_PUBLIC_SUPABASE_URL) && data.SUPABASE_SECRET_KEY,
      );
      const allowInMemory =
        data.ALLOW_IN_MEMORY_STORE === "true" && data.ALLOW_IN_MEMORY_QUEUE === "true";

      if (!hasSupabase && !allowInMemory) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "In production, SUPABASE_URL and SUPABASE_SECRET_KEY are required for durable storage and queueing, unless explicitly bypassed with ALLOW_IN_MEMORY_STORE=true and ALLOW_IN_MEMORY_QUEUE=true.",
          path: ["SUPABASE_URL"],
        });
      }

      if (!data.NEXTAUTH_SECRET && !data.AUTH_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "NEXTAUTH_SECRET or AUTH_SECRET is required in production for secure session signing.",
          path: ["NEXTAUTH_SECRET"],
        });
      }
    }
  });

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(customEnv: Record<string, string | undefined> = process.env) {
  const result = envSchema.safeParse(customEnv);
  if (!result.success) {
    const errorMessages = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "CONFIG"}: ${issue.message}`)
      .join("\n");
    const formattedError = `[RepoStory Config Error] Missing or invalid configuration variables:\n${errorMessages}`;
    return { ok: false as const, error: formattedError, issues: result.error.issues };
  }
  return { ok: true as const, env: result.data };
}

export function parseEnvOrExit(customEnv: Record<string, string | undefined> = process.env): EnvConfig {
  const validation = validateEnv(customEnv);
  if (!validation.ok) {
    console.error(validation.error);
    if (customEnv.NODE_ENV !== "test" && process.env.NODE_ENV !== "test") {
      process.exit(1);
    }
    throw new Error(validation.error);
  }
  return validation.env;
}

export const env = parseEnvOrExit();
