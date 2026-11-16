import { NextResponse } from "next/server";
import { AppError, type AnalysisErrorStage } from "@/domain/errors";
import { redactPathValues } from "@/shared/redaction";

export function inferErrorStage(code: string): AnalysisErrorStage {
  if (
    code === "REPOSITORY_NOT_FOUND" ||
    code === "REPOSITORY_NOT_FOUND_OR_PRIVATE" ||
    code === "REPOSITORY_INACCESSIBLE" ||
    code === "GITHUB_AUTH_FAILED" ||
    code === "INVALID_REQUEST" ||
    code === "INVALID_URL" ||
    code === "INVALID_BRANCH" ||
    code === "UNSUPPORTED_HOST" ||
    code === "UNAUTHORIZED" ||
    code === "RATE_LIMITED" ||
    code === "QUOTA_EXCEEDED" ||
    code === "CONFIG_ERROR"
  ) {
    return "fetch";
  }
  if (
    code === "REPOSITORY_TOO_LARGE" ||
    code === "REPO_TOO_LARGE" ||
    code === "GITHUB_TREE_TRUNCATED" ||
    code === "INVALID_TREE_PATH"
  ) {
    return "tree";
  }
  if (
    code === "GITHUB_CONTENT_TOO_LARGE" ||
    code === "GITHUB_RESPONSE_TOO_LARGE" ||
    code === "REQUEST_TOO_LARGE" ||
    code === "ARCHIVE_EXTRACTION_FAILED" ||
    code === "ARCHIVE_DECOMPRESSION_FAILED"
  ) {
    return "blob";
  }
  if (
    code === "FILE_PARSE_FAILED" ||
    code === "AST_PARSE_FAILED" ||
    code === "GITHUB_INVALID_CONTENT" ||
    code === "GITHUB_INVALID_RESPONSE"
  ) {
    return "parse";
  }
  if (
    code === "ANALYSIS_FAILED" ||
    code === "ANALYSIS_TIMEOUT" ||
    code === "ANALYSIS_BUSY" ||
    code === "GITHUB_RATE_LIMITED"
  ) {
    return "analyze";
  }
  if (
    code === "DIAGRAM_NOT_FOUND" ||
    code === "DIAGRAM_GENERATION_FAILED" ||
    code === "INVALID_DIAGRAM" ||
    code === "INVALID_PATCH"
  ) {
    return "diagram";
  }
  if (
    code === "ANALYSIS_STORAGE_UNAVAILABLE" ||
    code === "JOB_NOT_FOUND" ||
    code === "ANALYSIS_NOT_FOUND" ||
    code === "ANALYSIS_EXPIRED"
  ) {
    return "persist";
  }
  return "analyze";
}

export function inferErrorHint(code: string): string {
  switch (code) {
    case "REPOSITORY_NOT_FOUND_OR_PRIVATE":
      return "Make the repository public or sign in with a GitHub token that has repo scope.";
    case "REPOSITORY_NOT_FOUND":
      return "Verify the repository URL and branch name.";
    case "GITHUB_RATE_LIMITED":
      return "Provide a GitHub token via authentication or request body to increase rate limits.";
    case "REPO_TOO_LARGE":
    case "REPOSITORY_TOO_LARGE":
      return "Analyze a smaller repository or set REPO_STORY_LARGE_REPO_MODE=sample for sampled analysis.";
    case "GITHUB_TREE_TRUNCATED":
      return "Repository tree is too deep; try analyzing a specific branch or subpath.";
    case "GITHUB_AUTH_FAILED":
      return "Check your GitHub token credentials and permissions.";
    case "UNAUTHORIZED":
      return "Authentication is required. Sign in with GitHub.";
    case "ANALYSIS_TIMEOUT":
      return "The analysis exceeded the execution time limit. Retry with a smaller repository.";
    default:
      return "Retry the analysis or verify the repository input.";
  }
}

