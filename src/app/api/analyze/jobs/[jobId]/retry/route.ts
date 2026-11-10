import { NextResponse } from "next/server";
import { analysisJobRunner, analysisRepository } from "@/composition/container";
import { resolveRequestIdentity } from "@/application/jobs/job-identity";
import { jsonResponse } from "@/shared/http";

interface RouteContext { params: Promise<{ jobId: string }> }

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  const { jobId } = await context.params;
  if (jobId.length > 256) return jsonResponse({ error: { code: "JOB_NOT_FOUND", message: "Analysis job not found.", retryable: false } }, { status: 404 });

  const identity = await resolveRequestIdentity(request, analysisRepository);
  if (!identity.ok) {
    return jsonResponse({ error: { code: identity.error.code, message: identity.error.message, retryable: false } }, { status: 401 });
  }

  const job = await analysisJobRunner.retry(jobId, identity.value.ownerId);
  if (!job) return jsonResponse({ error: { code: "JOB_NOT_RETRYABLE", message: "This analysis cannot be retried.", retryable: false } }, { status: 409 });
  return jsonResponse({ job });
}
