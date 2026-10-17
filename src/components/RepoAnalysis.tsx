"use client";

import "@xyflow/react/dist/style.css";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, ReactFlow, type Edge, type Node } from "@xyflow/react";
import type { AnalysisJob } from "@/domain/analysis";
import type { Diagram, DiagramDirection, DiagramEdge, DiagramNode, DiagramType } from "@/domain/diagram";

interface AnalysisResponse extends AnalysisJob { diagrams: Diagram[] }
interface ExportResponse { content: string; filename: string; mimeType: string }
interface RepoAnalysisProps { analysisId: string }

const SUPPORTED_DIAGRAM_TYPES: readonly DiagramType[] = ["repository-structure", "system-overview", "api-request-flow", "authentication-flow"];
const DIAGRAM_TYPE_LABELS: Record<DiagramType, string> = { "repository-structure": "Repository structure", "system-overview": "System overview", "api-request-flow": "API request flow", "authentication-flow": "Authentication flow" };
const DIAGRAM_TYPE_ORDER: Record<DiagramType, number> = { "repository-structure": 0, "system-overview": 1, "api-request-flow": 2, "authentication-flow": 3 };

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
  const [mode, setMode] = useState<"technical" | "plain">("technical");
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

  const load = useCallback(async (): Promise<void> => {
    setError("");
    try {
      const response = await fetch(`/api/analysis/${encodeURIComponent(analysisId)}`, { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as AnalysisResponse | { error?: { message?: string } } | null;
      if (!response.ok) throw new Error((payload as { error?: { message?: string } } | null)?.error?.message ?? "This analysis could not be loaded.");
      const result = payload as AnalysisResponse;
      const supportedDiagrams = getSupportedDiagrams(result.diagrams ?? []);
      setAnalysis(result);
      setSelectedId((current) => current && supportedDiagrams.some((item) => item.id === current) ? current : supportedDiagrams[0]?.id ?? null);
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : "This analysis could not be loaded."); }
  }, [analysisId]);

  useEffect(() => { // Synchronize the workspace with the server analysis.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const availableDiagrams = useMemo(() => getSupportedDiagrams(analysis?.diagrams ?? []), [analysis?.diagrams]);
  const diagram = draft ?? availableDiagrams.find((item) => item.id === selectedId) ?? availableDiagrams[0] ?? null;
  const selectedNode = diagram && selectedElement?.type === "node" ? diagram.nodes.find((node) => node.id === selectedElement.id) ?? null : null;
  const selectedEdge = diagram && selectedElement?.type === "edge" ? diagram.edges.find((edge) => edge.id === selectedElement.id) ?? null : null;
  const visibleNodes = useMemo(() => diagram?.nodes.filter((item) => item.visible) ?? [], [diagram]);
  const nodes = useMemo<Node[]>(() => visibleNodes.map((item) => ({ id: item.id, position: item.position ?? { x: 80, y: 80 }, data: { label: <div className="flow-node"><strong>{mode === "technical" ? item.technicalLabel : item.plainEnglishLabel}</strong><small>{item.kind}</small></div> }, type: "default" })), [visibleNodes, mode]);
  const edges = useMemo<Edge[]>(() => diagram ? diagram.edges.filter((item) => item.visible && visibleNodes.some((node) => node.id === item.source) && visibleNodes.some((node) => node.id === item.target)).map((item) => ({ id: item.id, source: item.source, target: item.target, label: item.label })) : [], [diagram, visibleNodes]);
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
    const response = await fetch(`/api/diagrams/${encodeURIComponent(diagram.id)}/reset`, { method: "POST" });
    const payload = await response.json() as { diagram?: Diagram };
    if (payload.diagram) { draftRevisionRef.current += 1; setAnalysis((current) => current ? { ...current, diagrams: current.diagrams.map((item) => item.id === payload.diagram?.id ? payload.diagram : item).filter((item): item is Diagram => Boolean(item)) } : current); setDraft(null); setHistory([]); setFuture([]); setSaved(true); setFeedback("Reset"); }
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
      const response = await fetch("/api/exports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ diagramId: requestedDiagram.id, format, includeExplanation: true, includeEvidence: true, includeAttribution: false }) });
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

  return <main className="analysis-page">
    <header className="analysis-header page-width"><Link className="brand" href="/"><span className="brand-mark">R</span> RepoStory</Link><div className="analysis-repo"><span className="repo-kicker">ANALYSIS</span><strong>{analysis ? `${analysis.repository.owner}/${analysis.repository.name}` : "Loading repository…"}</strong></div><Link className="back-link" href="/">← New repository</Link></header>
    {error ? <StateCard title="We couldn’t read this story." message={error} action={<button className="secondary-button" onClick={() => void load()}>Try again</button>} /> : isWorking ? <ProgressState progress={analysis?.progressPercent ?? 8} stage={analysis?.stage ?? "validating"} /> : analysis?.status === "failed" ? <StateCard title="The analysis stopped early." message={analysis.error?.message ?? "The repository could not be analyzed."} /> : !diagram ? <StateCard title="No supported diagram is available." message="No supported diagrams are available for this repository." details={<AvailabilityList availability={analysis?.diagramAvailability} />} /> : <>
        <div className="diagram-toolbar page-width"><strong>Diagram workspace</strong><span className={saved ? "save-state" : "save-state unsaved"}>{feedback || (saved ? "Saved" : "Unsaved changes")}</span><button aria-label="Undo" className="toolbar-button" onClick={undo} disabled={!history.length || exportState !== "idle"}>Undo</button><button aria-label="Redo" className="toolbar-button" onClick={redo} disabled={!future.length || exportState !== "idle"}>Redo</button><button className="toolbar-button" onClick={() => void reset()} disabled={exportState !== "idle"}>Reset</button><button className="primary-button" onClick={() => void save()} disabled={saved || exportState !== "idle"}>Save changes</button></div>
        <section className="results-layout page-width"><aside className="diagram-sidebar"><p className="eyebrow"><span className="eyebrow-line" /> Story maps</p><h1>{analysis.repository.name}</h1><p className="sidebar-description">{analysis.repository.description ?? "A guided view of the codebase."}</p><div className="diagram-list" aria-label="Available story maps">{availableDiagrams.map((item, index) => <button key={item.id} aria-label={`${DIAGRAM_TYPE_LABELS[item.type]}: ${item.title}`} className={`diagram-item ${item.id === diagram.id ? "active" : ""}`} data-diagram-type={item.type} onClick={() => selectDiagram(item)}><span className="diagram-index">{String(index + 1).padStart(2, "0")}</span><span><strong>{item.title}</strong><small>{DIAGRAM_TYPE_LABELS[item.type]} · {item.nodes.length} nodes · {item.edges.length} connections</small></span><span>→</span></button>)}{analysis.diagramAvailability?.filter((item) => !item.available).map((item) => <div key={item.type} className="unavailable-diagram"><strong>{DIAGRAM_TYPE_LABELS[item.type]}</strong><small>{item.reason ?? "Not enough evidence to generate this diagram."}</small></div>)}</div><div className="sidebar-note"><span>✦</span><p>Every label is grounded in repository evidence.</p></div></aside>
          <div className="results-main"><div className="results-title"><div><p className="eyebrow"><span className="eyebrow-line" /> Interactive preview</p><h2>{diagram.title}</h2><p>{diagram.description}</p></div><div className="toggle" role="group" aria-label="Label language"><button className={mode === "technical" ? "selected" : ""} onClick={() => setMode("technical")}>Technical</button><button className={mode === "plain" ? "selected" : ""} onClick={() => setMode("plain")}>Plain English</button></div></div><div className="flow-wrap" aria-label={`${diagram.title} diagram`}><ReactFlow nodes={nodes} edges={edges} fitView onNodeClick={(_event, node) => setSelectedElement({ type: "node", id: node.id })} onEdgeClick={(_event, edge) => setSelectedElement({ type: "edge", id: edge.id })}><Background color="#d9d8cf" gap={24} /><Controls /></ReactFlow></div><div className="results-toolbar"><label className="direction-control">Direction<select value={diagram.direction} onChange={(event) => updateDiagram({ direction: event.target.value as DiagramDirection })} disabled={exportState !== "idle"}><option value="TB">Top to bottom</option><option value="LR">Left to right</option><option value="RL">Right to left</option><option value="BT">Bottom to top</option></select></label><button className="secondary-button" onClick={() => void copyExport("mermaid")} disabled={exportState !== "idle"}>Copy Mermaid</button><button className="primary-button" onClick={() => void copyExport("markdown")} disabled={exportState !== "idle"}>Copy README Markdown</button>{exportState !== "idle" ? <span className="export-status" role="status" aria-live="polite">{exportState === "saving" ? "Saving changes before export…" : "Generating export…"}</span> : null}{exportError ? <p className="export-error" role="alert">{exportError}</p> : null}</div><EvidenceSection evidence={evidence} /></div>
        <EditorPanel diagram={diagram} selectedNode={selectedNode} selectedEdge={selectedEdge} onDiagramChange={updateDiagram} onNodeChange={updateNode} onEdgeChange={updateEdge} onSelect={setSelectedElement} />
      </section></>}
  </main>;
}

function EditorPanel({ diagram, selectedNode, selectedEdge, onDiagramChange, onNodeChange, onEdgeChange, onSelect }: { diagram: Diagram; selectedNode: DiagramNode | null; selectedEdge: DiagramEdge | null; onDiagramChange: (updates: Partial<Diagram>) => void; onNodeChange: (updates: Partial<DiagramNode>) => void; onEdgeChange: (updates: Partial<DiagramEdge>) => void; onSelect: (selection: { type: "node" | "edge"; id: string } | null) => void }): React.JSX.Element {
  return <aside className="editor-panel"><p className="eyebrow"><span className="eyebrow-line" /> Properties</p><label>Title<input value={diagram.title} onChange={(event) => onDiagramChange({ title: event.target.value })} /></label><label>Description<textarea value={diagram.description} onChange={(event) => onDiagramChange({ description: event.target.value })} /></label><label>Custom note<textarea value={diagram.customNote ?? ""} onChange={(event) => onDiagramChange({ customNote: event.target.value })} placeholder="Optional note for readers" /></label><label>Element<select value={selectedNode ? `node:${selectedNode.id}` : selectedEdge ? `edge:${selectedEdge.id}` : ""} onChange={(event) => { const [type, id] = event.target.value.split(":"); onSelect(type && id ? { type: type as "node" | "edge", id } : null); }}><option value="">Select an element</option><optgroup label="Nodes">{diagram.nodes.map((node) => <option key={node.id} value={`node:${node.id}`}>{node.technicalLabel}</option>)}</optgroup><optgroup label="Edges">{diagram.edges.map((edge) => <option key={edge.id} value={`edge:${edge.id}`}>{edge.label}</option>)}</optgroup></select></label>{selectedNode ? <><label>Technical label<input value={selectedNode.technicalLabel} onChange={(event) => onNodeChange({ technicalLabel: event.target.value })} /></label><label>Plain-English label<input value={selectedNode.plainEnglishLabel} onChange={(event) => onNodeChange({ plainEnglishLabel: event.target.value })} /></label><label>Explanation<textarea value={selectedNode.explanation} onChange={(event) => onNodeChange({ explanation: event.target.value })} /></label><VisibilityButton visible={selectedNode.visible} onClick={() => onNodeChange({ visible: !selectedNode.visible })} /></> : selectedEdge ? <><label>Edge label<input value={selectedEdge.label} onChange={(event) => onEdgeChange({ label: event.target.value })} /></label><label>Explanation<textarea value={selectedEdge.explanation ?? ""} onChange={(event) => onEdgeChange({ explanation: event.target.value })} /></label><VisibilityButton visible={selectedEdge.visible} onClick={() => onEdgeChange({ visible: !selectedEdge.visible })} /></> : <p className="muted">Select a node or connection on the canvas to edit it. Evidence stays read-only.</p>}</aside>;
}

function VisibilityButton({ visible, onClick }: { visible: boolean; onClick: () => void }): React.JSX.Element { return <button className="secondary-button" onClick={onClick}>{visible ? "Hide" : "Show"} selected element</button>; }
function EvidenceSection({ evidence }: { evidence: Array<{ id: string; filePath: string; lineStart?: number; reason: string; excerpt?: string }> }): React.JSX.Element { return <section className="evidence-section"><div><p className="eyebrow"><span className="eyebrow-line" /> Evidence</p><h3>Why this map exists</h3></div><div className="evidence-panel">{evidence.length ? evidence.map((item) => <article key={item.id}><strong>{item.filePath}{item.lineStart ? `:${item.lineStart}` : ""}</strong><p>{item.reason}</p>{item.excerpt ? <code>{item.excerpt}</code> : null}</article>) : <p className="muted">No source references were collected.</p>}</div></section>; }
function AvailabilityList({ availability }: { availability?: AnalysisJob["diagramAvailability"] }): React.JSX.Element | null { const unavailable = availability?.filter((item) => !item.available) ?? []; return unavailable.length ? <div className="availability-list" aria-label="Diagram availability reasons">{unavailable.map((item) => <p key={item.type}><strong>{DIAGRAM_TYPE_LABELS[item.type]}</strong><span>{item.reason ?? "Not enough evidence to generate this diagram."}</span></p>)}</div> : null; }
function StateCard({ title, message, action, details }: { title: string; message: string; action?: React.ReactNode; details?: React.ReactNode }): React.JSX.Element { return <section className="state-card page-width" role="status"><span className="state-symbol">!</span><h1>{title}</h1><p>{message}</p>{details}{action}</section>; }
function ProgressState({ progress, stage }: { progress: number; stage: string }): React.JSX.Element { const labels: Record<string, string> = { validating: "Checking the repository URL", "fetching-metadata": "Reading repository metadata", "fetching-files": "Mapping repository files", "filtering-files": "Filtering for useful signal", analyzing: "Finding architecture and entry points", "generating-diagrams": "Drawing the story maps", completed: "Story ready" }; return <section className="state-card page-width progress-state"><div className="progress-orb"><span>{Math.round(progress)}%</span></div><p className="eyebrow"><span className="eyebrow-line" /> Building your story</p><h1>{labels[stage] ?? "Reading your repository"}<span className="animated-dots">…</span></h1><p>We’re tracing the important paths so the result stays useful, not noisy.</p><div className="progress-track"><span style={{ width: `${Math.max(6, progress)}%` }} /></div><small>{Math.round(progress)}% complete · This usually takes under a minute</small></section>; }