/**
 * Read and parse a bounded JSON request body.
 *
 * Request.json() delegates buffering to the runtime, so it cannot enforce a
 * useful application-level limit before the payload has been materialized.
 * Keeping this boundary here makes every JSON route fail closed on malformed
 * or unexpectedly large input.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (Number.isSafeInteger(declaredLength) && declaredLength >= 0 && declaredLength > maxBytes) {
      throw new AppError({ code: "REQUEST_TOO_LARGE", message: "The request body is too large.", retryable: false, details: { maxBytes } });
    }
  }

  let bodyText: string;
  try {
    if (!request.body) {
      bodyText = await request.text();
      if (new TextEncoder().encode(bodyText).byteLength > maxBytes) {
        throw new AppError({ code: "REQUEST_TOO_LARGE", message: "The request body is too large.", retryable: false, details: { maxBytes } });
      }
    } else {
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          totalBytes += result.value.byteLength;
          if (totalBytes > maxBytes) {
            try {
              await reader.cancel();
            } catch {
              // The size-limit error remains the useful response.
            }
            throw new AppError({ code: "REQUEST_TOO_LARGE", message: "The request body is too large.", retryable: false, details: { maxBytes } });
          }
          chunks.push(result.value);
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
      bodyText = new TextDecoder().decode(bytes);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError({ code: "INVALID_REQUEST", message: "The request body could not be read.", retryable: false });
  }

  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    throw new AppError({ code: "INVALID_REQUEST", message: "The request body must contain valid JSON.", retryable: false });
  }
}

/** API responses containing repository-derived data must not be shared-cached. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): NextResponse {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(body, { ...init, headers });
}

export function errorResponse(error: unknown): NextResponse {
  const normalized = error instanceof AppError
    ? error
    : new AppError({ code: "ANALYSIS_FAILED", message: "The request encountered an unexpected server error. Please retry.", retryable: true });
  const status = normalized.code === "INVALID_REQUEST" || normalized.code === "INVALID_URL" || normalized.code === "INVALID_BRANCH" || normalized.code === "UNSUPPORTED_HOST" ? 400
    : normalized.code === "UNAUTHORIZED" ? 401
    : normalized.code === "REPOSITORY_NOT_FOUND" || normalized.code === "REPOSITORY_NOT_FOUND_OR_PRIVATE" ? 404
    : normalized.code === "AI_NOT_READY" ? 409
    : normalized.code === "GITHUB_RATE_LIMITED" || normalized.code === "ANALYSIS_BUSY" || normalized.code === "AI_RATE_LIMITED" ? 429
    : normalized.code === "REQUEST_TOO_LARGE" || normalized.code === "REPOSITORY_TOO_LARGE" || normalized.code === "REPO_TOO_LARGE" || normalized.code === "GITHUB_TREE_TRUNCATED" || normalized.code === "GITHUB_RESPONSE_TOO_LARGE" || normalized.code === "GITHUB_CONTENT_TOO_LARGE" ? 413
    : normalized.code === "ANALYSIS_TIMEOUT" || normalized.code === "AI_TIMEOUT" ? 504
    : normalized.code === "AI_NOT_CONFIGURED" || normalized.code === "AI_DISABLED" || normalized.code === "AI_AUTH_FAILED" || normalized.code === "AI_PERMISSION_DENIED" || normalized.code === "AI_MODEL_UNAVAILABLE" || normalized.code === "GITHUB_AUTH_FAILED" || normalized.code === "ANALYSIS_STORAGE_UNAVAILABLE" ? 503
    : normalized.code === "AI_INVALID_RESPONSE" || normalized.code === "AI_REQUEST_REJECTED" || normalized.code === "AI_UPSTREAM_FAILED" || normalized.code === "REPOSITORY_INACCESSIBLE" || normalized.code.startsWith("GITHUB_") ? 502
    : 500;

  const stage = normalized.stage ?? inferErrorStage(normalized.code);
  const reason = normalized.reason ?? normalized.message;
  const hint = normalized.hint ?? inferErrorHint(normalized.code);

  return jsonResponse({
    error: {
      code: normalized.code,
      stage,
      reason: redactPathValues(reason),
      message: redactPathValues(normalized.message),
      retryable: normalized.retryable,
      hint: redactPathValues(hint),
      details: redactPathValues(normalized.details),
    },
    code: normalized.code,
    stage,
    reason: redactPathValues(reason),
    retryable: normalized.retryable,
    hint: redactPathValues(hint),
  }, { status });
}
