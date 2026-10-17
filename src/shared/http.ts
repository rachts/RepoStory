import { NextResponse } from "next/server";
import { AppError } from "@/domain/errors";

export function errorResponse(error: unknown): NextResponse {
  const normalized = error instanceof AppError
    ? error
    : new AppError({ code: "ANALYSIS_FAILED", message: "The analysis could not be completed.", retryable: true });
  const status = normalized.code === "INVALID_URL" || normalized.code === "UNSUPPORTED_HOST" ? 400 : normalized.code === "REPOSITORY_NOT_FOUND" ? 404 : 500;
  return NextResponse.json({ error: { code: normalized.code, message: normalized.message, details: normalized.details, retryable: normalized.retryable } }, { status });
}
