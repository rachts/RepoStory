"use client";

import "@xyflow/react/dist/style.css";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, ReactFlow, type Edge, type Node } from "@xyflow/react";
import type { AnalysisJob } from "@/domain/analysis";
import type { ArchitectureStory } from "@/domain/architecture-story";
import type { Diagram, DiagramDirection, DiagramEdge, DiagramNode, DiagramType } from "@/domain/diagram";

interface AnalysisResponse extends AnalysisJob { diagrams: Diagram[]; architectureStory?: ArchitectureStory }
interface ExportResponse { content: string; filename: string; mimeType: string }
interface RepoAnalysisProps { analysisId: string }

const SUPPORTED_DIAGRAM_TYPES: readonly DiagramType[] = ["repository-structure", "system-overview", "api-request-flow", "authentication-flow"];
const DIAGRAM_TYPE_LABELS: Record<DiagramType, string> = { "repository-structure": "Repository structure", "system-overview": "System overview", "api-request-flow": "API request flow", "authentication-flow": "Authentication flow" };
const DIAGRAM_TYPE_ORDER: Record<DiagramType, number> = { "system-overview": 0, "api-request-flow": 1, "authentication-flow": 2, "repository-structure": 3 };

function fallbackNodePosition(index: number, direction: DiagramDirection): { x: number; y: number } {
  const spacing = 220;
  if (direction === "TB" || direction === "BT") return { x: 120, y: index * spacing * (direction === "BT" ? -1 : 1) };
  return { x: index * spacing * (direction === "RL" ? -1 : 1), y: 80 };
}

function getSupportedDiagrams(diagrams: readonly Diagram[]): Diagram[] {
  return diagrams
    .filter((item) => SUPPORTED_DIAGRAM_TYPES.includes(item.type))
    .map((item, index) => ({ item, index }))
    .sort((left, right) => DIAGRAM_TYPE_ORDER[left.item.type] - DIAGRAM_TYPE_ORDER[right.item.type] || left.index - right.index)
    .map(({ item }) => item);
}

