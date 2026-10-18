import type { EvidenceReference } from "@/domain/evidence";
import type { Diagram } from "@/domain/diagram";
import type { ArchitectureStory, ArchitectureStep, ArchitectureActor, ArchitectureRelationship } from "@/domain/architecture-story";
import { isSecretBearingPath, redactPath, redactSecrets } from "@/shared/redaction";
import { quoteLabel, truncate } from "@/shared/text";

const MAX_EXPORTED_EVIDENCE_EXCERPT = 180;

function markdownText(value: string): string {
  return redactSecrets(value).replace(/[\r\n\t]+/g, " ").replace(/([\\`*_[\]{}()#+\-.!|<>])/g, "\\$1").trim();
}

function lineRange(evidence: EvidenceReference): string {
  if (evidence.lineStart === undefined) return "not available";
  if (evidence.lineEnd === undefined || evidence.lineEnd === evidence.lineStart) return String(evidence.lineStart);
  return `${evidence.lineStart}-${evidence.lineEnd}`;
}

function exportableEvidence(evidence: readonly EvidenceReference[]): EvidenceReference[] {
  return evidence.filter((item) => !isSecretBearingPath(item.filePath));
}

function visibleStoryElements(story: ArchitectureStory, diagram: Diagram): { actors: ArchitectureActor[]; steps: ArchitectureStep[]; relationships: ArchitectureRelationship[] } {
  const visibleNodeIds = new Set(diagram.nodes.filter((node) => node.visible).map((node) => node.id));
  const visibleEdgeIds = new Set(diagram.edges.filter((edge) => edge.visible && visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)).map((edge) => edge.id));
  const matchesVisibleNode = (nodeIds: readonly string[]): boolean => nodeIds.length > 0 && nodeIds.some((nodeId) => visibleNodeIds.has(nodeId));
  const actors = story.actors.filter((actor) => matchesVisibleNode(actor.sourceNodeIds));
  const steps = story.steps.filter((step) => matchesVisibleNode(step.sourceNodeIds));
  const actorIds = new Set(actors.map((actor) => actor.id));
  const stepIds = new Set(steps.map((step) => step.id));
  const relationships = story.relationships.filter((relationship) => {
    const sourceVisible = actorIds.has(relationship.sourceId) || stepIds.has(relationship.sourceId);
    const targetVisible = actorIds.has(relationship.targetId) || stepIds.has(relationship.targetId);
    const edgeVisible = relationship.sourceEdgeIds.length > 0 && relationship.sourceEdgeIds.some((edgeId) => visibleEdgeIds.has(edgeId));
    return sourceVisible && targetVisible && edgeVisible;
  });
  return { actors, steps, relationships };
}

function architectureSummaryMarkdown(story: ArchitectureStory, diagram: Diagram, includeEvidence: boolean): string[] {
  const elements = visibleStoryElements(story, diagram);
  const flowSteps = elements.steps.filter((step) => ["application", "api", "authentication", "database", "external-service"].includes(step.kind));
  const storyEvidence = [...elements.actors.flatMap((actor) => actor.evidence), ...elements.steps.flatMap((step) => step.evidence), ...elements.relationships.flatMap((relationship) => relationship.evidence)];
  const evidence = exportableEvidence(storyEvidence.filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index));
  const out = [
    "## How the application works",
    "",
    markdownText(story.plainEnglishSummary),
    "",
    "### Main flow",
  ];

  if (flowSteps.length) {
    for (const step of [...flowSteps].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))) {
      out.push(`${step.order}. **${markdownText(step.plainEnglishTitle || step.title)}** — ${markdownText(step.explanation)} _(confidence: ${markdownText(step.confidence)})_`);
    }
  } else {
    out.push("The analyzed files do not provide enough evidence to show a complete request or workflow flow.");
  }

  const inferred = elements.relationships.filter((relationship) => relationship.verification !== "supported");
  if (inferred.length) {
    out.push("", "### Inferred relationships");
    for (const relationship of inferred) out.push(`- ${markdownText(relationship.label)} — ${markdownText(relationship.explanation)}`);
  }

  out.push("", "### Evidence and confidence", "", `This explanation is based on ${story.confidence} confidence and repository evidence.`);
  if (includeEvidence && evidence.length) {
    for (const item of evidence) out.push(evidenceMarkdown(item));
  } else if (includeEvidence) {
    out.push("- No source references were collected for this explanation.");
  }
  if (story.caveats.length) {
    out.push("", "### Caveats");
    for (const caveat of story.caveats) out.push(`- ${markdownText(caveat)}`);
  }
  return out;
}

function evidenceMarkdown(evidence: EvidenceReference): string {
  const excerpt = evidence.excerpt
    ? markdownText(truncate(redactSecrets(evidence.excerpt).replace(/[\r\n\t]+/g, " "), MAX_EXPORTED_EVIDENCE_EXCERPT))
    : "not available";
  return `  - Evidence: path: ${markdownText(redactPath(evidence.filePath))}; lines: ${markdownText(lineRange(evidence))}; symbol: ${markdownText(evidence.symbol ?? "not available")}; reason: ${markdownText(evidence.reason)}; excerpt: ${excerpt}`;
}

export function toMermaid(diagram: Diagram): string {
  const lines = [`flowchart ${diagram.direction}`];
  const visibleNodes = diagram.nodes.filter((node) => node.visible);
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const mermaidIds = new Map<string, string>();
  const usedIds = new Set<string>();
  const safeId = (value: string, index: number): string => {
    const cached = mermaidIds.get(value);
    if (cached) return cached;
    const base = value.replace(/[^A-Za-z0-9_]/g, "_").replace(/^([^A-Za-z_])/, "n_$1") || `node_${index}`;
    let candidate = base;
    let suffix = 2;
    while (usedIds.has(candidate)) candidate = `${base}_${suffix++}`;
    usedIds.add(candidate);
    mermaidIds.set(value, candidate);
    return candidate;
  };
  visibleNodes.forEach((node, index) => lines.push(`  ${safeId(node.id, index)}["${quoteLabel(node.plainEnglishLabel)}"]`));
  for (const edge of diagram.edges.filter((item) => item.visible && visibleIds.has(item.source) && visibleIds.has(item.target))) {
    lines.push(`  ${safeId(edge.source, 0)} ${edge.inferred ? "-.->" : "-->"}|${quoteLabel(edge.label)}| ${safeId(edge.target, 0)}`);
  }
  return redactPath(redactSecrets(lines.join("\n")));
}

export function toMarkdown(diagram: Diagram, options: { includeExplanation?: boolean; includeEvidence?: boolean; includeAttribution?: boolean; includeArchitectureSummary?: boolean; architectureStory?: ArchitectureStory } = {}): string {
  const architectureSection = options.includeArchitectureSummary && options.architectureStory ? architectureSummaryMarkdown(options.architectureStory, diagram, options.includeEvidence === true) : [];
  const out = [
    `# ${markdownText(diagram.title)}`,
    "",
    markdownText(diagram.description),
    ...(diagram.customNote ? ["", `> ${markdownText(diagram.customNote)}`] : []),
    ...(architectureSection.length ? ["", ...architectureSection] : []),
    "",
    "```mermaid",
    toMermaid(diagram),
    "```",
    "",
    "## Components",
  ];

  for (const node of diagram.nodes.filter((item) => item.visible)) {
    out.push(`- **${markdownText(node.technicalLabel)}** — ${markdownText(node.plainEnglishLabel)} _(confidence: ${node.confidence})_`);
    if (options.includeExplanation !== false) out.push(`  - ${markdownText(node.explanation)}`);
    if (options.includeEvidence) out.push(...exportableEvidence(node.evidence).map(evidenceMarkdown));
  }

  const visibleIds = new Set(diagram.nodes.filter((node) => node.visible).map((node) => node.id));
  const visibleEdges = diagram.edges.filter((edge) => edge.visible && visibleIds.has(edge.source) && visibleIds.has(edge.target));
  if (visibleEdges.length) {
    out.push("", "## Connections");
    for (const edge of visibleEdges) {
      out.push(`- **${markdownText(edge.label)}** _(confidence: ${edge.confidence})_`);
      if (options.includeExplanation !== false && edge.explanation) out.push(`  - ${markdownText(edge.explanation)}`);
      if (options.includeEvidence) out.push(...exportableEvidence(edge.evidence).map(evidenceMarkdown));
    }
  }

  if (options.includeAttribution) out.push("", "_Generated by RepoStory from public repository evidence._");
  return redactSecrets(out.join("\n"));
}
