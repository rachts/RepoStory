import { stableId, opaqueId } from "@/shared/ids";
import { serverConfig } from "@/shared/config";
import type { RepositoryReference } from "@/domain/repository";
import { AppError } from "@/domain/errors";
import { err, ok, type Result } from "@/shared/result";
import type { AnalysisJobRepository } from "@/application/jobs/analysis-job-repository";

export const SESSION_COOKIE = "repo_story_session";
export const DEFAULT_DAILY_QUOTA = 5;

export function isAnonymousAnalysisEnabled(): boolean {
  if (process.env.ANONYMOUS_ANALYSIS_ENABLED !== undefined) {
    return process.env.ANONYMOUS_ANALYSIS_ENABLED.toLowerCase() === "true";
  }
  return process.env.NODE_ENV !== "production";
}

export function dailyAnalysisQuota(): number {
  const custom = Number(process.env.ANALYSIS_DAILY_QUOTA ?? process.env.REPO_STORY_DAILY_QUOTA);
  return Number.isSafeInteger(custom) && custom > 0 ? custom : DEFAULT_DAILY_QUOTA;
}

export interface RequestIdentity {
  ownerId: string;
  isAuthenticated: boolean;
  isAnonymous: boolean;
  setCookie: boolean;
  anonymousCookieToMigrate?: string;
}

export async function resolveRequestIdentity(
  request: Request,
  analysisRepo?: AnalysisJobRepository,
): Promise<Result<RequestIdentity, AppError>> {
  // Check for authenticated session token/header
  const explicitAuth = request.headers.get("x-user-id")?.trim();
  const authHeader = request.headers.get("authorization")?.trim();
  let bearerUser: string | undefined;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token && (token.startsWith("user_") || token.startsWith("usr_"))) {
      bearerUser = token;
    }
  }

  const cookieHeader = request.headers.get("cookie") || "";
  const nextAuthCookie = cookieHeader.match(/(?:^|;\s*)(?:__Secure-)?next-auth\.session-token=([^;]+)/)?.[1];
  let sessionUser: string | undefined = explicitAuth || bearerUser;
  if (!sessionUser && nextAuthCookie) {
    try {
      const parts = nextAuthCookie.split(".");
      if (parts.length === 3) {
        const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
        const payload = JSON.parse(payloadJson) as { sub?: string; id?: string };
        sessionUser = payload.sub || payload.id;
      }
    } catch {
      // Ignore malformed token
    }
  }

  const anonCookie = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))?.[1];
  const validAnonCookie = anonCookie && /^[A-Za-z0-9_-]{16,128}$/.test(anonCookie) ? anonCookie : undefined;

  if (sessionUser && /^[A-Za-z0-9_-]{1,128}$/.test(sessionUser)) {
    if (validAnonCookie && validAnonCookie !== sessionUser && analysisRepo) {
      try {
        const count = await analysisRepo.migrateAnonymousOwnership(validAnonCookie, sessionUser);
        if (count > 0) {
          console.log(`[Auth Migration] Migrated ${count} jobs from anonymous session ${validAnonCookie} to user ${sessionUser}`);
        }
      } catch (err) {
        console.error("[Auth Migration] Error migrating anonymous jobs:", err);
      }
    }

    return ok({
      ownerId: sessionUser,
      isAuthenticated: true,
      isAnonymous: false,
      setCookie: false,
    });
  }

  if (!isAnonymousAnalysisEnabled()) {
    return err(
      new AppError({
        code: "UNAUTHORIZED",
        message: "Authentication required. Please sign in with GitHub.",
        retryable: false,
      }),
    );
  }

  const existingHeader = request.headers.get("x-repo-story-session")?.trim();
  const existing = (existingHeader && /^[A-Za-z0-9_-]{16,128}$/.test(existingHeader)) ? existingHeader : validAnonCookie;
  if (existing) {
    return ok({
      ownerId: existing,
      isAuthenticated: false,
      isAnonymous: true,
      setCookie: false,
    });
  }

  return ok({
    ownerId: opaqueId("session"),
    isAuthenticated: false,
    isAnonymous: true,
    setCookie: true,
  });
}

export function ownerIdFromRequest(request: Request): { ownerId: string; setCookie: boolean } {
  const explicit = request.headers.get("x-user-id")?.trim();
  if (explicit && /^[A-Za-z0-9_-]{1,128}$/.test(explicit)) return { ownerId: explicit, setCookie: false };
  const header = request.headers.get("x-repo-story-session")?.trim();
  const cookie = request.headers.get("cookie")?.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))?.[1];
  const existing = header || cookie;
  if (existing && /^[A-Za-z0-9_-]{16,128}$/.test(existing)) return { ownerId: existing, setCookie: false };
  return { ownerId: opaqueId("session"), setCookie: true };
}

export function normalizedRepositoryUrl(reference: RepositoryReference): string {
  return `https://github.com/${reference.owner.toLowerCase()}/${reference.name.toLowerCase()}`;
}

export function analysisCacheKey(reference: RepositoryReference): string {
  const branch = reference.branch?.trim() || "default";
  return stableId("analysis-cache", normalizedRepositoryUrl(reference), branch, serverConfig.analyzerVersion, serverConfig.configVersion);
}

export function sessionCookieHeader(ownerId: string): string {
  return `${SESSION_COOKIE}=${ownerId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
}

export async function checkDailyQuota(
  ownerId: string,
  analysisRepo: AnalysisJobRepository,
): Promise<{ allowed: boolean; count: number; limit: number; retryAfterSeconds: number; resetAt: string }> {
  const quota = dailyAnalysisQuota();
  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const endOfDay = new Date(startOfDay.getTime() + 86_400_000);
  const retryAfterSeconds = Math.max(1, Math.ceil((endOfDay.getTime() - now.getTime()) / 1000));

  const count = await analysisRepo.countAnalysesSince(ownerId, startOfDay);
  const allowed = count < quota;

  return {
    allowed,
    count,
    limit: quota,
    retryAfterSeconds,
    resetAt: endOfDay.toISOString(),
  };
}
