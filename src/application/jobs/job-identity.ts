import { stableId, opaqueId } from "@/shared/ids";
import { serverConfig } from "@/shared/config";
import type { RepositoryReference } from "@/domain/repository";

export const SESSION_COOKIE = "repo_story_session";

export function ownerIdFromRequest(request: Request): { ownerId: string; setCookie: boolean } {
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
