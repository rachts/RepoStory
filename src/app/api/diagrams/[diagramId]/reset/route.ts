import { NextResponse } from "next/server";
import { analysisRepository, analysisStore } from "@/composition/container";
import { ownerIdFromRequest } from "@/application/jobs/job-identity";
import { jsonResponse } from "@/shared/http";

interface RouteContext { params: Promise<{ diagramId: string }> }

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  const { diagramId } = await context.params;
  if (diagramId.length > 256) return jsonResponse({ error: { code: "DIAGRAM_NOT_FOUND", message: "Diagram not found.", retryable: false } }, { status: 404 });
  const { ownerId } = ownerIdFromRequest(request);
  const existing = await analysisRepository.getAnalysisDiagram(diagramId, ownerId) ?? analysisStore.getDiagram(diagramId);
  const diagram = existing && await analysisRepository.getJobByAnalysisId(existing.analysisId, ownerId)
    ? await analysisRepository.resetAnalysisDiagram(diagramId, ownerId)
    : analysisStore.resetDiagram(diagramId);
  if (!diagram) return jsonResponse({ error: { code: "DIAGRAM_NOT_FOUND", message: "Diagram not found.", retryable: false } }, { status: 404 });
  return jsonResponse({ diagram });
}
