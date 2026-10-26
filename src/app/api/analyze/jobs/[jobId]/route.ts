import { NextResponse } from "next/server";
import { analysisRepository } from "@/composition/container";
import { ownerIdFromRequest } from "@/application/jobs/job-identity";
import { jsonResponse } from "@/shared/http";
import { redactPathValues } from "@/shared/redaction";

interface RouteContext { params: Promise<{ jobId: string }> }

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  const { jobId } = await context.params;
  if (jobId.length > 256) return jsonResponse({ error: { code: "JOB_NOT_FOUND", message: "Analysis job not found.", retryable: false } }, { status: 404 });
  await analysisRepository.markExpiredJobs();
  const { ownerId } = ownerIdFromRequest(request);
  const job = await analysisRepository.getJob(jobId, ownerId);
  if (!job) return jsonResponse({ error: { code: "JOB_NOT_FOUND", message: "Analysis job not found.", retryable: false } }, { status: 404 });
  return jsonResponse(redactPathValues({
    jobId: job.jobId,
    analysisId: job.analysisId,
    repositoryUrl: job.repositoryUrl,
    branch: job.branch,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
    retryCount: job.retryCount,
    explanationRequested: job.explanationRequested,
    cancellationRequested: job.cancellationRequested ?? false,
    error: job.error,
    coverage: job.coverage,
    statusUrl: `/api/analyze/jobs/${encodeURIComponent(job.jobId)}`,
    resultUrl: job.analysisId ? `/api/analyze/${encodeURIComponent(job.analysisId)}` : null,
  }));
}
