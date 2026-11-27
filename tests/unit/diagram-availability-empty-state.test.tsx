import type { ReactNode } from "react";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RepoAnalysis } from "@/components/RepoAnalysis";
import type { AnalysisFinding } from "@/domain/finding";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: ReactNode; href: string; className?: string }) => <a {...props}>{children}</a>,
}));

vi.mock("@xyflow/react", () => ({
  Background: () => null,
  Controls: () => null,
  ReactFlow: ({ children, nodes = [] }: { children: ReactNode; nodes?: Array<{ id: string; position: { x: number; y: number } }> }) => (
    <div data-testid="react-flow" data-node-count={nodes.length}>
      {children}
    </div>
  ),
}));

describe("Fix 14: diagram availability reasons & structure fallback diagram", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const baseAnalysis = {
    id: "test-analysis-empty-diag",
    repository: {
      id: "repo-1",
      owner: "test-owner",
      name: "empty-diagram-repo",
      url: "https://github.com/test-owner/empty-diagram-repo",
      defaultBranch: "main",
      selectedBranch: "main",
      sizeBytes: 1000,
      fileCount: 5,
    },
    status: "completed",
    stage: "completed",
    progressPercent: 100,
    filesDiscovered: 5,
    filesAnalyzed: 5,
    technologies: [],
    findings: [
      {
        id: "finding-src",
        kind: "technology",
        category: "application",
        confidence: "medium",
        technicalLabel: "TypeScript",
        plainEnglishLabel: "TypeScript",
        explanation: "TypeScript language",
        evidence: [
          {
            id: "ev-1",
            filePath: "src/index.ts",
            reason: "Entry file",
          },
        ],
      } as AnalysisFinding,
    ],
    diagrams: [],
    diagramAvailability: [
      { type: "system-overview", available: false, reason: "Insufficient technology evidence." },
      { type: "api-request-flow", available: false, reason: "No API routes found in repository." },
      { type: "authentication-flow", available: false, reason: "No auth handlers identified." },
    ],
    diagramIds: [],
    createdAt: new Date().toISOString(),
  };

  it("displays diagram availability reasons in empty state and offers structure fallback button", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => baseAnalysis,
    });

    render(<RepoAnalysis analysisId="test-analysis-empty-diag" />);

    // Verify empty state is shown
    expect(await screen.findByText("No supported diagrams are available for this repository.")).toBeInTheDocument();

    // Verify diagram availability reasons are rendered
    expect(screen.getByText("Insufficient technology evidence.")).toBeInTheDocument();
    expect(screen.getByText("No API routes found in repository.")).toBeInTheDocument();
    expect(screen.getByText("No auth handlers identified.")).toBeInTheDocument();

    // Verify fallback button is present
    const fallbackButton = screen.getByTestId("load-structure-fallback");
    expect(fallbackButton).toBeInTheDocument();
    expect(fallbackButton).toHaveTextContent("Show repository structure fallback");

    // Click the structure fallback button
    fireEvent.click(fallbackButton);

    // Verify the UI transitions into the diagram workspace with the structure diagram
    expect((await screen.findAllByText("Repository structure (fallback)")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Diagram workspace")).toBeInTheDocument();
  });
});
