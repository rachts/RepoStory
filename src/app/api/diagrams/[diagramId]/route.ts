import { NextResponse } from "next/server";
import { analysisStore } from "@/composition/container";
import { toMermaid } from "@/analysis/exports";
import { z } from "zod";
import { applyDiagramPatch } from "@/application/diagram-edits";

interface RouteContext {
  params: Promise<{ diagramId: string }>;
}

const text = z.string().trim().min(1).max(5000);
const patchSchema = z.object({
  title: text.optional(),
  description: text.optional(),
  direction: z.enum(["TB", "LR", "RL", "BT"]).optional(),
  customNote: text.optional(),
  nodeUpdates: z.array(z.object({ nodeId: z.string().min(1), technicalLabel: text.optional(), plainEnglishLabel: text.optional(), explanation: text.optional(), visible: z.boolean().optional() }).strict()).max(200).optional(),
  edgeUpdates: z.array(z.object({ edgeId: z.string().min(1), label: text.optional(), explanation: text.optional(), visible: z.boolean().optional() }).strict()).max(400).optional(),
}).strict();

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  const { diagramId } = await context.params;
  const diagram = analysisStore.getDiagram(diagramId);
  if (!diagram) return NextResponse.json({ error: { code: "DIAGRAM_NOT_FOUND", message: "Diagram not found.", retryable: false } }, { status: 404 });
  return NextResponse.json({ diagram, mermaid: toMermaid(diagram) });
}

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  const { diagramId } = await context.params;
  const diagram = analysisStore.getDiagram(diagramId);
  if (!diagram) return NextResponse.json({ error: { code: "DIAGRAM_NOT_FOUND", message: "Diagram not found.", retryable: false } }, { status: 404 });
  try {
    const patch = patchSchema.parse(await request.json());
    const nodeIds = new Set(diagram.nodes.map((node) => node.id));
    const edgeIds = new Set(diagram.edges.map((edge) => edge.id));
    if ((patch.nodeUpdates ?? []).some((update) => !nodeIds.has(update.nodeId))) throw new Error("UNKNOWN_NODE_ID");
    if ((patch.edgeUpdates ?? []).some((update) => !edgeIds.has(update.edgeId))) throw new Error("UNKNOWN_EDGE_ID");
    const updated = applyDiagramPatch(diagram, patch);
    analysisStore.saveDiagram(updated);
    return NextResponse.json({ diagram: updated });
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith("UNKNOWN_") ? "The patch references an unknown diagram element." : "The diagram patch is invalid.";
    return NextResponse.json({ error: { code: "INVALID_PATCH", message, retryable: false } }, { status: 400 });
  }
}
