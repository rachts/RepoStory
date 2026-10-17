import { NextResponse } from "next/server";
import { analysisStore } from "@/composition/container";

interface RouteContext { params: Promise<{ diagramId: string }> }

export async function POST(_request: Request, context: RouteContext): Promise<NextResponse> {
  const { diagramId } = await context.params;
  const diagram = analysisStore.resetDiagram(diagramId);
  if (!diagram) return NextResponse.json({ error: { code: "DIAGRAM_NOT_FOUND", message: "Diagram not found.", retryable: false } }, { status: 404 });
  return NextResponse.json({ diagram });
}
