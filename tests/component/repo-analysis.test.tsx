import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisJob } from "@/domain/analysis";
import type { ArchitectureStory } from "@/domain/architecture-story";
import type { Diagram, DiagramType } from "@/domain/diagram";
import { RepoAnalysis } from "@/components/RepoAnalysis";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode; href: string; className?: string }) => <a {...props}>{children}</a>,
}));

vi.mock("@xyflow/react", () => ({
  Background: () => null,
  Controls: () => null,
  ReactFlow: ({ children, nodes = [] }: { children: ReactNode; nodes?: Array<{ id: string; position: { x: number; y: number } }> }) => <div data-testid="react-flow" data-node-count={nodes.length} data-node-positions={JSON.stringify(nodes.map((node) => ({ id: node.id, ...node.position })))}>{children}</div>,
}));

const fetchMock = vi.fn();

function diagram(type: DiagramType, title: string): Diagram {
  return {
    id: `diagram-${type}`,
    analysisId: "analysis-ui",
    type,
    title,
    description: `${title} description`,
    direction: "LR",
    nodes: [{ id: `${type}-node`, technicalLabel: type, plainEnglishLabel: title, explanation: `${title} explanation`, kind: "service", visible: true, confidence: "high", evidence: [] }],
    edges: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function analysis(diagrams: Diagram[], diagramAvailability?: AnalysisJob["diagramAvailability"], architectureStory?: ArchitectureStory): AnalysisJob & { diagrams: Diagram[]; architectureStory?: ArchitectureStory } {
  return {
    id: "analysis-ui",
    repository: { id: "repo-ui", owner: "fixture", name: "ui-fixture", url: "https://github.com/fixture/ui-fixture", defaultBranch: "main", selectedBranch: "main", sizeBytes: 10, fileCount: 1 },
    status: "completed",
    stage: "completed",
    progressPercent: 100,
    filesDiscovered: 1,
    filesAnalyzed: 1,
    technologies: [],
    findings: [],
    diagramIds: diagrams.map((item) => item.id),
    diagrams,
    diagramAvailability,
    architectureStory,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function architectureStory(): ArchitectureStory {
  const evidence = [{ id: "story-evidence", filePath: "src/app/page.tsx", lineStart: 1, reason: "Shows the web interface." }];
  return {
    id: "story-ui",
    headline: "How ui-fixture works",
    summary: "This ui-fixture application appears to provide a web interface that sends requests to application handlers and returns results to the browser.",
    plainEnglishSummary: "This ui-fixture application appears to provide a web interface that sends requests to application handlers and returns results to the browser.",
    technicalSummary: "Static findings represented in this story: React frontend.",
    confidence: "medium",
    evidence,
    actors: [
      { id: "actor-person", kind: "person", label: "Browser user", technicalLabel: "Browser user", plainEnglishLabel: "Person in a browser", explanation: "A person opens the interface.", inferred: true, confidence: "medium", evidence, sourceNodeIds: ["system-person"], sourceDiagramTypes: ["system-overview"] },
      { id: "actor-frontend", kind: "frontend", label: "React frontend", technicalLabel: "React frontend", plainEnglishLabel: "Web interface", explanation: "The interface displays the application.", inferred: false, confidence: "high", evidence, sourceNodeIds: ["system-frontend"], sourceDiagramTypes: ["system-overview"] },
      { id: "actor-backend", kind: "backend", label: "Application server", technicalLabel: "Application server", plainEnglishLabel: "Application server", explanation: "The server handles requests.", inferred: false, confidence: "medium", evidence, sourceNodeIds: ["system-backend"], sourceDiagramTypes: ["system-overview"] },
    ],
    steps: [{ id: "step-route", kind: "api", order: 1, layerId: "layer-request", title: "GET API endpoint at /api/items", plainEnglishTitle: "GET API endpoint at /api/items", technicalLabel: "GET /api/items", plainEnglishLabel: "GET API endpoint at /api/items", explanation: "The application exposes a request handler.", confidence: "high", evidence, sourceNodeIds: ["api-route"], targetNodeIds: [], sourceDiagramTypes: ["api-request-flow"] }],
    layers: [{ id: "layer-request", kind: "request", order: 1, label: "request-handling", technicalLabel: "request-handling", plainEnglishLabel: "Request handling", purpose: "Detected request handling.", explanation: "Detected request handling.", nodeIds: ["api-route"], actorIds: [], stepIds: ["step-route"], relationshipIds: [], confidence: "high", evidence, sourceDiagramTypes: ["api-request-flow"] }],
    relationships: [],
    coverage: { status: "complete", partial: false, filesAnalyzed: 4, filesDiscovered: 4, analyzedFiles: 4, discoveredFiles: 4, evidenceBackedFindings: 3, evidenceBackedElements: 4, availableDiagramTypes: ["system-overview", "api-request-flow"], unavailableDiagramTypes: [], diagramAvailability: [{ type: "system-overview", available: true }, { type: "api-request-flow", available: true }, { type: "repository-structure", available: false, reason: "Not selected in this fixture." }, { type: "authentication-flow", available: false, reason: "No authentication evidence." }], repositoryStructureAvailable: false, systemOverviewAvailable: true, apiRequestFlowAvailable: true, authenticationFlowAvailable: false, caveats: [] },
    caveats: [],
  };
}

describe("RepoAnalysis diagram navigation", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("lists each supported diagram type and switches the preview", async () => {
    const diagrams = [
      diagram("authentication-flow", "Authentication flow"),
      diagram("api-request-flow", "API request flow"),
      diagram("system-overview", "System overview"),
      diagram("repository-structure", "Repository structure"),
    ];
    fetchMock.mockResolvedValue({ ok: true, json: async () => analysis(diagrams) });

    render(<RepoAnalysis analysisId="analysis-ui" />);

    const list = await waitFor(() => screen.getByLabelText("Available story maps"));
    expect(within(list).getAllByRole("button")).toHaveLength(4);
    expect(within(list).getByRole("button", { name: /Repository structure/ })).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: /System overview/ })).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: /API request flow/ })).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: /Authentication flow/ })).toBeInTheDocument();

    fireEvent.click(within(list).getByRole("button", { name: /Authentication flow/ }));
    expect(screen.getByRole("heading", { level: 2, name: "Authentication flow" })).toBeInTheDocument();
  });

  it("explains when the completed analysis has no supported diagram", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => analysis([], [{ type: "api-request-flow", available: false, reason: "No API route evidence." }, { type: "authentication-flow", available: false, reason: "No authentication evidence." }]) });

    render(<RepoAnalysis analysisId="analysis-ui" />);

    expect(await screen.findByText("No supported diagrams are available for this repository.")).toBeInTheDocument();
    expect(screen.getByText("No API route evidence.")).toBeInTheDocument();
    expect(screen.getByText("No authentication evidence.")).toBeInTheDocument();
  });

  it("shows an evidence reason when a supported diagram is unavailable", async () => {
    const unavailable = "No evidence-backed API routes were detected.";
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ...analysis([diagram("repository-structure", "Repository structure")]), diagramAvailability: [{ type: "api-request-flow", available: false, reason: unavailable }] }) });

    render(<RepoAnalysis analysisId="analysis-ui" />);

    expect(await screen.findByText("API request flow")).toBeInTheDocument();
    expect(screen.getByText(unavailable)).toBeInTheDocument();
  });

  it("keeps the plain-English story visible when no diagram was generated", async () => {
    const base = architectureStory();
    const emptyStory: ArchitectureStory = {
      ...base,
      headline: "How empty-fixture works",
      summary: "The repository does not provide enough evidence to describe how the application works.",
      plainEnglishSummary: "The repository does not provide enough evidence to describe how the application works.",
      actors: [],
      steps: [],
      layers: [],
      relationships: [],
      coverage: { ...base.coverage, status: "empty", partial: true, availableDiagramTypes: [], unavailableDiagramTypes: [{ type: "system-overview", available: false, reason: "Not enough technology evidence was found." }] },
      caveats: ["No evidence-backed actors, steps, layers, or relationships were found."],
    };
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ...analysis([], [{ type: "system-overview", available: false, reason: "Not enough technology evidence was found." }], emptyStory), architectureStory: emptyStory }) });

    render(<RepoAnalysis analysisId="analysis-ui" />);

    expect(await screen.findByRole("heading", { level: 1, name: "How empty-fixture works" })).toBeInTheDocument();
    expect(screen.getByText("No evidence-backed map is available.")).toBeInTheDocument();
    expect(screen.getByText("No clear API request flow was detected in the analyzed files.")).toBeInTheDocument();
  });

  it("puts the plain-English story before the map and prioritizes node meaning", async () => {
    const sourceEvidence = [{ id: "frontend-evidence", filePath: "src/app/page.tsx", lineStart: 1, reason: "Defines the web interface." }];
    const system = { ...diagram("system-overview", "System overview"), nodes: [
      { id: "system-person", technicalLabel: "Browser user", plainEnglishLabel: "Person in a browser", explanation: "A person opens the interface.", kind: "person" as const, visible: true, confidence: "medium" as const, evidence: sourceEvidence },
      { id: "system-frontend", technicalLabel: "React frontend", plainEnglishLabel: "Web interface", explanation: "The part a person uses in the browser.", kind: "frontend" as const, visible: true, confidence: "high" as const, evidence: sourceEvidence },
      { id: "system-backend", technicalLabel: "Application server", plainEnglishLabel: "Application server", explanation: "The part that handles requests.", kind: "backend" as const, visible: true, confidence: "medium" as const, evidence: sourceEvidence },
    ], edges: [{ id: "frontend-edge", source: "system-person", target: "system-frontend", label: "opens", visible: true, inferred: true, confidence: "medium" as const, evidence: sourceEvidence }] };
    const api = diagram("api-request-flow", "API request flow");
    fetchMock.mockResolvedValue({ ok: true, json: async () => analysis([system, api], undefined, architectureStory()) });

    render(<RepoAnalysis analysisId="analysis-ui" />);

    expect(await screen.findByRole("heading", { level: 1, name: "How ui-fixture works" })).toBeInTheDocument();
    expect(screen.getByText("A person starts an action.")).toBeInTheDocument();
    expect(screen.getByLabelText("How to read this diagram")).toBeInTheDocument();
    expect(screen.getByText("Choose a node or connection")).toBeInTheDocument();
    expect(screen.getAllByText("Nothing selected")).toHaveLength(2);
    expect(screen.getByText((_content, element) => element?.textContent === "4 files analyzed")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "System overview" })).toBeInTheDocument();
    const flow = screen.getByTestId("react-flow");
    expect(flow).toHaveAttribute("data-node-count", "3");
    expect(JSON.parse(flow.getAttribute("data-node-positions") ?? "[]")).toEqual([
      { id: "system-person", x: 0, y: 80 },
      { id: "system-frontend", x: 220, y: 80 },
      { id: "system-backend", x: 440, y: 80 },
    ]);

    fireEvent.change(screen.getByLabelText("Element"), { target: { value: "node:system-frontend" } });
    expect(screen.getByRole("heading", { level: 3, name: "Web interface" })).toBeInTheDocument();
    expect(screen.getByText("What it does")).toBeInTheDocument();
    expect(screen.getByText("Technical name")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Technical" }));
    expect(screen.getByRole("button", { name: "Technical" })).toHaveClass("selected");
  });

  it("saves the current draft before requesting an export", async () => {
    const initial = diagram("repository-structure", "Repository structure");
    const persisted = { ...initial, title: "Edited title", updatedAt: "2026-01-01T00:01:00.000Z" };
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => analysis([initial]) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ diagram: persisted }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ content: "# Edited title", filename: "repository-structure.md", mimeType: "text/markdown" }) });

    render(<RepoAnalysis analysisId="analysis-ui" />);

    await screen.findByRole("heading", { level: 2, name: "Repository structure" });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Edited title" } });
    fireEvent.click(screen.getByRole("button", { name: "Copy README Markdown" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("# Edited title"));
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/diagrams/diagram-repository-structure");
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string)).toMatchObject({ title: "Edited title" });
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/exports");
    expect(await screen.findByText("README Markdown copied")).toBeInTheDocument();
  });

  it("shows export progress while the draft is being persisted", async () => {
    const initial = diagram("repository-structure", "Repository structure");
    const persisted = { ...initial, title: "Edited title" };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    let resolvePatch: ((response: unknown) => void) | undefined;
    const patchResponse = new Promise((resolve) => { resolvePatch = resolve; });
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => analysis([initial]) })
      .mockReturnValueOnce(patchResponse)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ content: "# Edited title", filename: "repository-structure.md", mimeType: "text/markdown" }) });

    render(<RepoAnalysis analysisId="analysis-ui" />);

    await screen.findByRole("heading", { level: 2, name: "Repository structure" });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Edited title" } });
    fireEvent.click(screen.getByRole("button", { name: "Copy README Markdown" }));
    expect(await screen.findByText("Saving changes before export…")).toBeInTheDocument();

    resolvePatch?.({ ok: true, json: async () => ({ diagram: persisted }) });
    expect(await screen.findByText("README Markdown copied")).toBeInTheDocument();
  });

  it("does not copy an export when the draft changes during saving", async () => {
    const initial = diagram("repository-structure", "Repository structure");
    let resolvePatch: ((response: unknown) => void) | undefined;
    const patchResponse = new Promise((resolve) => { resolvePatch = resolve; });
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => analysis([initial]) })
      .mockReturnValueOnce(patchResponse);

    render(<RepoAnalysis analysisId="analysis-ui" />);

    await screen.findByRole("heading", { level: 2, name: "Repository structure" });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "First draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Copy README Markdown" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Newer draft" } });
    resolvePatch?.({ ok: true, json: async () => ({ diagram: { ...initial, title: "First draft" } }) });

    expect(await screen.findByRole("alert")).toHaveTextContent("changed while saving");
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/exports")).toBe(false);
  });

  it("shows the save error and does not request a stale export", async () => {
    const initial = diagram("repository-structure", "Repository structure");
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => analysis([initial]) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: { message: "Save failed" } }) });

    render(<RepoAnalysis analysisId="analysis-ui" />);

    await screen.findByRole("heading", { level: 2, name: "Repository structure" });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Edited title" } });
    fireEvent.click(screen.getByRole("button", { name: "Copy README Markdown" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/exports")).toBe(false);
  });
});
