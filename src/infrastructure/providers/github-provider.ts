import type { RepositoryProvider, RepositoryReference, RepositorySnapshot, RepositoryFile } from "@/domain/repository";
import { AppError } from "@/domain/errors";
import { err, ok, type Result } from "@/shared/result";
import { DEFAULT_LIMITS, type AnalysisLimits } from "@/shared/limits";
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

function responseFailure(response: Response, stage: string): AppError {
  if (response.status === 403 || response.status === 429) {
    return new AppError({ code: "GITHUB_RATE_LIMITED", message: "GitHub API rate limit reached.", retryable: true });
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

async function readResponseText(response: Response, stage: string, maxBytes: number): Promise<JsonResult<string>> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) return err(responseTooLarge(stage, maxBytes));
  }

  try {
    if (!response.body) {
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > maxBytes) return err(responseTooLarge(stage, maxBytes));
      return ok(text);
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const result = await reader.read();
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
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return ok(new TextDecoder().decode(bytes));
  } catch {
    return err(new AppError({ code: "GITHUB_RESPONSE_READ_FAILED", message: `Unable to read GitHub ${stage} response.`, retryable: true }));
  }
}

async function readJsonResponse<T>(response: Response, stage: string, maxBytes: number): Promise<JsonResult<T>> {
  const body = await readResponseText(response, stage, maxBytes);
  if (!body.ok) return body;
  try {
    return ok(JSON.parse(body.value) as T);
  } catch {
    return err(invalidResponse(stage));
  }
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
    this.token = options.token;
  }

  public async getSnapshot(reference: RepositoryReference, signal?: AbortSignal): Promise<Result<RepositorySnapshot, AppError>> {
    const headers: HeadersInit = { Accept: "application/vnd.github+json", ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) };
    const base = `https://api.github.com/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.name)}`;
    const responseLimit = this.limits.maxResponseBytes ?? RESPONSE_SIZE_DEFAULT;
    const pathLimit = this.limits.maxPathLength ?? TREE_PATH_LENGTH_DEFAULT;

    try {
      const metaResponse = await this.fetchImpl(base, { headers, signal });
      if (!metaResponse.ok) {
        if (metaResponse.status === 404) return err(new AppError({ code: "REPOSITORY_NOT_FOUND", message: "GitHub repository not found." }));
        return err(responseFailure(metaResponse, "metadata"));
      }
      const metadataResult = await readJsonResponse<Record<string, unknown>>(metaResponse, "metadata", responseLimit);
      if (!metadataResult.ok) return metadataResult;
      const metadata = metadataResult.value;
      if (!isRecord(metadata) || typeof metadata.default_branch !== "string") return err(invalidResponse("metadata"));

      const branchResult = validateGitHubBranch(reference.branch ?? metadata.default_branch);
      if (!branchResult.ok) return branchResult;
      const branch = branchResult.value;

      const treeResponse = await this.fetchImpl(`${base}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { headers, signal });
      if (!treeResponse.ok) return err(responseFailure(treeResponse, "tree"));
      const treeResult = await readJsonResponse<Record<string, unknown>>(treeResponse, "tree", responseLimit);
      if (!treeResult.ok) return treeResult;
      const treePayload = treeResult.value;
      if (!isRecord(treePayload)) return err(invalidResponse("tree"));
      if (treePayload.truncated === true) {
        return err(new AppError({ code: "GITHUB_TREE_TRUNCATED", message: "GitHub repository tree was truncated and cannot be analyzed safely." }));
      }
      if (!Array.isArray(treePayload.tree)) return err(invalidResponse("tree"));

      const treeEntries: GitHubTreeEntry[] = [];
      for (const rawEntry of treePayload.tree) {
        if (!isRecord(rawEntry) || typeof rawEntry.path !== "string" || typeof rawEntry.type !== "string") return err(invalidResponse("tree"));
        if (rawEntry.size !== undefined && (typeof rawEntry.size !== "number" || !Number.isSafeInteger(rawEntry.size) || rawEntry.size < 0)) return err(invalidResponse("tree"));
        const pathResult = validateTreePath(rawEntry.path, pathLimit);
        if (!pathResult.ok) return pathResult;
        treeEntries.push({ path: pathResult.value, type: rawEntry.type, ...(rawEntry.size !== undefined ? { size: rawEntry.size } : {}), ...(typeof rawEntry.sha === "string" ? { sha: rawEntry.sha } : {}) });
      }

      const candidates = filterFiles(treeEntries.filter((entry) => entry.type === "blob").map((item) => ({ path: item.path, type: "file" as const, sizeBytes: item.size ?? 0, isAnalyzable: true })), this.limits);
      const files: RepositoryFile[] = [];
      for (const item of candidates) {
        const itemSize = item.sizeBytes ?? 0;
        if (itemSize > this.limits.maxContentBytes) return err(contentTooLarge(this.limits.maxContentBytes));

        const contentResponse = await this.fetchImpl(`${base}/contents/${encodeGitHubPath(item.path)}?ref=${encodeURIComponent(branch)}`, { headers, signal });
        if (!contentResponse.ok) return err(responseFailure(contentResponse, "content"));
        const contentResult = await readJsonResponse<Record<string, unknown>>(contentResponse, "content", responseLimit);
        if (!contentResult.ok) return contentResult;
        const payload = contentResult.value;
        if (!isRecord(payload) || typeof payload.content !== "string" || payload.encoding !== "base64") return err(invalidContent());
        const decodedResult = decodeGitHubContent(payload.content, this.limits.maxContentBytes);
        if (!decodedResult.ok) return decodedResult;
        files.push({ path: item.path, type: "file", sizeBytes: itemSize || Buffer.byteLength(decodedResult.value, "utf8"), content: decodedResult.value, isAnalyzable: true });
      }

      const id = typeof metadata.id === "number" || typeof metadata.id === "string" ? String(metadata.id) : `${reference.owner}/${reference.name}`;
      const repository = {
        id,
        owner: reference.owner,
        name: reference.name,
        url: typeof metadata.html_url === "string" ? metadata.html_url : reference.url,
        defaultBranch: metadata.default_branch,
        selectedBranch: branch,
        ...(typeof metadata.description === "string" ? { description: redactSecrets(metadata.description) } : {}),
        sizeBytes: typeof metadata.size === "number" && Number.isFinite(metadata.size) && metadata.size >= 0 ? metadata.size * 1024 : 0,
        fileCount: files.length,
      };
      return ok({ repository, files });
    } catch {
      if (signal?.aborted) return err(new AppError({ code: "ANALYSIS_TIMEOUT", message: "The analysis exceeded its time limit.", retryable: true }));
      return err(new AppError({ code: "REPOSITORY_INACCESSIBLE", message: "GitHub request failed.", retryable: true }));
    }
  }
}
