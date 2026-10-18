import { NextResponse } from "next/server";
import { AppError } from "@/domain/errors";
import { redactPathValues } from "@/shared/redaction";

export function errorResponse(error: unknown): NextResponse {
  const normalized = error instanceof AppError
    ? error
    : new AppError({ code: "ANALYSIS_FAILED", message: "The analysis could not be completed.", retryable: true });
  const status = normalized.code === "INVALID_URL" || normalized.code === "UNSUPPORTED_HOST" ? 400
    : normalized.code === "REPOSITORY_NOT_FOUND" ? 404
    : normalized.code === "GITHUB_RATE_LIMITED" ? 429
    : normalized.code === "REPOSITORY_TOO_LARGE" || normalized.code === "GITHUB_TREE_TRUNCATED" || normalized.code === "GITHUB_RESPONSE_TOO_LARGE" || normalized.code === "GITHUB_CONTENT_TOO_LARGE" ? 413
    : normalized.code === "ANALYSIS_TIMEOUT" ? 504
    : normalized.code === "REPOSITORY_INACCESSIBLE" || normalized.code.startsWith("GITHUB_") ? 502
    : 500;
  return NextResponse.json({ error: { code: normalized.code, message: redactPathValues(normalized.message), details: redactPathValues(normalized.details), retryable: normalized.retryable } }, { status });
}
