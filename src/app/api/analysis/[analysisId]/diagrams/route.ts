import { NextResponse } from "next/server";
import { analysisRepository, analysisStore } from "@/composition/container";
import { ownerIdFromRequest } from "@/application/jobs/job-identity";
import { redactPathValues } from "@/shared/redaction";
import { jsonResponse } from "@/shared/http";

interface RouteContext {
  params: Promise<{ analysisId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  const { analysisId } = await context.params;
  if (analysisId.length > 256) return jsonResponse({ error: { code: "ANALYSIS_NOT_FOUND", message: "Analysis not found.", retryable: false } }, { status: 404 });
  const { ownerId } = ownerIdFromRequest(request);
  const job = await analysisRepository.getJobByAnalysisId(analysisId, ownerId);
  if (!job && !analysisStore.get(analysisId)) return jsonResponse({ error: { code: "ANALYSIS_NOT_FOUND", message: "Analysis not found.", retryable: false } }, { status: 404 });
  const diagrams = job ? await analysisRepository.listAnalysisDiagrams(analysisId, ownerId) : analysisStore.listDiagrams(analysisId);
  return jsonResponse(redactPathValues({ diagrams }));
}
