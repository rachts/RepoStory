import { NextResponse } from "next/server";
import { analysisJobRunner } from "@/composition/container";
import { ownerIdFromRequest } from "@/application/jobs/job-identity";
import { jsonResponse } from "@/shared/http";

interface RouteContext { params: Promise<{ jobId: string }> }

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  const { jobId } = await context.params;
  if (jobId.length > 256) return jsonResponse({ error: { code: "JOB_NOT_FOUND", message: "Analysis job not found.", retryable: false } }, { status: 404 });
  const { ownerId } = ownerIdFromRequest(request);
  const job = await analysisJobRunner.retry(jobId, ownerId);
  if (!job) return jsonResponse({ error: { code: "JOB_NOT_RETRYABLE", message: "This analysis cannot be retried.", retryable: false } }, { status: 409 });
  return jsonResponse({ job });
}
