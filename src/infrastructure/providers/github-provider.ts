import type { RepositoryProvider, RepositoryReference, RepositorySnapshot, RepositoryFile } from "@/domain/repository";
import { AppError } from "@/domain/errors";
import { err, ok, type Result } from "@/shared/result";
import { DEFAULT_LIMITS, type AnalysisBudget, type AnalysisLimits } from "@/shared/limits";
import { filterFiles } from "@/analysis/filter-files";
import { validateGitHubBranch } from "@/infrastructure/providers/github-url";
import { redactSecrets } from "@/shared/redaction";
import { GitHubTokenPool } from "@/infrastructure/providers/github-token-pool";
import { GitHubCircuitBreaker } from "@/infrastructure/providers/github-circuit-breaker";
import { buildSafeGitHubApiUrl } from "@/infrastructure/providers/github-url-builder";
import type { CacheStore } from "@/application/cache/cache-store";
import { InMemoryCacheStore } from "@/infrastructure/cache/in-memory-cache-store";
import { decodeFileBuffer, detectCaseCollisions, normalizeRepositoryPath, type SkipReason } from "@/analysis/file-decoder";
import { extractRepositoryArchive } from "@/infrastructure/streaming/archive-extractor";
import type { AnalysisCoverage } from "@/domain/analysis";
import { repostoryGitHubRequestsTotal, repostoryGitHubRateLimitErrorsTotal } from "@/shared/metrics";
import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";
import { retry } from "@octokit/plugin-retry";

export const ResilientOctokit = Octokit.plugin(throttling, retry);

export interface GitHubProviderOptions {
  token?: string;
  tokens?: string[] | string;
  fetchImpl?: typeof fetch;
  limits?: AnalysisLimits;
  cacheStore?: CacheStore;
  tokenPool?: GitHubTokenPool;
  circuitBreaker?: GitHubCircuitBreaker;
}

type JsonResult<T> = Result<T, AppError>;
export type GitHubTreeEntry = { path: string; type: string; size?: number; sha?: string; mode?: string };

const RESPONSE_SIZE_DEFAULT = DEFAULT_LIMITS.maxResponseBytes ?? 5_000_000;
const TREE_PATH_LENGTH_DEFAULT = DEFAULT_LIMITS.maxPathLength ?? 4_096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseTooLarge(stage: string, maxBytes: number): AppError {
  return new AppError({
    code: "GITHUB_RESPONSE_TOO_LARGE",
    message: `GitHub ${stage} response exceeds the configured size limit.`,
    details: { stage, maxBytes },
  });
}

function invalidResponse(stage: string): AppError {
  return new AppError({ code: "GITHUB_INVALID_RESPONSE", message: `GitHub ${stage} response was invalid.` });
}

function treeTooLarge(maxEntries: number): AppError {
  return new AppError({ code: "REPOSITORY_TOO_LARGE", message: "GitHub repository tree contains too many entries to analyze safely.", details: { maxEntries } });
}

function responseFailure(response: Response, stage: string): AppError {
  if (response.status === 401) {
    return new AppError({ code: "GITHUB_AUTH_FAILED", message: "GitHub rejected the configured token. Remove GITHUB_TOKEN for anonymous public access or configure a valid token.", retryable: false });
  }
  if (response.status === 429 || (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.get("retry-after")))) {
    const reset = response.headers.get("x-ratelimit-reset");
    const retryAfter = response.headers.get("retry-after");
    const resetEpoch = reset && /^\d+$/.test(reset)
      ? Number(reset)
      : retryAfter && /^\d+$/.test(retryAfter)
        ? Math.floor(Date.now() / 1000) + Number(retryAfter)
        : Math.floor(Date.now() / 1000) + 60;
    return new AppError({
      code: "GITHUB_RATE_LIMITED",
      message: "GitHub API rate limit reached. Add GITHUB_TOKEN or retry after the limit resets.",
      retryable: true,
      details: { resetAt: resetEpoch, retryAt: new Date(resetEpoch * 1000).toISOString() },
    });
  }
  if (response.status === 403) {
    return new AppError({ code: "REPOSITORY_INACCESSIBLE", message: `GitHub denied access to the ${stage} request. Confirm the repository is public and the configured token has access.`, retryable: false });
  }
  return new AppError({
    code: "REPOSITORY_INACCESSIBLE",
    message: `GitHub ${stage} request failed (${response.status}).`,
    retryable: response.status >= 500,
  });
}

function contentTooLarge(maxBytes: number): AppError {
  return new AppError({ code: "GITHUB_CONTENT_TOO_LARGE", message: "GitHub file content exceeds the configured size limit.", details: { maxBytes } });
}

function invalidContent(message = "GitHub file content was invalid."): AppError {
  return new AppError({ code: "GITHUB_INVALID_CONTENT", message });
}

