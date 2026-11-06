import { NextResponse } from "next/server";
import { analysisRepository, analysisStore } from "@/composition/container";
import { resolveRequestIdentity } from "@/application/jobs/job-identity";
import { jsonResponse } from "@/shared/http";

interface RouteContext { params: Promise<{ diagramId: string }> }

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  const { diagramId } = await context.params;
  if (diagramId.length > 256) return jsonResponse({ error: { code: "DIAGRAM_NOT_FOUND", message: "Diagram not found.", retryable: false } }, { status: 404 });

  const identity = await resolveRequestIdentity(request, analysisRepository);
  if (!identity.ok) {
    return jsonResponse({ error: { code: identity.error.code, message: identity.error.message, retryable: false } }, { status: 401 });
  }

  const ownerId = identity.value.ownerId;
  const existing = await analysisRepository.getAnalysisDiagram(diagramId, ownerId) ?? analysisStore.getDiagram(diagramId);
  if (!existing) return jsonResponse({ error: { code: "DIAGRAM_NOT_FOUND", message: "Diagram not found.", retryable: false } }, { status: 404 });

  const job = await analysisRepository.getJobByAnalysisId(existing.analysisId);
  if (job && job.ownerId !== ownerId) {
    return jsonResponse({ error: { code: "DIAGRAM_NOT_FOUND", message: "Diagram not found.", retryable: false } }, { status: 404 });
  }

  const diagram = job
    ? await analysisRepository.resetAnalysisDiagram(diagramId, ownerId)
    : analysisStore.resetDiagram(diagramId);
  if (!diagram) return jsonResponse({ error: { code: "DIAGRAM_NOT_FOUND", message: "Diagram not found.", retryable: false } }, { status: 404 });
  return jsonResponse({ diagram });
}
