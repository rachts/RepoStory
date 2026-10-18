import { NextResponse } from "next/server";
import { analysisStore } from "@/composition/container";
import { jsonResponse } from "@/shared/http";

interface RouteContext { params: Promise<{ diagramId: string }> }

export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  const { diagramId } = await context.params;
  if (diagramId.length > 256) return jsonResponse({ error: { code: "DIAGRAM_NOT_FOUND", message: "Diagram not found.", retryable: false } }, { status: 404 });
  const diagram = analysisStore.resetDiagram(diagramId);
  if (!diagram) return jsonResponse({ error: { code: "DIAGRAM_NOT_FOUND", message: "Diagram not found.", retryable: false } }, { status: 404 });
  return jsonResponse({ diagram });
}
