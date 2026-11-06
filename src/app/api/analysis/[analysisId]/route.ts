import { NextResponse } from "next/server";
import { analysisRepository, analysisStore } from "@/composition/container";
import { resolveRequestIdentity } from "@/application/jobs/job-identity";
import { redactPathValues } from "@/shared/redaction";
import { jsonResponse } from "@/shared/http";

interface RouteContext {
  params: Promise<{ analysisId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  const { analysisId } = await context.params;
  if (analysisId.length > 256) return jsonResponse({ error: { code: "ANALYSIS_NOT_FOUND", message: "Analysis not found.", retryable: false } }, { status: 404 });

  const identity = await resolveRequestIdentity(request, analysisRepository);
  if (!identity.ok) {
    return jsonResponse({ error: { code: identity.error.code, message: identity.error.message, retryable: false } }, { status: 401 });
  }

  const ownerId = identity.value.ownerId;
  const anyJob = await analysisRepository.getJobByAnalysisId(analysisId);
  if (anyJob && anyJob.ownerId !== ownerId) {
    return jsonResponse({ error: { code: "ANALYSIS_NOT_FOUND", message: "Analysis not found.", retryable: false } }, { status: 404 });
  }

  const analysis = anyJob
    ? await analysisRepository.getAnalysisResult(analysisId, ownerId)
    : analysisStore.get(analysisId);
  if (!analysis) return jsonResponse({ error: { code: "ANALYSIS_NOT_FOUND", message: "Analysis not found.", retryable: false } }, { status: 404 });

  const diagrams = anyJob
    ? await analysisRepository.listAnalysisDiagrams(analysisId, ownerId)
    : analysisStore.listDiagrams(analysisId);
  return jsonResponse(redactPathValues({ ...analysis, diagrams }));
}
