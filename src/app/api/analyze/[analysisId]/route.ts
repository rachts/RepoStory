import { NextResponse } from "next/server";
import { analysisRepository } from "@/composition/container";
import { ownerIdFromRequest } from "@/application/jobs/job-identity";
import { jsonResponse } from "@/shared/http";
import { redactPathValues } from "@/shared/redaction";

interface RouteContext { params: Promise<{ analysisId: string }> }

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  const { analysisId } = await context.params;
  if (analysisId.length > 256) return jsonResponse({ error: { code: "ANALYSIS_NOT_FOUND", message: "Analysis not found.", retryable: false } }, { status: 404 });
  const { ownerId } = ownerIdFromRequest(request);
  const job = await analysisRepository.getJobByAnalysisId(analysisId, ownerId);
  if (!job) return jsonResponse({ error: { code: "ANALYSIS_NOT_FOUND", message: "Analysis not found.", retryable: false } }, { status: 404 });
  if (job.status === "expired") return jsonResponse({ error: { code: "ANALYSIS_EXPIRED", message: "This analysis has expired. Analyze the repository again to create a fresh result.", retryable: false } }, { status: 410 });
  if (job.status !== "completed") return jsonResponse({ job }, { status: 409 });
  const analysis = await analysisRepository.getAnalysisResult(analysisId, ownerId);
  if (!analysis) return jsonResponse({ error: { code: "ANALYSIS_NOT_FOUND", message: "Analysis result not found.", retryable: false } }, { status: 404 });
  const diagrams = await analysisRepository.listAnalysisDiagrams(analysisId, ownerId);
  const explanation = await analysisRepository.getExplanation(analysisId, ownerId);
  const explanationUnavailable = await analysisRepository.getExplanationUnavailable(analysisId, ownerId);
  return jsonResponse(redactPathValues({ ...analysis, diagrams, ...(explanation ? { explanation } : {}), ...(explanationUnavailable ? { explanationUnavailable } : {}) }));
}
