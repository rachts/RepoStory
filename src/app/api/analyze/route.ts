import { z } from "zod";
import { NextResponse } from "next/server";
import { parseGitHubUrl, validateGitHubBranch } from "@/infrastructure/providers/github-url";
import { analysisJobRunner, analysisRepository } from "@/composition/container";
import { ownerIdFromRequest, analysisCacheKey, sessionCookieHeader } from "@/application/jobs/job-identity";
import { opaqueId, nowIso } from "@/shared/ids";
import { serverConfig } from "@/shared/config";
import { errorResponse, jsonResponse, readJsonBody } from "@/shared/http";

const MAX_REQUEST_BYTES = 8 * 1024;

const requestSchema = z.object({
  repositoryUrl: z.string().trim().min(1).max(500),
  branch: z.string().trim().min(1).max(255).optional(),
  explanationRequested: z.boolean().optional().default(false),
}).strict();

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await readJsonBody(request, MAX_REQUEST_BYTES);
    const input = requestSchema.parse(body);
    const parsed = parseGitHubUrl(input.repositoryUrl);
    if (!parsed.ok) return errorResponse(parsed.error);
    if (input.branch) {
      const branch = validateGitHubBranch(input.branch);
      if (!branch.ok) return errorResponse(branch.error);
    }
    const reference = { ...parsed.value, ...(input.branch ? { branch: input.branch } : {}) };
    const { ownerId, setCookie } = ownerIdFromRequest(request);
    const cacheKey = analysisCacheKey(reference);
    await analysisRepository.markExpiredJobs();
    const created = await analysisRepository.createOrReuseJob({
      jobId: opaqueId("job"),
      analysisId: null,
      repositoryUrl: reference.url,
      branch: reference.branch ?? "default",
      ...(reference.branch ? { requestedBranch: reference.branch } : {}),
      ownerId,
      cacheKey,
      status: "queued",
      stage: "validating-input",
      progress: 0,
      message: "Analysis queued.",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      expiresAt: new Date(Date.now() + serverConfig.jobTtlMs).toISOString(),
      retryCount: 0,
      explanationRequested: input.explanationRequested,
    });
    const job = created.job;
    if (created.created) analysisJobRunner.enqueue(job.jobId);
    const response = jsonResponse({
      jobId: job.jobId,
      analysisId: job.analysisId,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      statusUrl: `/api/analyze/jobs/${encodeURIComponent(job.jobId)}`,
      resultUrl: job.analysisId ? `/api/analyze/${encodeURIComponent(job.analysisId)}` : null,
      deduplicated: !created.created,
    }, { status: 202, headers: { Location: `/api/analyze/jobs/${encodeURIComponent(job.jobId)}` } });
    if (setCookie) response.headers.set("Set-Cookie", sessionCookieHeader(ownerId));
    return response;
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonResponse({ error: { code: "INVALID_REQUEST", message: "Provide a valid public GitHub repository URL.", details: { issues: error.issues.length }, retryable: false } }, { status: 400 });
    }
    return errorResponse(error);
  }
}