function hasTraversalSegment(segment: string): boolean {
  if (segment === "." || segment === "..") return true;
  let candidate = segment;
  for (let attempt = 0; attempt < 2 && candidate.includes("%"); attempt += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      return false;
    }
    if (decoded === candidate) return false;
    candidate = decoded;
    if (candidate === "." || candidate === "..") return true;
  }
  return false;
}

function validateTreePath(path: unknown, maxPathLength: number): JsonResult<string> {
  if (typeof path !== "string" || path.length === 0) return err(new AppError({ code: "GITHUB_INVALID_PATH", message: "GitHub tree contains an invalid path." }));
  if (Buffer.byteLength(path, "utf8") > maxPathLength) {
    return err(new AppError({ code: "GITHUB_PATH_TOO_LONG", message: "GitHub tree path exceeds the configured length limit.", details: { maxPathLength } }));
  }
  if (path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:[\\/]/.test(path)) {
    return err(new AppError({ code: "GITHUB_INVALID_PATH", message: "GitHub tree contains an unsafe path." }));
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || hasTraversalSegment(segment))) {
    return err(new AppError({ code: "GITHUB_INVALID_PATH", message: "GitHub tree contains an unsafe path." }));
  }
  return ok(path);
}

function encodeGitHubPath(path: string): string {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function candidatePriority(path: string): number {
  const normalized = path.toLowerCase();
  if (/^(package\.json|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml|build\.gradle|composer\.json|gemfile|dockerfile|makefile)$/.test(normalized)) return 0;
  if (/(^|\/)(app|src|server|api|routes|controllers|services|lib|prisma)(\/|$)/.test(normalized)) return 1;
  if (/(route|controller|handler|schema|openapi|graphql|\.env\.(example|sample|template)$)/.test(normalized)) return 2;
  if (/\.(tsx?|jsx?|py|go|rs|java|kt|rb|php|swift|vue|svelte|astro|graphql|gql|mjs|cjs|mts|cts)$/.test(normalized)) return 3;
  if (/\.(md|json|yml|yaml|toml|sql|prisma|css|scss)$/.test(normalized)) return 4;
  return 5;
}

function maxConcurrentRequests(limits: AnalysisLimits): number {
  const envVal = Number(process.env.MAX_CONCURRENT_GITHUB_CONTENT_REQUESTS);
  if (Number.isSafeInteger(envVal) && envVal > 0) return Math.min(envVal, 16);
  const value = limits.maxConcurrentGitHubContentRequests ?? limits.maxConcurrentContentRequests ?? DEFAULT_LIMITS.maxConcurrentContentRequests;
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 16) : DEFAULT_LIMITS.maxConcurrentContentRequests;
}

async function readResponseText(response: Response, stage: string, maxBytes: number, budget?: AnalysisBudget): Promise<JsonResult<string>> {
  budget?.check();
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) return err(responseTooLarge(stage, maxBytes));
  }

  try {
    if (!response.body) {
      const text = await response.text();
      budget?.check();
      if (Buffer.byteLength(text, "utf8") > maxBytes) return err(responseTooLarge(stage, maxBytes));
      return ok(text);
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        budget?.check();
        const result = await reader.read();
        budget?.check();
        if (result.done) break;
        const chunk = result.value;
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // The size-limit error is the useful result even if cancellation fails.
          }
          return err(responseTooLarge(stage, maxBytes));
        }
        chunks.push(chunk);
        budget?.check();
      }
    } catch (error) {
      if (error instanceof AppError && error.code === "ANALYSIS_TIMEOUT") {
        try {
          await reader.cancel();
        } catch {
          // The timeout result is the useful result even if cancellation fails.
        }
      }
      throw error;
    } finally {
      reader.releaseLock();
    }

    budget?.check();
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      budget?.check();
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    budget?.check();
    const text = new TextDecoder().decode(bytes);
    budget?.check();
    return ok(text);
  } catch (error) {
    if (error instanceof AppError) return err(error);
    return err(new AppError({ code: "GITHUB_RESPONSE_READ_FAILED", message: `Unable to read GitHub ${stage} response.`, retryable: true }));
  }
}

async function readJsonResponse<T>(response: Response, stage: string, maxBytes: number, budget?: AnalysisBudget): Promise<JsonResult<T>> {
  const body = await readResponseText(response, stage, maxBytes, budget);
  if (!body.ok) return body;
  budget?.check();
  let parsed: T;
  try {
    parsed = JSON.parse(body.value) as T;
  } catch {
    return err(invalidResponse(stage));
  }
  budget?.check();
  return ok(parsed);
}

function isStrictBase64(value: string): boolean {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (padding > 0 && value.length % 4 !== 0) return false;
  const dataLength = value.length - padding;
  if (dataLength % 4 === 1) return false;
  if (padding === 1 && dataLength % 4 !== 3) return false;
  if (padding === 2 && dataLength % 4 !== 2) return false;
  return true;
}