export function RepoAnalysis({ analysisId }: RepoAnalysisProps): React.JSX.Element {
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<"technical" | "plain">("plain");
  const [includeArchitectureSummary, setIncludeArchitectureSummary] = useState(true);
  const [selectedElement, setSelectedElement] = useState<{ type: "node" | "edge"; id: string } | null>(null);
  const [draft, setDraft] = useState<Diagram | null>(null);
  const [history, setHistory] = useState<Diagram[]>([]);
  const [future, setFuture] = useState<Diagram[]>([]);
  const [saved, setSaved] = useState(true);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [exportState, setExportState] = useState<"idle" | "saving" | "exporting">("idle");
  const [exportError, setExportError] = useState("");
  const draftRevisionRef = useRef(0);
  const exportRequestRef = useRef(0);

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setError("");
    try {
      const response = await fetch(`/api/analysis/${encodeURIComponent(analysisId)}`, { cache: "no-store", ...(signal ? { signal } : {}) });
      const payload = (await response.json().catch(() => null)) as AnalysisResponse | { error?: { message?: string } } | null;
      if (!response.ok) throw new Error((payload as { error?: { message?: string } } | null)?.error?.message ?? "This analysis could not be loaded.");
      const result = payload as AnalysisResponse;
      if (!result || !Array.isArray(result.diagrams)) throw new Error("This analysis response was incomplete.");
      const supportedDiagrams = getSupportedDiagrams(result.diagrams ?? []);
      if (signal?.aborted) return;
      setAnalysis(result);
      setSelectedId((current) => current && supportedDiagrams.some((item) => item.id === current) ? current : supportedDiagrams[0]?.id ?? null);
    } catch (loadError) {
      if (signal?.aborted) return;
      setError(loadError instanceof Error ? loadError.message : "This analysis could not be loaded.");
    }
  }, [analysisId]);

  useEffect(() => { // Synchronize the workspace with the server analysis.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAnalysis(null);
    setSelectedId(null);
    setSelectedElement(null);
    setDraft(null);
    setHistory([]);
    setFuture([]);
    setSaved(true);
    setFeedback("");
    setExportError("");
    draftRevisionRef.current += 1;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const availableDiagrams = useMemo(() => getSupportedDiagrams(analysis?.diagrams ?? []), [analysis?.diagrams]);
  const diagram = draft ?? availableDiagrams.find((item) => item.id === selectedId) ?? availableDiagrams[0] ?? null;
  const story = analysis?.architectureStory;
  const selectedNode = diagram && selectedElement?.type === "node" ? diagram.nodes.find((node) => node.id === selectedElement.id) ?? null : null;
  const selectedEdge = diagram && selectedElement?.type === "edge" ? diagram.edges.find((edge) => edge.id === selectedElement.id) ?? null : null;
  const visibleNodes = useMemo(() => diagram?.nodes.filter((item) => item.visible) ?? [], [diagram]);
  const nodes = useMemo<Node[]>(() => visibleNodes.map((item, index) => ({ id: item.id, position: item.position ?? fallbackNodePosition(index, diagram?.direction ?? "LR"), data: { label: <div className="flow-node"><strong>{mode === "technical" ? item.technicalLabel : item.plainEnglishLabel}</strong><small>{item.kind}</small></div> }, type: "default" })), [diagram?.direction, mode, visibleNodes]);
  const edges = useMemo<Edge[]>(() => diagram ? diagram.edges.filter((item) => item.visible && visibleNodes.some((node) => node.id === item.source) && visibleNodes.some((node) => node.id === item.target)).map((item) => ({ id: item.id, source: item.source, target: item.target, label: item.label, style: item.inferred || item.confidence !== "high" ? { strokeDasharray: "5 4" } : undefined })) : [], [diagram, visibleNodes]);
  const evidence = diagram?.nodes.flatMap((node) => node.evidence).filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index) ?? [];
  const isWorking = !analysis || analysis.status === "pending" || analysis.status === "running";

  const selectDiagram = (next: Diagram): void => { draftRevisionRef.current += 1; setSelectedId(next.id); setDraft(null); setHistory([]); setFuture([]); setSaved(true); setSelectedElement(null); };
  const edit = (next: Diagram): void => { if (!diagram) return; draftRevisionRef.current += 1; setHistory((items) => [...items, diagram]); setFuture([]); setDraft(next); setSaved(false); setExportError(""); };
  const updateDiagram = (updates: Partial<Diagram>): void => { if (diagram) edit({ ...diagram, ...updates, updatedAt: new Date().toISOString() }); };
  const updateNode = (updates: Partial<DiagramNode>): void => { if (diagram && selectedNode) edit({ ...diagram, nodes: diagram.nodes.map((node) => node.id === selectedNode.id ? { ...node, ...updates } : node), updatedAt: new Date().toISOString() }); };
  const updateEdge = (updates: Partial<DiagramEdge>): void => { if (diagram && selectedEdge) edit({ ...diagram, edges: diagram.edges.map((edge) => edge.id === selectedEdge.id ? { ...edge, ...updates } : edge), updatedAt: new Date().toISOString() }); };
  const undo = (): void => { const previous = history.at(-1); if (!diagram || !previous) return; draftRevisionRef.current += 1; setFuture((items) => [...items, diagram]); setHistory((items) => items.slice(0, -1)); setDraft(previous); setSaved(false); setExportError(""); };
  const redo = (): void => { const next = future.at(-1); if (!diagram || !next) return; draftRevisionRef.current += 1; setHistory((items) => [...items, diagram]); setFuture((items) => items.slice(0, -1)); setDraft(next); setSaved(false); setExportError(""); };
  const patchDiagram = async (next: Diagram): Promise<Diagram> => {
    const response = await fetch(`/api/diagrams/${encodeURIComponent(next.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: next.title, description: next.description, direction: next.direction, customNote: next.customNote, nodeUpdates: next.nodes.map(({ id, technicalLabel, plainEnglishLabel, explanation, visible }) => ({ nodeId: id, technicalLabel, plainEnglishLabel, explanation, visible })), edgeUpdates: next.edges.map(({ id, label, explanation, visible }) => ({ edgeId: id, label, explanation, visible })) }) });
    const payload = await response.json().catch(() => null) as { diagram?: Diagram; error?: { message?: string } } | null;
    if (!response.ok || !payload?.diagram) throw new Error(payload?.error?.message ?? "Could not save changes.");
    return payload.diagram;
  };
  const applyPersistedDiagram = (persisted: Diagram, revision: number): void => {
    setAnalysis((current) => current ? { ...current, diagrams: current.diagrams.map((item) => item.id === persisted.id ? persisted : item) } : current);
    if (draftRevisionRef.current !== revision) return;
    setDraft(null); setHistory([]); setFuture([]); setSaved(true);
  };
  const save = async (): Promise<void> => {
    if (!diagram || exportState !== "idle") return;
    const revision = draftRevisionRef.current;
    try {
      const persisted = await patchDiagram(diagram);
      applyPersistedDiagram(persisted, revision);
      setFeedback(draftRevisionRef.current === revision ? "Saved" : "Saved previous changes; newer edits remain unsaved.");
      window.setTimeout(() => setFeedback(""), 1800);
    } catch (saveError) { setFeedback(saveError instanceof Error ? saveError.message : "Could not save changes."); }
  };
  const reset = async (): Promise<void> => {
    if (!diagram) return;
    if (!saved && !window.confirm("Discard unsaved diagram edits?")) return;
    setExportError("");
    try {
      const response = await fetch(`/api/diagrams/${encodeURIComponent(diagram.id)}/reset`, { method: "POST" });
      const payload = await response.json().catch(() => null) as { diagram?: Diagram; error?: { message?: string } } | null;
      if (!response.ok || !payload?.diagram) throw new Error(payload?.error?.message ?? "Could not reset changes.");
      draftRevisionRef.current += 1;
      setAnalysis((current) => current ? { ...current, diagrams: current.diagrams.map((item) => item.id === payload.diagram?.id ? payload.diagram : item).filter((item): item is Diagram => Boolean(item)) } : current);
      setDraft(null);
      setHistory([]);
      setFuture([]);
      setSaved(true);
      setFeedback("Reset");
    } catch (resetError) {
      setExportError(resetError instanceof Error ? resetError.message : "Could not reset changes.");
    }
  };
  const copyExport = async (format: "mermaid" | "markdown"): Promise<void> => {
    if (!diagram || exportState !== "idle") return;
    const requestId = exportRequestRef.current + 1;
    const revision = draftRevisionRef.current;
    const requestedDiagram = diagram;
    exportRequestRef.current = requestId;
    setExportError("");
    setExportState(saved ? "exporting" : "saving");
    try {
      if (!saved) {
        const persisted = await patchDiagram(requestedDiagram);
        if (requestId !== exportRequestRef.current || revision !== draftRevisionRef.current) throw new Error("The diagram changed while saving. No export was copied; try again.");
        applyPersistedDiagram(persisted, revision);
      }
      if (requestId !== exportRequestRef.current || revision !== draftRevisionRef.current) throw new Error("The diagram changed while exporting. No export was copied; try again.");
      setExportState("exporting");
       const response = await fetch("/api/exports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ diagramId: requestedDiagram.id, format, includeExplanation: true, includeEvidence: true, includeAttribution: false, includeArchitectureSummary: format === "markdown" && includeArchitectureSummary }) });
      const payload = await response.json().catch(() => null) as ExportResponse | { error?: { message?: string } } | null;
      if (!response.ok || !payload || !("content" in payload)) throw new Error((payload as { error?: { message?: string } } | null)?.error?.message ?? "The export could not be generated.");
      if (requestId !== exportRequestRef.current || revision !== draftRevisionRef.current) throw new Error("The diagram changed while exporting. No export was copied; try again.");
      await navigator.clipboard.writeText(payload.content);
      setFeedback(`${format === "markdown" ? "README Markdown" : "Mermaid"} copied`); window.setTimeout(() => setFeedback(""), 1800);
    } catch (exportRequestError) {
      if (requestId === exportRequestRef.current) setExportError(exportRequestError instanceof Error ? exportRequestError.message : "The export could not be generated.");
    } finally {
      if (requestId === exportRequestRef.current) setExportState("idle");
    }
  };

  if (analysis && story && diagram) {
    return <StoryFirstWorkspace
      analysis={analysis}
      story={story}
      diagram={diagram}
      availableDiagrams={availableDiagrams}
      selectedNode={selectedNode}
      selectedEdge={selectedEdge}
      nodes={nodes}
      edges={edges}
      mode={mode}
      saved={saved}
      feedback={feedback}
      exportState={exportState}
      exportError={exportError}
      includeArchitectureSummary={includeArchitectureSummary}
      onModeChange={setMode}
      onSelectDiagram={selectDiagram}
      onSelect={setSelectedElement}
      onUndo={undo}
      onRedo={redo}
      onReset={() => void reset()}
      onSave={() => void save()}
      onCopyExport={(format) => copyExport(format)}
      onIncludeArchitectureSummaryChange={setIncludeArchitectureSummary}
      onDiagramChange={updateDiagram}
      onNodeChange={updateNode}
      onEdgeChange={updateEdge}
    />;
  }

  return <main className="analysis-page">
    <header className="analysis-header page-width"><Link className="brand" href="/"><span className="brand-mark">R</span> RepoStory</Link><div className="analysis-repo"><span className="repo-kicker">ANALYSIS</span><strong>{analysis ? `${analysis.repository.owner}/${analysis.repository.name}` : "Loading repository…"}</strong></div><Link className="back-link" href="/">← New repository</Link></header>
    {error ? <StateCard title="We couldn’t read this story." message={error} action={<button className="secondary-button" onClick={() => void load()}>Try again</button>} /> : isWorking ? <ProgressState progress={analysis?.progressPercent ?? 8} stage={analysis?.stage ?? "validating"} /> : analysis?.status === "failed" ? <StateCard title="The analysis stopped early." message={analysis.error?.message ?? "The repository could not be analyzed."} /> : !diagram ? story ? <StoryWithoutDiagram analysis={analysis} story={story} /> : <StateCard title="No supported diagram is available." message="No supported diagrams are available for this repository." details={<AvailabilityList availability={analysis?.diagramAvailability} />} /> : <>
        <div className="diagram-toolbar page-width"><strong>Diagram workspace</strong><span className={saved ? "save-state" : "save-state unsaved"}>{feedback || (saved ? "Saved" : "Unsaved changes")}</span><button aria-label="Undo" className="toolbar-button" onClick={undo} disabled={!history.length || exportState !== "idle"}>Undo</button><button aria-label="Redo" className="toolbar-button" onClick={redo} disabled={!future.length || exportState !== "idle"}>Redo</button><button className="toolbar-button" onClick={() => void reset()} disabled={exportState !== "idle"}>Reset</button><button className="primary-button" onClick={() => void save()} disabled={saved || exportState !== "idle"}>Save changes</button></div>
        <section className="results-layout page-width"><aside className="diagram-sidebar"><p className="eyebrow"><span className="eyebrow-line" /> Story maps</p><h1>{analysis.repository.name}</h1><p className="sidebar-description">{analysis.repository.description ?? "A guided view of the codebase."}</p><div className="diagram-list" aria-label="Available story maps">{availableDiagrams.map((item, index) => <button key={item.id} aria-label={`${DIAGRAM_TYPE_LABELS[item.type]}: ${item.title}`} className={`diagram-item ${item.id === diagram.id ? "active" : ""}`} data-diagram-type={item.type} onClick={() => selectDiagram(item)}><span className="diagram-index">{String(index + 1).padStart(2, "0")}</span><span><strong>{item.title}</strong><small>{DIAGRAM_TYPE_LABELS[item.type]} · {item.nodes.length} nodes · {item.edges.length} connections</small></span><span>→</span></button>)}{analysis.diagramAvailability?.filter((item) => !item.available).map((item) => <div key={item.type} className="unavailable-diagram"><strong>{DIAGRAM_TYPE_LABELS[item.type]}</strong><small>{item.reason ?? "Not enough evidence to generate this diagram."}</small></div>)}</div><div className="sidebar-note"><span>✦</span><p>Every label is grounded in repository evidence.</p></div></aside>
           <div className="results-main"><div className="results-title"><div><p className="eyebrow"><span className="eyebrow-line" /> Interactive preview</p><h2>{diagram.title}</h2><p>{diagram.description}</p></div><div className="toggle" role="group" aria-label="Label language"><button className={mode === "technical" ? "selected" : ""} aria-pressed={mode === "technical"} onClick={() => setMode("technical")}>Technical</button><button className={mode === "plain" ? "selected" : ""} aria-pressed={mode === "plain"} onClick={() => setMode("plain")}>Plain English</button></div></div><div className="flow-wrap" role="region" aria-label={`${diagram.title} diagram`}><ReactFlow nodes={nodes} edges={edges} fitView onNodeClick={(_event, node) => setSelectedElement({ type: "node", id: node.id })} onEdgeClick={(_event, edge) => setSelectedElement({ type: "edge", id: edge.id })}><Background color="#d9d8cf" gap={24} /><Controls /></ReactFlow></div><div className="results-toolbar"><label className="direction-control">Direction<select value={diagram.direction} onChange={(event) => updateDiagram({ direction: event.target.value as DiagramDirection })} disabled={exportState !== "idle"}><option value="TB">Top to bottom</option><option value="LR">Left to right</option><option value="RL">Right to left</option><option value="BT">Bottom to top</option></select></label><button className="secondary-button" onClick={() => void copyExport("mermaid")} disabled={exportState !== "idle"}>Copy Mermaid</button><button className="primary-button" onClick={() => void copyExport("markdown")} disabled={exportState !== "idle"}>Copy README Markdown</button>{exportState !== "idle" ? <span className="export-status" role="status" aria-live="polite">{exportState === "saving" ? "Saving changes before export…" : "Generating export…"}</span> : null}{exportError ? <p className="export-error" role="alert">{exportError}</p> : null}</div><EvidenceSection evidence={evidence} /></div>
        <EditorPanel diagram={diagram} selectedNode={selectedNode} selectedEdge={selectedEdge} onDiagramChange={updateDiagram} onNodeChange={updateNode} onEdgeChange={updateEdge} onSelect={setSelectedElement} />
      </section></>}
  </main>;
}

type LabelMode = "technical" | "plain";

interface StoryFirstWorkspaceProps {
  analysis: AnalysisResponse;
  story: ArchitectureStory;
  diagram: Diagram;
  availableDiagrams: Diagram[];
  selectedNode: DiagramNode | null;
  selectedEdge: DiagramEdge | null;
  nodes: Node[];
  edges: Edge[];
  mode: LabelMode;
  saved: boolean;
  feedback: string;
  exportState: "idle" | "saving" | "exporting";
  exportError: string;
  includeArchitectureSummary: boolean;
  onModeChange: (mode: LabelMode) => void;
  onSelectDiagram: (diagram: Diagram) => void;
  onSelect: (selection: { type: "node" | "edge"; id: string } | null) => void;
  onUndo: () => void;
  onRedo: () => void;
  onReset: () => void;
  onSave: () => void;
  onCopyExport: (format: "mermaid" | "markdown") => Promise<void>;
  onIncludeArchitectureSummaryChange: (value: boolean) => void;
  onDiagramChange: (updates: Partial<Diagram>) => void;
  onNodeChange: (updates: Partial<DiagramNode>) => void;
  onEdgeChange: (updates: Partial<DiagramEdge>) => void;
}

function StoryFirstWorkspace(props: StoryFirstWorkspaceProps): React.JSX.Element {
  const { analysis, story, diagram, availableDiagrams, selectedNode, selectedEdge, nodes, edges, mode, saved, feedback, exportState, exportError, includeArchitectureSummary, onModeChange, onSelectDiagram, onSelect, onUndo, onRedo, onReset, onSave, onCopyExport, onIncludeArchitectureSummaryChange, onDiagramChange, onNodeChange, onEdgeChange } = props;
  const evidence = diagram.nodes.flatMap((node) => node.evidence).filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index);

  return <main className="analysis-page">
    <header className="analysis-header page-width"><Link className="brand" href="/"><span className="brand-mark">R</span> RepoStory</Link><div className="analysis-repo"><span className="repo-kicker">ANALYSIS</span><strong>{analysis.repository.owner}/{analysis.repository.name}</strong></div><Link className="back-link" href="/">← New repository</Link></header>
    <ArchitectureStoryIntro repositoryName={analysis.repository.name} story={story} />
    <ArchitectureSteps story={story} />
    <CoverageSummary story={story} />
    <div className="diagram-toolbar page-width"><strong>Diagram workspace</strong><span className={saved ? "save-state" : "save-state unsaved"}>{feedback || (saved ? "Saved" : "Unsaved changes")}</span><button aria-label="Undo" className="toolbar-button" onClick={onUndo} disabled={exportState !== "idle"}>Undo</button><button aria-label="Redo" className="toolbar-button" onClick={onRedo} disabled={exportState !== "idle"}>Redo</button><button className="toolbar-button" onClick={onReset} disabled={exportState !== "idle"}>Reset</button><button className="primary-button" onClick={onSave} disabled={saved || exportState !== "idle"}>Save changes</button></div>
    <section className="results-layout page-width"><aside className="diagram-sidebar"><p className="eyebrow"><span className="eyebrow-line" /> Story maps</p><h1>{analysis.repository.name}</h1><p className="sidebar-description">Start with the simplified overview, then open a request or authentication flow for more detail.</p><div className="diagram-list" aria-label="Available story maps">{availableDiagrams.map((item, index) => <button key={item.id} aria-label={`${DIAGRAM_TYPE_LABELS[item.type]}: ${item.title}`} className={`diagram-item ${item.id === diagram.id ? "active" : ""}`} data-diagram-type={item.type} onClick={() => onSelectDiagram(item)}><span className="diagram-index">{String(index + 1).padStart(2, "0")}</span><span><strong>{item.title}</strong><small>{DIAGRAM_TYPE_LABELS[item.type]} · {item.nodes.length} nodes · {item.edges.length} connections</small></span><span>→</span></button>)}{analysis.diagramAvailability?.filter((item) => !item.available).map((item) => <div key={item.type} className="unavailable-diagram"><strong>{DIAGRAM_TYPE_LABELS[item.type]}</strong><small>{item.reason ?? "Not enough evidence to generate this diagram."}</small></div>)}</div><div className="sidebar-note"><span>✦</span><p>Every label is grounded in repository evidence.</p></div></aside>
           <div className="results-main"><div className="results-title"><div><p className="eyebrow"><span className="eyebrow-line" /> {diagram.type === "system-overview" ? "Start here" : "Interactive preview"}</p><h2>{diagram.title}</h2><p>{diagram.description}</p></div><div className="toggle" role="group" aria-label="Label language"><button className={mode === "technical" ? "selected" : ""} aria-pressed={mode === "technical"} onClick={() => onModeChange("technical")}>Technical</button><button className={mode === "plain" ? "selected" : ""} aria-pressed={mode === "plain"} onClick={() => onModeChange("plain")}>Plain English</button></div></div><HowToReadDiagram /><div className="flow-wrap" role="region" aria-label={`${diagram.title} diagram`}><ReactFlow nodes={nodes} edges={edges} fitView onNodeClick={(_event, node) => onSelect({ type: "node", id: node.id })} onEdgeClick={(_event, edge) => onSelect({ type: "edge", id: edge.id })}><Background color="#d9d8cf" gap={24} /><Controls /></ReactFlow></div><div className="results-toolbar"><label className="direction-control">Direction<select value={diagram.direction} onChange={(event) => onDiagramChange({ direction: event.target.value as DiagramDirection })} disabled={exportState !== "idle"}><option value="TB">Top to bottom</option><option value="LR">Left to right</option><option value="RL">Right to left</option><option value="BT">Bottom to top</option></select></label><label className="summary-export-option"><input type="checkbox" checked={includeArchitectureSummary} onChange={(event) => onIncludeArchitectureSummaryChange(event.target.checked)} disabled={exportState !== "idle"} /> Include plain-English architecture summary</label><button className="secondary-button" onClick={() => void onCopyExport("mermaid")} disabled={exportState !== "idle"}>Copy Mermaid</button><button className="primary-button" onClick={() => void onCopyExport("markdown")} disabled={exportState !== "idle"}>Copy README Markdown</button>{exportState !== "idle" ? <span className="export-status" role="status" aria-live="polite">{exportState === "saving" ? "Saving changes before export…" : "Generating export…"}</span> : null}{exportError ? <p className="export-error" role="alert">{exportError}</p> : null}</div><EvidenceSection evidence={evidence} /></div>
      <aside className="editor-panel editor-stack"><NodeDetailPanel diagram={diagram} selectedNode={selectedNode} /><EditorPanel diagram={diagram} selectedNode={selectedNode} selectedEdge={selectedEdge} onDiagramChange={onDiagramChange} onNodeChange={onNodeChange} onEdgeChange={onEdgeChange} onSelect={onSelect} /></aside>
    </section>
  </main>;
}

function StoryWithoutDiagram({ analysis, story }: { analysis: AnalysisResponse; story: ArchitectureStory }): React.JSX.Element {
  const isEmpty = story.coverage.status === "empty";
  return <main className="analysis-page">
    <header className="analysis-header page-width"><Link className="brand" href="/"><span className="brand-mark">R</span> RepoStory</Link><div className="analysis-repo"><span className="repo-kicker">ANALYSIS</span><strong>{analysis.repository.owner}/{analysis.repository.name}</strong></div><Link className="back-link" href="/">← New repository</Link></header>
    <ArchitectureStoryIntro repositoryName={analysis.repository.name} story={story} />
    <ArchitectureSteps story={story} />
    <CoverageSummary story={story} />
    <StateCard title={isEmpty ? "No evidence-backed map is available." : "No visual map is available."} message={isEmpty ? story.plainEnglishSummary : "The plain-English story is available, but no supported diagram was generated from the analyzed evidence."} details={<AvailabilityList availability={analysis.diagramAvailability} />} />
  </main>;
}

function confidenceLabel(value: string): string {
  return value === "needs-verification" ? "Needs verification" : value.charAt(0).toUpperCase() + value.slice(1);
}

function ArchitectureStoryIntro({ repositoryName, story }: { repositoryName: string; story: ArchitectureStory }): React.JSX.Element {
  const caveat = story.caveats[0];
  return <section className="story-intro page-width" aria-labelledby="architecture-story-heading"><div className="story-intro-copy"><p className="eyebrow"><span className="eyebrow-line" /> What this application does</p><h1 id="architecture-story-heading">{story.headline || `How ${repositoryName} works`}</h1><p className="story-summary">{story.plainEnglishSummary}</p><div className="story-trust"><span className={`confidence-pill confidence-${story.confidence}`}>{confidenceLabel(story.confidence)}</span><span>Based on repository evidence</span></div></div>{caveat ? <aside className="story-caveat"><strong>Important caveat</strong><p>{caveat}</p></aside> : null}</section>;
}

interface NarrativeFlowStep {
  title: string;
  explanation: string;
  confidence: ArchitectureStory["confidence"];
  inferred: boolean;
}

function buildNarrativeFlow(story: ArchitectureStory): NarrativeFlowStep[] {
  const people = story.actors.filter((actor) => actor.kind === "person" || actor.kind === "browser");
  const frontend = story.actors.filter((actor) => actor.kind === "frontend");
  const backend = story.actors.filter((actor) => actor.kind === "backend");
  const data = [...story.actors.filter((actor) => actor.kind === "database"), ...story.steps.filter((step) => step.kind === "database")];
  const services = [...story.actors.filter((actor) => actor.kind === "external-service"), ...story.steps.filter((step) => step.kind === "external-service")];
  const routes = story.steps.filter((step) => step.kind === "api");
  if (!story.coverage.apiRequestFlowAvailable || !routes.length) return [];
  const result: NarrativeFlowStep[] = [];
  if (people.length && frontend.length) result.push({ title: "A person starts an action.", explanation: "The repository shows a web interface that a person can open in a browser.", confidence: people[0]?.confidence ?? "medium", inferred: true });
  if (frontend.length && backend.length) result.push({ title: "The browser sends a request.", explanation: "The web interface and server-side request evidence suggest that information moves from the browser to the application.", confidence: "medium", inferred: true });
  if (backend.length) result.push({ title: "The application receives and processes it.", explanation: routes.map((step) => step.plainEnglishTitle).join("; ") || "The repository contains evidence of application request handling.", confidence: routes[0]?.confidence ?? backend[0]?.confidence ?? "medium", inferred: false });
  if (data.length || services.length) result.push({ title: "The application reads data or contacts a connected service.", explanation: data.length && services.length ? "The repository shows both application data evidence and connected-service evidence." : data.length ? "The repository shows application data evidence." : "The repository shows connected-service evidence.", confidence: "medium", inferred: true });
  result.push({ title: "A result returns to the browser.", explanation: "The request flow indicates a result path, but static analysis does not execute the application or observe a live response.", confidence: "medium", inferred: true });
  if (frontend.length) result.push({ title: "The user sees the result.", explanation: "The web interface is the repository-backed place where a returned result can be displayed.", confidence: frontend[0]?.confidence ?? "medium", inferred: true });
  return result;
}

function ArchitectureSteps({ story }: { story: ArchitectureStory }): React.JSX.Element {
  const steps = buildNarrativeFlow(story);
  return <section className="story-steps page-width" aria-labelledby="architecture-flow-heading"><div className="section-rule" /><div className="story-section-heading"><div><p className="eyebrow"><span className="eyebrow-line" /> How a request moves</p><h2 id="architecture-flow-heading">The path from action to result</h2></div><span className="story-section-note">{story.coverage.apiRequestFlowAvailable ? "Evidence-backed request flow" : "Request flow not confirmed"}</span></div>{steps.length ? <ol className="story-step-list">{steps.map((step, index) => <li key={`${index}-${step.title}`} className={step.inferred ? "is-inferred" : ""}><span className="story-step-number">{String(index + 1).padStart(2, "0")}</span><div><h3>{step.title}</h3><p>{step.explanation}</p><small>{step.inferred ? "Inferred from repository evidence" : `${confidenceLabel(step.confidence)} confidence`}</small></div></li>)}</ol> : <div className="story-empty-state"><strong>No clear API request flow was detected in the analyzed files.</strong><p>Repository structure may still be available below, but the analyzed files do not show enough evidence to describe a request sequence.</p></div>}</section>;
}

function CoverageSummary({ story }: { story: ArchitectureStory }): React.JSX.Element {
  const coverage = story.coverage;
  const statusLabel = coverage.status === "complete" ? "Complete view" : coverage.status === "empty" ? "No evidence" : "Partial view";
  const formatBytes = (value: number): string => {
    if (!Number.isFinite(value) || value < 0) return "unknown";
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  };
  return <section className="coverage-summary page-width" aria-label="Analysis coverage"><div className="coverage-heading"><p className="eyebrow"><span className="eyebrow-line" /> Coverage</p><span className={`coverage-status status-${coverage.status}`}>{statusLabel}</span></div><div className="coverage-items"><span><strong>{coverage.filesAnalyzed}</strong> files analyzed</span><span><strong>{coverage.filesDiscovered}</strong> files discovered</span>{coverage.filesSkipped !== undefined ? <span><strong>{coverage.filesSkipped}</strong> files skipped</span> : null}<span><strong>{coverage.availableDiagramTypes.length}</strong> diagram types available</span><span><strong>{coverage.evidenceBackedFindings}</strong> evidence-backed findings</span>{coverage.bytesAnalyzed !== undefined && coverage.bytesAnalyzed > 0 ? <span><strong>{formatBytes(coverage.bytesAnalyzed)}</strong> analyzed</span> : null}</div></section>;
}

function HowToReadDiagram(): React.JSX.Element {
  return <aside className="how-to-read" aria-label="How to read this diagram"><strong>How to read this diagram</strong><ul><li>Boxes represent major parts of the application.</li><li>Arrows show how information moves.</li><li>Solid lines are directly supported by repository evidence.</li><li>Dashed lines indicate an inferred relationship.</li><li>Select a box to see the files and evidence behind it.</li></ul></aside>;
}

function NodeDetailPanel({ diagram, selectedNode }: { diagram: Diagram; selectedNode: DiagramNode | null }): React.JSX.Element {
  if (!selectedNode) return <section className="node-detail-panel node-detail-empty"><p className="eyebrow"><span className="eyebrow-line" /> Selected part</p><p>Select a box in the diagram to see its plain-English meaning and source evidence.</p></section>;
  const connected = diagram.edges.filter((edge) => edge.visible && (edge.source === selectedNode.id || edge.target === selectedNode.id)).map((edge) => {
    const otherId = edge.source === selectedNode.id ? edge.target : edge.source;
    return diagram.nodes.find((node) => node.id === otherId)?.plainEnglishLabel ?? otherId;
  });
  const evidence = selectedNode.evidence.slice(0, 4);
  return <section className="node-detail-panel" aria-labelledby="selected-node-heading"><p className="eyebrow"><span className="eyebrow-line" /> Selected part</p><h3 id="selected-node-heading">{selectedNode.plainEnglishLabel}</h3><dl><div><dt>What it does</dt><dd>{selectedNode.explanation}</dd></div><div><dt>How it connects</dt><dd>{connected.length ? `Connects with ${connected.join(", ")}.` : "No connected visible relationship was confirmed in this map."}</dd></div><div><dt>Technical name</dt><dd className="technical-value">{selectedNode.technicalLabel}</dd></div></dl><div className="node-detail-evidence"><strong>Evidence</strong>{evidence.length ? evidence.map((item) => <span key={item.id}>{item.filePath}{item.lineStart ? `:${item.lineStart}` : ""}</span>) : <span>No source references collected.</span>}</div><div className="node-detail-confidence"><span className={`confidence-pill confidence-${selectedNode.confidence}`}>{confidenceLabel(selectedNode.confidence)}</span>{selectedNode.confidence === "needs-verification" ? <span>This relationship should be verified by the project owner.</span> : <span>Confidence and evidence are preserved from the static analysis.</span>}</div></section>;
}

function EditorPanel({ diagram, selectedNode, selectedEdge, onDiagramChange, onNodeChange, onEdgeChange, onSelect }: { diagram: Diagram; selectedNode: DiagramNode | null; selectedEdge: DiagramEdge | null; onDiagramChange: (updates: Partial<Diagram>) => void; onNodeChange: (updates: Partial<DiagramNode>) => void; onEdgeChange: (updates: Partial<DiagramEdge>) => void; onSelect: (selection: { type: "node" | "edge"; id: string } | null) => void }): React.JSX.Element {
  return <aside className="editor-panel"><p className="eyebrow"><span className="eyebrow-line" /> Properties</p><label>Title<input value={diagram.title} onChange={(event) => onDiagramChange({ title: event.target.value })} /></label><label>Description<textarea value={diagram.description} onChange={(event) => onDiagramChange({ description: event.target.value })} /></label><label>Custom note<textarea value={diagram.customNote ?? ""} onChange={(event) => onDiagramChange({ customNote: event.target.value })} placeholder="Optional note for readers" /></label><label>Element<select value={selectedNode ? `node:${selectedNode.id}` : selectedEdge ? `edge:${selectedEdge.id}` : ""} onChange={(event) => { const [type, id] = event.target.value.split(":"); onSelect(type && id ? { type: type as "node" | "edge", id } : null); }}><option value="">Select an element</option><optgroup label="Nodes">{diagram.nodes.map((node) => <option key={node.id} value={`node:${node.id}`}>{node.technicalLabel}</option>)}</optgroup><optgroup label="Edges">{diagram.edges.map((edge) => <option key={edge.id} value={`edge:${edge.id}`}>{edge.label}</option>)}</optgroup></select></label>{selectedNode ? <><label>Technical label<input value={selectedNode.technicalLabel} onChange={(event) => onNodeChange({ technicalLabel: event.target.value })} /></label><label>Plain-English label<input value={selectedNode.plainEnglishLabel} onChange={(event) => onNodeChange({ plainEnglishLabel: event.target.value })} /></label><label>Explanation<textarea value={selectedNode.explanation} onChange={(event) => onNodeChange({ explanation: event.target.value })} /></label><VisibilityButton visible={selectedNode.visible} onClick={() => onNodeChange({ visible: !selectedNode.visible })} /></> : selectedEdge ? <><label>Edge label<input value={selectedEdge.label} onChange={(event) => onEdgeChange({ label: event.target.value })} /></label><label>Explanation<textarea value={selectedEdge.explanation ?? ""} onChange={(event) => onEdgeChange({ explanation: event.target.value })} /></label><VisibilityButton visible={selectedEdge.visible} onClick={() => onEdgeChange({ visible: !selectedEdge.visible })} /></> : <p className="muted">Select a node or connection on the canvas to edit it. Evidence stays read-only.</p>}</aside>;
}

function VisibilityButton({ visible, onClick }: { visible: boolean; onClick: () => void }): React.JSX.Element { return <button className="secondary-button" onClick={onClick}>{visible ? "Hide" : "Show"} selected element</button>; }
function EvidenceSection({ evidence }: { evidence: Array<{ id: string; filePath: string; lineStart?: number; reason: string; excerpt?: string }> }): React.JSX.Element { return <section className="evidence-section"><div><p className="eyebrow"><span className="eyebrow-line" /> Evidence</p><h3>Why this map exists</h3></div><div className="evidence-panel">{evidence.length ? evidence.map((item) => <article key={item.id}><strong>{item.filePath}{item.lineStart ? `:${item.lineStart}` : ""}</strong><p>{item.reason}</p>{item.excerpt ? <code>{item.excerpt}</code> : null}</article>) : <p className="muted">No source references were collected.</p>}</div></section>; }
function AvailabilityList({ availability }: { availability?: AnalysisJob["diagramAvailability"] }): React.JSX.Element | null { const unavailable = availability?.filter((item) => !item.available) ?? []; return unavailable.length ? <div className="availability-list" aria-label="Diagram availability reasons">{unavailable.map((item) => <p key={item.type}><strong>{DIAGRAM_TYPE_LABELS[item.type]}</strong><span>{item.reason ?? "Not enough evidence to generate this diagram."}</span></p>)}</div> : null; }
function StateCard({ title, message, action, details }: { title: string; message: string; action?: React.ReactNode; details?: React.ReactNode }): React.JSX.Element { return <section className="state-card page-width" role="status" aria-live="polite"><span className="state-symbol" aria-hidden="true">!</span><h1>{title}</h1><p>{message}</p>{details}{action}</section>; }
function ProgressState({ progress, stage }: { progress: number; stage: string }): React.JSX.Element { const labels: Record<string, string> = { validating: "Checking the repository URL", "fetching-metadata": "Reading repository metadata", "fetching-files": "Mapping repository files", "filtering-files": "Filtering for useful signal", analyzing: "Finding architecture and entry points", "generating-diagrams": "Drawing the story maps", completed: "Story ready" }; const safeProgress = Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : 0; return <section className="state-card page-width progress-state" role="status" aria-live="polite"><div className="progress-orb"><span>{Math.round(safeProgress)}%</span></div><p className="eyebrow"><span className="eyebrow-line" /> Building your story</p><h1>{labels[stage] ?? "Reading your repository"}<span className="animated-dots">…</span></h1><p>We’re tracing the important paths so the result stays useful, not noisy.</p><div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(safeProgress)}><span style={{ width: `${Math.max(6, safeProgress)}%` }} /></div><small>{Math.round(safeProgress)}% complete · This usually takes under a minute</small></section>; }
