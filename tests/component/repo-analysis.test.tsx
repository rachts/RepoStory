import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisJob } from "@/domain/analysis";
import type { Diagram, DiagramType } from "@/domain/diagram";
import { RepoAnalysis } from "@/components/RepoAnalysis";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode; href: string; className?: string }) => <a {...props}>{children}</a>,
}));

vi.mock("@xyflow/react", () => ({
  Background: () => null,
  Controls: () => null,
  ReactFlow: ({ children }: { children: ReactNode }) => <div data-testid="react-flow">{children}</div>,
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

function analysis(diagrams: Diagram[], diagramAvailability?: AnalysisJob["diagramAvailability"]): AnalysisJob & { diagrams: Diagram[] } {
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
    createdAt: "2026-01-01T00:00:00.000Z",
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
