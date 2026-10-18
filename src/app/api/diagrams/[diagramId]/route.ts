import { NextResponse } from "next/server";
import { analysisStore } from "@/composition/container";
import { toMermaid } from "@/analysis/exports";
import { z } from "zod";
import { AppError } from "@/domain/errors";
import { applyDiagramPatch } from "@/application/diagram-edits";
import { redactPathValues } from "@/shared/redaction";
import { errorResponse, jsonResponse, readJsonBody } from "@/shared/http";

interface RouteContext {
  params: Promise<{ diagramId: string }>;
}

const text = z.string().trim().min(1).max(5000);
const elementId = z.string().trim().min(1).max(256);
const patchSchema = z.object({
  title: text.optional(),
  description: text.optional(),
  direction: z.enum(["TB", "LR", "RL", "BT"]).optional(),
  customNote: text.optional(),
  nodeUpdates: z.array(z.object({ nodeId: elementId, technicalLabel: text.optional(), plainEnglishLabel: text.optional(), explanation: text.optional(), visible: z.boolean().optional() }).strict()).max(200).optional(),
  edgeUpdates: z.array(z.object({ edgeId: elementId, label: text.optional(), explanation: text.optional(), visible: z.boolean().optional() }).strict()).max(400).optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, { message: "The patch must include at least one editable field." });

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  const { diagramId } = await context.params;
  if (diagramId.length > 256) return jsonResponse({ error: { code: "DIAGRAM_NOT_FOUND", message: "Diagram not found.", retryable: false } }, { status: 404 });
  const diagram = analysisStore.getDiagram(diagramId);
  if (!diagram) return jsonResponse({ error: { code: "DIAGRAM_NOT_FOUND", message: "Diagram not found.", retryable: false } }, { status: 404 });
  const safeDiagram = redactPathValues(diagram);
  return jsonResponse({ diagram: safeDiagram, mermaid: toMermaid(safeDiagram) });
}

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  const { diagramId } = await context.params;
  if (diagramId.length > 256) return jsonResponse({ error: { code: "DIAGRAM_NOT_FOUND", message: "Diagram not found.", retryable: false } }, { status: 404 });
  const diagram = analysisStore.getDiagram(diagramId);
  if (!diagram) return jsonResponse({ error: { code: "DIAGRAM_NOT_FOUND", message: "Diagram not found.", retryable: false } }, { status: 404 });
  try {
    const patch = patchSchema.parse(await readJsonBody(request, 8 * 1024 * 1024));
    const nodeIds = new Set(diagram.nodes.map((node) => node.id));
    const edgeIds = new Set(diagram.edges.map((edge) => edge.id));
    if ((patch.nodeUpdates ?? []).some((update) => !nodeIds.has(update.nodeId))) throw new Error("UNKNOWN_NODE_ID");
    if ((patch.edgeUpdates ?? []).some((update) => !edgeIds.has(update.edgeId))) throw new Error("UNKNOWN_EDGE_ID");
    const updated = redactPathValues(applyDiagramPatch(diagram, patch));
    analysisStore.saveDiagram(updated);
    return jsonResponse({ diagram: updated });
  } catch (error) {
    if (error instanceof z.ZodError) return jsonResponse({ error: { code: "INVALID_PATCH", message: "The diagram patch is invalid.", retryable: false } }, { status: 400 });
    if (error instanceof AppError) {
      if (error.code === "INVALID_REQUEST") return jsonResponse({ error: { code: "INVALID_PATCH", message: "The diagram patch is invalid.", retryable: false } }, { status: 400 });
      return errorResponse(error);
    }
    const message = error instanceof Error && error.message.startsWith("UNKNOWN_") ? "The patch references an unknown diagram element." : "The diagram patch is invalid.";
    return jsonResponse({ error: { code: "INVALID_PATCH", message, retryable: false } }, { status: 400 });
  }
}
