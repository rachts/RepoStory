import type { RepositoryProvider, RepositoryReference, RepositorySnapshot, RepositoryFile } from "@/domain/repository";
import { AppError } from "@/domain/errors";
import { err, ok, type Result } from "@/shared/result";
import { DEFAULT_LIMITS, type AnalysisBudget, type AnalysisLimits } from "@/shared/limits";
import { filterFiles } from "@/analysis/filter-files";
import { validateGitHubBranch } from "@/infrastructure/providers/github-url";
import { redactSecrets } from "@/shared/redaction";

type GitHubProviderOptions = { token?: string; fetchImpl?: typeof fetch; limits?: AnalysisLimits };
type JsonResult<T> = Result<T, AppError>;
type GitHubTreeEntry = { path: string; type: string; size?: number; sha?: string };

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
  if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) {
    const reset = response.headers.get("x-ratelimit-reset");
    const resetEpoch = reset && /^\d+$/.test(reset) ? Number(reset) : undefined;
    return new AppError({ code: "GITHUB_RATE_LIMITED", message: "GitHub API rate limit reached. Add GITHUB_TOKEN or retry after the limit resets.", retryable: true, details: resetEpoch ? { resetAt: resetEpoch } : undefined });
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
  const value = limits.maxConcurrentContentRequests ?? DEFAULT_LIMITS.maxConcurrentContentRequests;
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

function decodeGitHubContent(encoded: string, maxBytes: number): JsonResult<string> {
  const compact = encoded.replace(/\s/g, "");
  if (!isStrictBase64(compact)) return err(invalidContent("GitHub file content was not valid base64."));

  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  const expectedBytes = Math.floor((compact.length * 3) / 4) - padding;
  if (expectedBytes > maxBytes) return err(contentTooLarge(maxBytes));

  try {
    const padded = compact.padEnd(Math.ceil(compact.length / 4) * 4, "=");
    const decoded = Buffer.from(padded, "base64");
    if (decoded.byteLength > maxBytes || decoded.byteLength !== expectedBytes) return err(contentTooLarge(maxBytes));
    return ok(decoded.toString("utf8"));
  } catch {
    return err(invalidContent("GitHub file content was not valid base64."));
  }
}

export class GitHubPublicRepositoryProvider implements RepositoryProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly limits: AnalysisLimits;
  private readonly token?: string;

  public constructor(options: GitHubProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.limits = options.limits ?? DEFAULT_LIMITS;
    this.token = options.token?.trim() || undefined;
  }

  public async getSnapshot(reference: RepositoryReference, signal?: AbortSignal, budget?: AnalysisBudget): Promise<Result<RepositorySnapshot, AppError>> {
    const headers: HeadersInit = { Accept: "application/vnd.github+json", ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) };
    const base = `https://api.github.com/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.name)}`;
    const repositoryUrl = `https://github.com/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.name)}`;
    const fetchOptions: RequestInit = { headers, signal, redirect: "error", cache: "no-store" };
    const responseLimit = this.limits.maxResponseBytes ?? RESPONSE_SIZE_DEFAULT;
    const pathLimit = this.limits.maxPathLength ?? TREE_PATH_LENGTH_DEFAULT;

    try {
      budget?.check();
      const metaResponse = await this.fetchImpl(base, fetchOptions);
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

      budget?.check();
      const treeResponse = await this.fetchImpl(`${base}/git/trees/${encodeURIComponent(branch)}?recursive=1`, fetchOptions);
      if (!treeResponse.ok) return err(responseFailure(treeResponse, "tree"));
      const treeResult = await readJsonResponse<Record<string, unknown>>(treeResponse, "tree", responseLimit, budget);
      if (!treeResult.ok) return treeResult;
      const treePayload = treeResult.value;
      if (!isRecord(treePayload)) return err(invalidResponse("tree"));
      if (treePayload.truncated === true) {
        return err(new AppError({ code: "GITHUB_TREE_TRUNCATED", message: "GitHub repository tree was truncated and cannot be analyzed safely." }));
      }
      if (!Array.isArray(treePayload.tree)) return err(invalidResponse("tree"));
      const configuredMaxTreeEntries = this.limits.maxTreeEntries;
      const maxTreeEntries = typeof configuredMaxTreeEntries === "number" && Number.isSafeInteger(configuredMaxTreeEntries) && configuredMaxTreeEntries >= 0 ? configuredMaxTreeEntries : DEFAULT_LIMITS.maxTreeEntries;
      budget?.check();
      if (treePayload.tree.length > maxTreeEntries) return err(treeTooLarge(maxTreeEntries));

      const treeEntries: GitHubTreeEntry[] = [];
      for (const rawEntry of treePayload.tree) {
        budget?.check();
        if (!isRecord(rawEntry) || typeof rawEntry.path !== "string" || typeof rawEntry.type !== "string") return err(invalidResponse("tree"));
        if (rawEntry.size !== undefined && (typeof rawEntry.size !== "number" || !Number.isSafeInteger(rawEntry.size) || rawEntry.size < 0)) return err(invalidResponse("tree"));
        const pathResult = validateTreePath(rawEntry.path, pathLimit);
        if (!pathResult.ok) return pathResult;
        treeEntries.push({ path: pathResult.value, type: rawEntry.type, ...(rawEntry.size !== undefined ? { size: rawEntry.size } : {}), ...(typeof rawEntry.sha === "string" ? { sha: rawEntry.sha } : {}) });
      }
      budget?.check();

      const candidateInputs: RepositoryFile[] = [];
      for (const entry of treeEntries) {
        budget?.check();
        if (entry.type === "blob") candidateInputs.push({ path: entry.path, type: "file", sizeBytes: entry.size ?? 0, isAnalyzable: true });
      }
      budget?.check();
      const candidates = filterFiles(candidateInputs, this.limits, budget)
        .sort((a, b) => candidatePriority(a.path) - candidatePriority(b.path) || a.path.localeCompare(b.path));
      budget?.check();
      const files: RepositoryFile[] = [];
      let fetchedBytes = 0;
      let nextIndex = 0;
      const worker = async (): Promise<JsonResult<null>> => {
        while (true) {
          budget?.check();
          const index = nextIndex++;
          const item = candidates[index];
          if (!item) return ok(null);
          const itemSize = item.sizeBytes ?? 0;
          if (itemSize > this.limits.maxContentBytes) continue;
          budget?.check();
          const contentResponse = await this.fetchImpl(`${base}/contents/${encodeGitHubPath(item.path)}?ref=${encodeURIComponent(branch)}`, fetchOptions);
          if (!contentResponse.ok) return err(responseFailure(contentResponse, "content"));
          const contentResult = await readJsonResponse<Record<string, unknown>>(contentResponse, "content", responseLimit, budget);
          if (!contentResult.ok) return contentResult;
          const payload = contentResult.value;
          if (!isRecord(payload) || typeof payload.content !== "string" || payload.encoding !== "base64") return err(invalidContent());
          const decodedResult = decodeGitHubContent(payload.content, this.limits.maxContentBytes);
          if (!decodedResult.ok) {
            if (decodedResult.error.code === "GITHUB_CONTENT_TOO_LARGE") continue;
            return decodedResult;
          }
          const content = decodedResult.value;
          const actualBytes = Buffer.byteLength(content, "utf8");
          if (fetchedBytes + actualBytes > this.limits.maxTotalBytes) continue;
          fetchedBytes += actualBytes;
          files.push({ path: item.path, type: "file", sizeBytes: itemSize || actualBytes, content, isAnalyzable: true });
        }
      };
      const workers = Array.from({ length: Math.min(maxConcurrentRequests(this.limits), candidates.length) }, () => worker());
      const results = await Promise.all(workers);
      const failed = results.find((result) => !result.ok);
      if (failed && !failed.ok) return failed;
      files.sort((a, b) => a.path.localeCompare(b.path));

      const id = typeof metadata.id === "number" || typeof metadata.id === "string" ? String(metadata.id) : `${reference.owner}/${reference.name}`;
      const repository = {
        id,
        owner: reference.owner,
        name: reference.name,
        url: repositoryUrl,
        defaultBranch: metadata.default_branch,
        selectedBranch: branch,
        ...(typeof metadata.description === "string" ? { description: redactSecrets(metadata.description) } : {}),
        sizeBytes: typeof metadata.size === "number" && Number.isSafeInteger(metadata.size) && metadata.size >= 0 && metadata.size <= Number.MAX_SAFE_INTEGER / 1024 ? metadata.size * 1024 : 0,
        fileCount: files.length,
      };
      return ok({ repository, files });
    } catch (error) {
      if (error instanceof AppError) return err(error);
      if (signal?.aborted) return err(new AppError({ code: "ANALYSIS_TIMEOUT", message: "The analysis exceeded its time limit.", retryable: true }));
      return err(new AppError({ code: "REPOSITORY_INACCESSIBLE", message: "GitHub request failed.", retryable: true }));
    }
  }
}
