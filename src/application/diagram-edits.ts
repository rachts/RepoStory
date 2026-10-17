import type { Diagram, DiagramPatch } from "@/domain/diagram";
import { redactSecrets } from "@/shared/redaction";
import { truncate } from "@/shared/text";

const MAX_EDIT_TEXT = 5000;

function clean(value: string): string {
  return truncate(redactSecrets(value.replace(/[\u0000-\u001f\u007f]/g, " ").trim()), MAX_EDIT_TEXT);
}

export function applyDiagramPatch(diagram: Diagram, patch: DiagramPatch): Diagram {
  const nodeUpdates = new Map((patch.nodeUpdates ?? []).map((update) => [update.nodeId, update]));
  const edgeUpdates = new Map((patch.edgeUpdates ?? []).map((update) => [update.edgeId, update]));
  const nodes = diagram.nodes.map((node) => {
    const update = nodeUpdates.get(node.id);
    if (!update) return node;
    return {
      ...node,
      ...(update.technicalLabel !== undefined ? { technicalLabel: clean(update.technicalLabel) } : {}),
      ...(update.plainEnglishLabel !== undefined ? { plainEnglishLabel: clean(update.plainEnglishLabel) } : {}),
      ...(update.explanation !== undefined ? { explanation: clean(update.explanation) } : {}),
      ...(update.visible !== undefined ? { visible: update.visible } : {}),
    };
  });
  const edges = diagram.edges.map((edge) => {
    const update = edgeUpdates.get(edge.id);
    if (!update) return edge;
    return {
      ...edge,
      ...(update.label !== undefined ? { label: clean(update.label) } : {}),
      ...(update.explanation !== undefined ? { explanation: clean(update.explanation) } : {}),
      ...(update.visible !== undefined ? { visible: update.visible } : {}),
    };
  });
  return {
    ...diagram,
    ...(patch.title !== undefined ? { title: clean(patch.title) } : {}),
    ...(patch.description !== undefined ? { description: clean(patch.description) } : {}),
    ...(patch.direction !== undefined ? { direction: patch.direction } : {}),
    ...(patch.customNote !== undefined ? { customNote: clean(patch.customNote) } : {}),
    nodes,
    edges,
    updatedAt: new Date().toISOString(),
  };
}
