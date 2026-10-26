import { NextResponse } from "next/server";
import { AppError } from "@/domain/errors";
import { redactPathValues } from "@/shared/redaction";

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
    : new AppError({ code: "ANALYSIS_FAILED", message: "The analysis could not be completed.", retryable: true });
  const status = normalized.code === "INVALID_REQUEST" || normalized.code === "INVALID_URL" || normalized.code === "INVALID_BRANCH" || normalized.code === "UNSUPPORTED_HOST" ? 400
    : normalized.code === "REPOSITORY_NOT_FOUND" ? 404
    : normalized.code === "AI_NOT_READY" ? 409
    : normalized.code === "GITHUB_RATE_LIMITED" || normalized.code === "ANALYSIS_BUSY" || normalized.code === "AI_RATE_LIMITED" ? 429
    : normalized.code === "REQUEST_TOO_LARGE" || normalized.code === "REPOSITORY_TOO_LARGE" || normalized.code === "GITHUB_TREE_TRUNCATED" || normalized.code === "GITHUB_RESPONSE_TOO_LARGE" || normalized.code === "GITHUB_CONTENT_TOO_LARGE" ? 413
    : normalized.code === "ANALYSIS_TIMEOUT" || normalized.code === "AI_TIMEOUT" ? 504
    : normalized.code === "AI_NOT_CONFIGURED" || normalized.code === "AI_DISABLED" || normalized.code === "AI_AUTH_FAILED" || normalized.code === "AI_PERMISSION_DENIED" || normalized.code === "AI_MODEL_UNAVAILABLE" ? 503
    : normalized.code === "AI_INVALID_RESPONSE" || normalized.code === "AI_REQUEST_REJECTED" || normalized.code === "AI_UPSTREAM_FAILED" || normalized.code === "REPOSITORY_INACCESSIBLE" || normalized.code.startsWith("GITHUB_") ? 502
    : 500;
  return jsonResponse({ error: { code: normalized.code, message: redactPathValues(normalized.message), details: redactPathValues(normalized.details), retryable: normalized.retryable } }, { status });
}
