import { NextResponse } from "next/server";
import { analysisRepository } from "@/composition/container";
import { resolveRequestIdentity } from "@/application/jobs/job-identity";
import { jsonResponse } from "@/shared/http";
import { redactPathValues } from "@/shared/redaction";

interface RouteContext { params: Promise<{ jobId: string }> }

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  const { jobId } = await context.params;
  if (jobId.length > 256) return jsonResponse({ error: { code: "JOB_NOT_FOUND", message: "Analysis job not found.", retryable: false } }, { status: 404 });

  const identity = await resolveRequestIdentity(request, analysisRepository);
  if (!identity.ok) {
    return jsonResponse({ error: { code: identity.error.code, message: identity.error.message, retryable: false } }, { status: 401 });
  }

  await analysisRepository.markExpiredJobs();
  const job = await analysisRepository.getJob(jobId, identity.value.ownerId);
  if (!job) return jsonResponse({ error: { code: "JOB_NOT_FOUND", message: "Analysis job not found.", retryable: false } }, { status: 404 });

  // Detect stale jobs stuck in validating-input or queued state (older than 5 minutes)
  const isStaleCandidate =
    (job.status === "queued" || job.stage === "validating-input") &&
    job.status !== "completed" &&
    job.status !== "failed" &&
    job.status !== "cancelled" &&
    job.status !== "expired";

  const STALE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  const lastUpdatedTime = new Date(job.updatedAt || job.createdAt).getTime();
  const isStale = isStaleCandidate && !isNaN(lastUpdatedTime) && Date.now() - lastUpdatedTime > STALE_TIMEOUT_MS;

  let effectiveJob = job;
  if (isStale) {
    const timeoutMessage = "Job timed out during validation. The worker may be offline or crashed.";
    const timeoutError = {
      code: "VALIDATION_TIMEOUT",
      message: timeoutMessage,
      retryable: true,
    };

    const updated = await analysisRepository.updateJob(
      jobId,
      {
        status: "failed",
        stage: "completed",
        progress: 100,
        message: timeoutMessage,
        error: timeoutError,
        updatedAt: new Date().toISOString(),
      },
      identity.value.ownerId,
    );

    effectiveJob = updated ?? {
      ...job,
      status: "failed",
      stage: "completed",
      progress: 100,
      message: timeoutMessage,
      error: timeoutError,
      updatedAt: new Date().toISOString(),
    };
  }

  return jsonResponse(redactPathValues({
    jobId: effectiveJob.jobId,
    analysisId: effectiveJob.analysisId,
    repositoryUrl: effectiveJob.repositoryUrl,
    branch: effectiveJob.branch,
    status: effectiveJob.status,
    stage: effectiveJob.stage,
    progress: effectiveJob.progress,
    message: effectiveJob.message,
    createdAt: effectiveJob.createdAt,
    updatedAt: effectiveJob.updatedAt,
    expiresAt: effectiveJob.expiresAt,
    retryCount: effectiveJob.retryCount,
    explanationRequested: effectiveJob.explanationRequested,
    cancellationRequested: effectiveJob.cancellationRequested ?? false,
    error: effectiveJob.error,
    coverage: effectiveJob.coverage,
    statusUrl: `/api/analyze/jobs/${encodeURIComponent(effectiveJob.jobId)}`,
    resultUrl: effectiveJob.analysisId ? `/api/analyze/${encodeURIComponent(effectiveJob.analysisId)}` : null,
  }));
}