function decodeGitHubContent(encoded: string, maxBytes: number): JsonResult<{ content: string } | { skipped: true; reason: SkipReason }> {
  const compact = encoded.replace(/\s/g, "");
  if (!isStrictBase64(compact)) return err(invalidContent("GitHub file content was not valid base64."));

  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  const expectedBytes = Math.floor((compact.length * 3) / 4) - padding;
  if (expectedBytes > maxBytes) return err(contentTooLarge(maxBytes));

  try {
    const padded = compact.padEnd(Math.ceil(compact.length / 4) * 4, "=");
    const decoded = Buffer.from(padded, "base64");
    if (decoded.byteLength > maxBytes || decoded.byteLength !== expectedBytes) return err(contentTooLarge(maxBytes));

    const decodedFile = decodeFileBuffer(decoded, {
      fetchLfs: process.env.FETCH_LFS === "true",
      maxLfsBytes: Number(process.env.MAX_LFS_BYTES) || 5 * 1024 * 1024,
    });
    if (!decodedFile.ok) {
      return ok({ skipped: true, reason: decodedFile.reason ?? "unsupported-encoding" });
    }
    return ok({ content: decodedFile.content ?? "" });
  } catch {
    return err(invalidContent("GitHub file content was not valid base64."));
  }
}

export interface DebugRequestProfile {
  total: number;
  byEndpoint: {
    "/repos": number;
    "/git/trees": number;
    "/contents": number;
    "/git/blobs": number;
    "/compare": number;
    other: number;
  };
}

let debugRequestProfile: DebugRequestProfile = {
  total: 0,
  byEndpoint: {
    "/repos": 0,
    "/git/trees": 0,
    "/contents": 0,
    "/git/blobs": 0,
    "/compare": 0,
    other: 0,
  },
};

export function getDebugRequestProfile(): DebugRequestProfile {
  return structuredClone(debugRequestProfile);
}

export function resetDebugRequestProfile(): void {
  debugRequestProfile = {
    total: 0,
    byEndpoint: {
      "/repos": 0,
      "/git/trees": 0,
      "/contents": 0,
      "/git/blobs": 0,
      "/compare": 0,
      other: 0,
    },
  };
}

export class GitHubPublicRepositoryProvider implements RepositoryProvider {
  public readonly octokit: InstanceType<typeof ResilientOctokit>;
  private readonly fetchImpl: typeof fetch;
  private readonly limits: AnalysisLimits;
  public readonly tokenPool: GitHubTokenPool;
  public readonly circuitBreaker: GitHubCircuitBreaker;
  public readonly cacheStore: CacheStore;

  public constructor(options: GitHubProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.limits = options.limits ?? DEFAULT_LIMITS;
    this.tokenPool = options.tokenPool ?? new GitHubTokenPool(options.tokens || options.token);
    this.circuitBreaker = options.circuitBreaker ?? new GitHubCircuitBreaker();
    this.cacheStore = options.cacheStore ?? new InMemoryCacheStore();

    const safeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const mergedInit: RequestInit = {
        ...init,
        redirect: "manual",
        cache: "no-store",
      };
      return this.fetchImpl(input, mergedInit);
    };

    const isTest = process.env.NODE_ENV === "test";

