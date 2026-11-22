import type { Diagram, DiagramPatch } from "@/domain/diagram";
import { redactPath, redactPathValues, redactSecrets } from "@/shared/redaction";
import { truncate } from "@/shared/text";

const MAX_EDIT_TEXT = 5000;

function clean(value: string): string {
  return truncate(redactPath(redactSecrets(value.replace(/[\u0000-\u001f\u007f]/g, " ").trim())), MAX_EDIT_TEXT);
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
  return redactPathValues({
    ...diagram,
    ...(patch.title !== undefined ? { title: clean(patch.title) } : {}),
    ...(patch.description !== undefined ? { description: clean(patch.description) } : {}),
    ...(patch.direction !== undefined ? { direction: patch.direction } : {}),
    ...(patch.customNote !== undefined ? { customNote: clean(patch.customNote) } : {}),
    nodes,
    edges,
    updatedAt: new Date().toISOString(),
  });
}

export function mergeDiagramEdits(base: Diagram, edited: Diagram): Diagram {
  const editedNodes = new Map(edited.nodes.map((n) => [n.id, n]));
  const editedEdges = new Map(edited.edges.map((e) => [e.id, e]));

  const nodes = base.nodes.map((node) => {
    const edit = editedNodes.get(node.id);
    if (!edit) return node;
    return {
      ...node,
      technicalLabel: edit.technicalLabel ?? node.technicalLabel,
      plainEnglishLabel: edit.plainEnglishLabel ?? node.plainEnglishLabel,
      explanation: edit.explanation ?? node.explanation,
      visible: edit.visible !== undefined ? edit.visible : node.visible,
    };
  });

  const edges = base.edges.map((edge) => {
    const edit = editedEdges.get(edge.id);
    if (!edit) return edge;
    return {
      ...edge,
      label: edit.label ?? edge.label,
      explanation: edit.explanation ?? edge.explanation,
      visible: edit.visible !== undefined ? edit.visible : edge.visible,
    };
  });

  return redactPathValues({
    ...base,
    title: edited.title ?? base.title,
    description: edited.description ?? base.description,
    direction: edited.direction ?? base.direction,
    customNote: edited.customNote ?? base.customNote,
    nodes,
    edges,
    updatedAt: edited.updatedAt ?? new Date().toISOString(),
  });
}
