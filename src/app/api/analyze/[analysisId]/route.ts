import { NextResponse } from "next/server";
import { analysisRepository } from "@/composition/container";
import { resolveRequestIdentity } from "@/application/jobs/job-identity";
import { jsonResponse } from "@/shared/http";
import { redactPathValues } from "@/shared/redaction";

interface RouteContext { params: Promise<{ analysisId: string }> }

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  const { analysisId } = await context.params;
  if (analysisId.length > 256) return jsonResponse({ error: { code: "ANALYSIS_NOT_FOUND", message: "Analysis not found.", retryable: false } }, { status: 404 });

  const identity = await resolveRequestIdentity(request, analysisRepository);
  if (!identity.ok) {
    return jsonResponse({ error: { code: identity.error.code, message: identity.error.message, retryable: false } }, { status: 401 });
  }

  const job = await analysisRepository.getJobByAnalysisId(analysisId, identity.value.ownerId);
  if (!job) return jsonResponse({ error: { code: "ANALYSIS_NOT_FOUND", message: "Analysis not found.", retryable: false } }, { status: 404 });
  if (job.status === "expired") return jsonResponse({ error: { code: "ANALYSIS_EXPIRED", message: "This analysis has expired. Analyze the repository again to create a fresh result.", retryable: false } }, { status: 410 });
  if (job.status !== "completed") return jsonResponse({ job }, { status: 409 });

  const analysis = await analysisRepository.getAnalysisResult(analysisId, identity.value.ownerId);
  if (!analysis) return jsonResponse({ error: { code: "ANALYSIS_NOT_FOUND", message: "Analysis result not found.", retryable: false } }, { status: 404 });

  const diagrams = await analysisRepository.listAnalysisDiagrams(analysisId, identity.value.ownerId);
  const explanation = await analysisRepository.getExplanation(analysisId, identity.value.ownerId);
  const explanationUnavailable = await analysisRepository.getExplanationUnavailable(analysisId, identity.value.ownerId);

  return jsonResponse(redactPathValues({ ...analysis, diagrams, ...(explanation ? { explanation } : {}), ...(explanationUnavailable ? { explanationUnavailable } : {}) }));
}