    this.octokit = new ResilientOctokit({
      request: {
        fetch: safeFetch,
      },
      throttle: {
        enabled: !isTest,
        onRateLimit: () => false,
        onSecondaryRateLimit: () => false,
      },
      retry: {
        retries: 0,
        doNotRetry: [400, 401, 403, 404, 422, 429, 500, 502, 503, 504],
      },
    });
  }

  private async dispatch(initialUrl: URL, fetchOptions: RequestInit, stage: string, budget?: AnalysisBudget): Promise<Response> {
    const maxAttempts = 3;
    let attempt = 0;
    let currentUrl = initialUrl;
    let redirectCount = 0;
    const maxRedirects = 3;

    while (true) {
      attempt += 1;
      budget?.check();
      this.circuitBreaker.check();

      // Ensure the URL is valid and targets api.github.com, or codeload.github.com for archive
      const isApiGithub = currentUrl.hostname.toLowerCase() === "api.github.com";
      const isCodeload = currentUrl.hostname.toLowerCase() === "codeload.github.com";

      const isHostPermitted =
        currentUrl.protocol === "https:" &&
        ((isApiGithub &&
          (currentUrl.pathname.startsWith("/repos/") ||
            currentUrl.pathname.startsWith("/repositories/") ||
            currentUrl.pathname === "/zen")) ||
          (stage === "archive" && isCodeload));

      if (!isHostPermitted) {
        throw new AppError({
          code: "REPOSITORY_INACCESSIBLE",
          message: "GitHub URL must target api.github.com/repos/.",
          retryable: false,
        });
      }

      const token = this.tokenPool.getBestToken();
      const headers: Record<string, string> = {
        accept: stage === "archive" ? "application/x-gzip, application/octet-stream, */*" : "application/vnd.github+json",
      };
      if (fetchOptions.headers) {
        new Headers(fetchOptions.headers).forEach((val, key) => {
          headers[key] = val;
        });
      }
      if (token && !isCodeload) {
        headers["authorization"] = `Bearer ${token}`;
      }

      let response: Response;

      if (stage === "archive") {
        const safeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const mergedInit: RequestInit = {
            ...init,
            redirect: "manual",
            cache: "no-store",
          };
          return this.fetchImpl(input, mergedInit);
        };

        try {
          response = await safeFetch(currentUrl.toString(), {
            ...fetchOptions,
            headers,
            redirect: "manual",
          });
        } catch (error: unknown) {
          throw new AppError({
            code: "REPOSITORY_INACCESSIBLE",
            message: `GitHub ${stage} request failed: ${error instanceof Error ? error.message : "network failure"}.`,
            retryable: true,
          });
        }
      } else {
        let octokitStatus: number;
        let octokitHeaders: Record<string, string>;
        let octokitBody: string;

        try {
          const octokitResult = await this.octokit.request(`GET ${currentUrl.toString()}`, {
            headers,
            request: {
              signal: fetchOptions.signal ?? undefined,
              redirect: "manual",
            },
          });
          octokitStatus = octokitResult.status;
          octokitHeaders = octokitResult.headers as Record<string, string>;
          octokitBody = typeof octokitResult.data === "string" ? octokitResult.data : JSON.stringify(octokitResult.data);
        } catch (error: unknown) {
          if (error && typeof error === "object" && "status" in error && "response" in error) {
            const resp = (error as { status: unknown; response?: { headers?: unknown; data?: unknown } }).response;
            octokitStatus = Number((error as { status: unknown }).status);
            octokitHeaders = (resp?.headers ?? {}) as Record<string, string>;
            octokitBody = typeof resp?.data === "string" ? resp.data : JSON.stringify(resp?.data ?? {});
          } else {
            throw error;
          }
        }

        const responseHeaders = new Headers(octokitHeaders);
        response = new Response(octokitBody, {
          status: octokitStatus,
          headers: responseHeaders,
        });
      }

      repostoryGitHubRequestsTotal.inc({ endpoint: stage, status: String(response.status) });

      if (process.env.REPO_STORY_DEBUG_REQUESTS === "1") {
        debugRequestProfile.total += 1;
        const pathname = currentUrl.pathname;
        if (pathname.includes("/git/trees")) {
          debugRequestProfile.byEndpoint["/git/trees"] += 1;
        } else if (pathname.includes("/contents")) {
          debugRequestProfile.byEndpoint["/contents"] += 1;
        } else if (pathname.includes("/git/blobs")) {
          debugRequestProfile.byEndpoint["/git/blobs"] += 1;
        } else if (pathname.includes("/compare")) {
          debugRequestProfile.byEndpoint["/compare"] += 1;
        } else if (pathname.startsWith("/repos/") || pathname.startsWith("/repositories/")) {
          debugRequestProfile.byEndpoint["/repos"] += 1;
        } else {
          debugRequestProfile.byEndpoint.other += 1;
        }
      }

      this.tokenPool.updateRateLimit(
        token,
        response.headers.get("x-ratelimit-remaining"),
        response.headers.get("x-ratelimit-reset"),
      );

      // Handle 3xx redirects securely (allow api.github.com redirects, reject cross-host escapes, allow codeload ONLY for archive)
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new AppError({
            code: "REPOSITORY_INACCESSIBLE",
            message: "GitHub redirect response missing Location header.",
            retryable: false,
          });
        }

        let locUrl: URL;
        try {
          locUrl = new URL(location, currentUrl);
        } catch {
          throw new AppError({
            code: "REPOSITORY_INACCESSIBLE",
            message: "GitHub redirected to an invalid URL.",
            retryable: false,
          });
        }

        const isRedirectAllowed =
          locUrl.protocol === "https:" &&
          (locUrl.hostname.toLowerCase() === "api.github.com" ||
            (stage === "archive" && locUrl.hostname.toLowerCase() === "codeload.github.com"));

        if (!isRedirectAllowed) {
          throw new AppError({
            code: "REPOSITORY_INACCESSIBLE",
            message: "GitHub redirected to an unauthorized external host.",
            retryable: false,
          });
        }

        if (redirectCount >= maxRedirects) {
          throw new AppError({
            code: "REPOSITORY_INACCESSIBLE",
            message: "GitHub redirected too many times.",
            retryable: false,
          });
        }

        redirectCount += 1;
        currentUrl = locUrl;
        continue;
      }

      const isRateLimited = response.status === 429 || (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.get("retry-after")));

      if (isRateLimited) {
        repostoryGitHubRateLimitErrorsTotal.inc();
        const reset = response.headers.get("x-ratelimit-reset");
        const retryAfter = response.headers.get("retry-after");
        const resetEpoch = reset && /^\d+$/.test(reset)
          ? Number(reset)
          : retryAfter && /^\d+$/.test(retryAfter)
            ? Math.floor(Date.now() / 1000) + Number(retryAfter)
            : Math.floor(Date.now() / 1000) + 60;

        this.tokenPool.markExhausted(token, resetEpoch);
        try {
          this.circuitBreaker.recordRateLimitFailure(resetEpoch);
        } catch {
          // Circuit breaker tripped after reaching threshold
          return response;
        }

        if (attempt < maxAttempts && !this.circuitBreaker.isOpen()) {
          const backoffMs = retryAfter && /^\d+$/.test(retryAfter)
            ? Math.min(Number(retryAfter) * 1000, 100)
            : Math.min(50 * 2 ** (attempt - 1), 100);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }

        return response;
      }

      if (response.ok) {
        this.circuitBreaker.recordSuccess();
      }

      return response;
    }
  }

  public async getSnapshot(
    reference: RepositoryReference,
    signal?: AbortSignal,
    budget?: AnalysisBudget,
    onProgress?: (progress: { stage: string; progress: number; message: string }) => void,
  ): Promise<Result<RepositorySnapshot, AppError>> {
    const fetchOptions: RequestInit = { signal, cache: "no-store" };
    const responseLimit = this.limits.maxResponseBytes ?? RESPONSE_SIZE_DEFAULT;
    const pathLimit = this.limits.maxPathLength ?? TREE_PATH_LENGTH_DEFAULT;

    const coverageDetails: Array<{ path: string; reason: SkipReason; details?: string }> = [];
    const skippedByReason = {
      tooLarge: 0,
      unsupported: 0,
      limitReached: 0,
      lfsPointer: 0,
      submodule: 0,
      unsupportedEncoding: 0,
      pathCollision: 0,
    };
    const warnings: string[] = [];

    try {
      budget?.check();
      onProgress?.({ stage: "fetch-metadata", progress: 10, message: "Reading repository metadata" });
      const metaUrl = buildSafeGitHubApiUrl(reference.owner, reference.name);
      const metaResponse = await this.dispatch(metaUrl, fetchOptions, "metadata", budget);
      if (!metaResponse.ok) {
        if (metaResponse.status === 404) return err(new AppError({ code: "REPOSITORY_NOT_FOUND", message: "GitHub repository not found." }));
        return err(responseFailure(metaResponse, "metadata"));
      }

      const metadataResult = await readJsonResponse<Record<string, unknown>>(metaResponse, "metadata", responseLimit, budget);
      if (!metadataResult.ok) return metadataResult;
      const metadata = metadataResult.value;
      if (!isRecord(metadata) || typeof metadata.default_branch !== "string") return err(invalidResponse("metadata"));

      const branchResult = validateGitHubBranch(reference.branch ?? metadata.default_branch);
      if (!branchResult.ok) return branchResult;
      const branch = branchResult.value;

      const branchCacheKey = `${reference.owner.toLowerCase()}/${reference.name.toLowerCase()}@${branch}:tree`;
      let treeEntries = await this.cacheStore.get<GitHubTreeEntry[]>(branchCacheKey);
      let commitSha = branch;
      let isTruncated = false;

      if (!treeEntries) {
        budget?.check();
        onProgress?.({ stage: "fetch-tree", progress: 25, message: "Reading repository file tree" });
        const treeUrl = buildSafeGitHubApiUrl(reference.owner, reference.name, `git/trees/${encodeURIComponent(branch)}`, { recursive: "1" });
        const treeResponse = await this.dispatch(treeUrl, fetchOptions, "tree", budget);
        if (!treeResponse.ok) return err(responseFailure(treeResponse, "tree"));

        const treeResult = await readJsonResponse<Record<string, unknown>>(treeResponse, "tree", responseLimit, budget);
        if (!treeResult.ok) return treeResult;
        const treePayload = treeResult.value;
        if (!isRecord(treePayload)) return err(invalidResponse("tree"));
        if (typeof treePayload.sha === "string") {
          commitSha = treePayload.sha;
        }
        isTruncated = treePayload.truncated === true;
        let rawTreeEntries: unknown[] = Array.isArray(treePayload.tree) ? treePayload.tree : [];

        if (isTruncated) {
          warnings.push("GitHub repository tree was truncated. Attempting top-level subtree resolution.");
          try {
            const rootTreeUrl = buildSafeGitHubApiUrl(reference.owner, reference.name, `git/trees/${encodeURIComponent(branch)}`);
            const rootTreeResponse = await this.dispatch(rootTreeUrl, fetchOptions, "root-tree", budget);
            if (rootTreeResponse.ok) {
              const rootTreeResult = await readJsonResponse<Record<string, unknown>>(rootTreeResponse, "root-tree", responseLimit, budget);
              if (rootTreeResult.ok && isRecord(rootTreeResult.value) && Array.isArray(rootTreeResult.value.tree)) {
                const mergedTree: unknown[] = [];
                let anySubtreeFailed = false;

                for (const item of rootTreeResult.value.tree) {
                  budget?.check();
                  if (!isRecord(item)) continue;
                  if (item.type === "blob") {
                    mergedTree.push(item);
                  } else if (item.type === "tree" && typeof item.path === "string" && typeof item.sha === "string") {
                    try {
                      budget?.check();
                      const subTreeUrl = buildSafeGitHubApiUrl(reference.owner, reference.name, `git/trees/${encodeURIComponent(item.sha)}`, { recursive: "1" });
                      const subResponse = await this.dispatch(subTreeUrl, fetchOptions, "subtree", budget);
                      if (subResponse.ok) {
                        const subResult = await readJsonResponse<Record<string, unknown>>(subResponse, "subtree", responseLimit, budget);
                        if (subResult.ok && isRecord(subResult.value) && Array.isArray(subResult.value.tree)) {
                          for (const subItem of subResult.value.tree) {
                            if (isRecord(subItem) && typeof subItem.path === "string") {
                              mergedTree.push({
                                ...subItem,
                                path: `${item.path}/${subItem.path}`,
                              });
                            }
                          }
                        } else {
                          anySubtreeFailed = true;
                        }
                      } else {
                        anySubtreeFailed = true;
                      }
                    } catch {
                      anySubtreeFailed = true;
                    }
                  }
                }

                if (mergedTree.length > 0) {
                  rawTreeEntries = mergedTree;
                  if (anySubtreeFailed) {
                    warnings.push("One or more subtrees failed to fetch. Partial tree analyzed.");
                  } else {
                    isTruncated = false;
                  }
                }
              }
            } else {
              warnings.push("Top-level tree request failed. Analyzing partial tree.");
            }
          } catch {
            warnings.push("Failed to fetch subtrees for truncated repository. Analyzing partial tree.");
          }

          if (rawTreeEntries.length === 0) {
            return err(new AppError({ code: "GITHUB_TREE_TRUNCATED", message: "GitHub repository tree was truncated and cannot be analyzed safely." }));
          }
        }

        const configuredMaxTreeEntries = this.limits.maxTreeEntries;
        const ceiling = this.limits.maxTreeEntriesCeiling ?? (configuredMaxTreeEntries !== undefined && configuredMaxTreeEntries < 1000 ? configuredMaxTreeEntries : 100_000);
        budget?.check();
        if (rawTreeEntries.length > ceiling) return err(treeTooLarge(ceiling));

        const effectiveMaxTreeEntries = typeof configuredMaxTreeEntries === "number" && configuredMaxTreeEntries < 1000
          ? configuredMaxTreeEntries
          : Math.min(ceiling, Math.max(this.limits.maxFiles ?? 2000, 10_000));

        treeEntries = [];
        for (const rawEntry of rawTreeEntries) {
          budget?.check();
          if (!isRecord(rawEntry) || typeof rawEntry.path !== "string" || typeof rawEntry.type !== "string") return err(invalidResponse("tree"));
          if (rawEntry.size !== undefined && (typeof rawEntry.size !== "number" || !Number.isSafeInteger(rawEntry.size) || rawEntry.size < 0)) return err(invalidResponse("tree"));
          const pathResult = validateTreePath(rawEntry.path, pathLimit);
          if (!pathResult.ok) return pathResult;
          const normalizedPath = normalizeRepositoryPath(pathResult.value);

          // Submodule detection (mode 160000 or commit type)
          if (rawEntry.mode === "160000" || rawEntry.type === "commit") {
            coverageDetails.push({ path: normalizedPath, reason: "submodule" });
            skippedByReason.submodule += 1;
            continue;
          }

          if (rawEntry.type !== "blob") continue;

          if (treeEntries.length >= effectiveMaxTreeEntries) {
            coverageDetails.push({ path: normalizedPath, reason: "limit-reached" });
            skippedByReason.limitReached += 1;
            continue;
          }

          treeEntries.push({
            path: normalizedPath,
            type: rawEntry.type,
            mode: typeof rawEntry.mode === "string" ? rawEntry.mode : undefined,
            ...(rawEntry.size !== undefined ? { size: rawEntry.size } : {}),
            ...(typeof rawEntry.sha === "string" ? { sha: rawEntry.sha } : {}),
          });
        }
        await this.cacheStore.set(branchCacheKey, treeEntries, 3_600_000);
        if (commitSha !== branch) {
          await this.cacheStore.set(`${reference.owner.toLowerCase()}/${reference.name.toLowerCase()}@${commitSha}:tree`, treeEntries, 3_600_000);
        }
      }

      budget?.check();
      const { collisions, warnings: collisionWarnings, safePaths } = detectCaseCollisions(treeEntries.map((e) => e.path));
      for (const col of collisions) {
        coverageDetails.push({ path: col.path, reason: "path-collision" });
        skippedByReason.pathCollision += 1;
      }
      warnings.push(...collisionWarnings);

      const candidateInputs: RepositoryFile[] = [];
      for (const entry of treeEntries) {
        budget?.check();
        if (entry.type === "blob" && safePaths.has(entry.path)) {
          candidateInputs.push({ path: entry.path, type: "file", sizeBytes: entry.size ?? 0, isAnalyzable: true });
        }
      }
      budget?.check();
      const candidates = filterFiles(candidateInputs, this.limits, budget)
        .sort((a, b) => candidatePriority(a.path) - candidatePriority(b.path) || a.path.localeCompare(b.path));
      budget?.check();

      let files: RepositoryFile[] = [];
      let usedFallbackContentFetch = false;
      let contentFetchStrategy: "archive" | "per-file" = "archive";
      const forcePerFile = process.env.REPO_STORY_FORCE_PER_FILE_FETCH === "true";
      const candidatePathsSet = new Set(candidates.map((c) => c.path));
      let archiveSucceeded = false;

      if (!forcePerFile && candidates.length > 0) {
        onProgress?.({ stage: "fetch-archive", progress: 45, message: "Downloading and decompressing archive content" });
        try {
          budget?.check();
          const archiveUrl = buildSafeGitHubApiUrl(
            reference.owner,
            reference.name,
            `tarball/${encodeURIComponent(commitSha)}`,
          );
          const archiveResponse = await this.dispatch(archiveUrl, fetchOptions, "archive", budget);

          if (archiveResponse.ok && archiveResponse.body) {
            const extracted = await extractRepositoryArchive({
              stream: archiveResponse.body,
              candidatePaths: candidatePathsSet,
              limits: this.limits,
              budget,
              cacheStore: this.cacheStore,
              cacheKeyPrefix: `${reference.owner.toLowerCase()}/${reference.name.toLowerCase()}@${commitSha}:content:`,
              signal,
            });

            if (extracted.files.length > 0 || candidates.length === 0) {
              files = extracted.files;
              coverageDetails.push(...extracted.coverageDetails);
              skippedByReason.tooLarge += extracted.skippedByReason.tooLarge;
              skippedByReason.unsupported += extracted.skippedByReason.unsupported;
              skippedByReason.limitReached += extracted.skippedByReason.limitReached;
              skippedByReason.lfsPointer += extracted.skippedByReason.lfsPointer;
              skippedByReason.submodule += extracted.skippedByReason.submodule;
              skippedByReason.unsupportedEncoding += extracted.skippedByReason.unsupportedEncoding;
              skippedByReason.pathCollision += extracted.skippedByReason.pathCollision;

              const handledPaths = new Set(files.map((f) => f.path));
              for (const detail of extracted.coverageDetails) {
                handledPaths.add(detail.path);
              }
              for (const cand of candidates) {
                if (!handledPaths.has(cand.path)) {
                  coverageDetails.push({ path: cand.path, reason: "unsupported" });
                  skippedByReason.unsupported += 1;
                }
              }

              archiveSucceeded = true;
              contentFetchStrategy = "archive";
            } else {
              warnings.push("Archive extraction yielded 0 files. Falling back to per-file fetch.");
            }
          } else {
            warnings.push(`Archive endpoint returned status ${archiveResponse.status}. Falling back to per-file fetch.`);
          }
        } catch (archiveError) {
          if (archiveError instanceof AppError && archiveError.code === "ANALYSIS_TIMEOUT") {
            throw archiveError;
          }
          warnings.push(`Archive fetch failed: ${archiveError instanceof Error ? archiveError.message : "unknown error"}. Falling back to per-file fetch.`);
        }
      }

      if (!archiveSucceeded && candidates.length > 0) {
        usedFallbackContentFetch = true;
        contentFetchStrategy = "per-file";
        let fetchedBytes = 0;
        let nextIndex = 0;

        const worker = async (): Promise<JsonResult<null>> => {
          while (true) {
            budget?.check();
            const index = nextIndex++;
            const item = candidates[index];
            if (!item) return ok(null);
            const itemSize = item.sizeBytes ?? 0;
            if (itemSize > this.limits.maxContentBytes) {
              coverageDetails.push({ path: item.path, reason: "too-large" });
              skippedByReason.tooLarge += 1;
              continue;
            }

            const mem = process.memoryUsage().heapUsed;
            const maxHeapBytes = Number(process.env.MAX_HEAP_BYTES) || 512 * 1024 * 1024;
            if (mem > maxHeapBytes) {
              coverageDetails.push({ path: item.path, reason: "limit-reached", details: "Memory budget reached" });
              skippedByReason.limitReached += 1;
              continue;
            }

            const fileCacheKey = `${reference.owner.toLowerCase()}/${reference.name.toLowerCase()}@${commitSha}:content:${item.path}`;
            const cachedContent = await this.cacheStore.get<string>(fileCacheKey);

            let content: string;
            if (cachedContent !== undefined) {
              content = cachedContent;
            } else {
              budget?.check();
              const contentUrl = buildSafeGitHubApiUrl(reference.owner, reference.name, `contents/${encodeGitHubPath(item.path)}`, { ref: commitSha });
              const contentResponse = await this.dispatch(contentUrl, fetchOptions, "content", budget);
              if (!contentResponse.ok) return err(responseFailure(contentResponse, "content"));

              const contentResult = await readJsonResponse<Record<string, unknown>>(contentResponse, "content", responseLimit, budget);
              if (!contentResult.ok) return contentResult;
              const payload = contentResult.value;
              if (!isRecord(payload) || typeof payload.content !== "string" || payload.encoding !== "base64") return err(invalidContent());

              const decodedResult = decodeGitHubContent(payload.content, this.limits.maxContentBytes);
              if (!decodedResult.ok) {
                if (decodedResult.error.code === "GITHUB_CONTENT_TOO_LARGE") {
                  coverageDetails.push({ path: item.path, reason: "too-large" });
                  skippedByReason.tooLarge += 1;
                  continue;
                }
                return decodedResult;
              }
              if ("skipped" in decodedResult.value) {
                const reason = decodedResult.value.reason;
                coverageDetails.push({ path: item.path, reason });
                if (reason === "lfs-pointer") skippedByReason.lfsPointer += 1;
                else if (reason === "unsupported-encoding") skippedByReason.unsupportedEncoding += 1;
                else if (reason === "too-large") skippedByReason.tooLarge += 1;
                continue;
              }
              content = decodedResult.value.content;
              await this.cacheStore.set(fileCacheKey, content, 3_600_000);
            }

            const actualBytes = Buffer.byteLength(content, "utf8");
            if (fetchedBytes + actualBytes > this.limits.maxTotalBytes) {
              coverageDetails.push({ path: item.path, reason: "limit-reached", details: "Total bytes limit reached" });
              skippedByReason.limitReached += 1;
              continue;
            }
            fetchedBytes += actualBytes;
            files.push({ path: item.path, type: "file", sizeBytes: itemSize || actualBytes, content, isAnalyzable: true });
          }
        };

        const workers = Array.from({ length: Math.min(maxConcurrentRequests(this.limits), candidates.length) }, () => worker());
        const results = await Promise.all(workers);
        const failed = results.find((result) => !result.ok);
        if (failed && !failed.ok) return failed;
      }
      files.sort((a, b) => a.path.localeCompare(b.path));

      const totalDiscovered = treeEntries.length + coverageDetails.length;
      const filesAnalyzed = files.length;
      const analyzedPercent = totalDiscovered > 0 ? Math.round((filesAnalyzed / totalDiscovered) * 100) : 100;

      Object.assign(files, {
        [Symbol.asyncIterator]: async function* () {
          for (const f of files) {
            yield f;
          }
        },
      });

      const snapshotCoverage: AnalysisCoverage = {
        filesConsidered: files.length,
        filesSkipped: Math.max(0, totalDiscovered - files.length),
        filesSkippedByReason: {
          tooLarge: skippedByReason.tooLarge,
          unsupported: skippedByReason.unsupported,
          limitReached: skippedByReason.limitReached,
          ...(skippedByReason.lfsPointer > 0 ? { lfsPointer: skippedByReason.lfsPointer } : {}),
          ...(skippedByReason.submodule > 0 ? { submodule: skippedByReason.submodule } : {}),
          ...(skippedByReason.unsupportedEncoding > 0 ? { unsupportedEncoding: skippedByReason.unsupportedEncoding } : {}),
          ...(skippedByReason.pathCollision > 0 ? { pathCollision: skippedByReason.pathCollision } : {}),
        },
        filesSkippedDetails: coverageDetails,
        skippedFiles: coverageDetails.map((d) => ({ path: d.path, reason: d.reason })),
        warnings,
        analyzedPercent,
        treeTruncated: isTruncated,
        analysisConfidence: files.length === totalDiscovered ? "high" : files.length >= totalDiscovered * 0.5 ? "medium" : "low",
        usedFallbackContentFetch,
        contentFetchStrategy,
      };

      const id = typeof metadata.id === "number" || typeof metadata.id === "string" ? String(metadata.id) : `${reference.owner}/${reference.name}`;
      const repositoryUrl = `https://github.com/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.name)}`;
      const repository = {
        id,
        owner: reference.owner,
        name: reference.name,
        url: repositoryUrl,
        defaultBranch: metadata.default_branch,
        selectedBranch: branch,
        commitSha,
        ...(typeof metadata.description === "string" ? { description: redactSecrets(metadata.description) } : {}),
        sizeBytes: typeof metadata.size === "number" && Number.isSafeInteger(metadata.size) && metadata.size >= 0 && metadata.size <= Number.MAX_SAFE_INTEGER / 1024 ? metadata.size * 1024 : 0,
        fileCount: files.length,
      };
      return ok({ repository, files, coverage: snapshotCoverage });
    } catch (error) {
      if (error instanceof AppError) return err(error);
      if (signal?.aborted) return err(new AppError({ code: "ANALYSIS_TIMEOUT", message: "The analysis exceeded its time limit.", retryable: true }));
      return err(new AppError({ code: "REPOSITORY_INACCESSIBLE", message: "GitHub request failed.", retryable: true }));
    }
  }
}
