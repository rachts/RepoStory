import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectExplanation } from "@/domain/ai-explanation";
import { ProjectExplanationPanel } from "@/components/ProjectExplanationPanel";

const mocked = vi.hoisted(() => {
  class ExplainProjectErrorMock extends Error {
    public readonly code: string;
    public readonly status: number;
    public readonly retryable: boolean;

    public constructor(options: { code: string; message: string; status: number; retryable: boolean }) {
      super(options.message);
      this.name = "ExplainProjectError";
      this.code = options.code;
      this.status = options.status;
      this.retryable = options.retryable;
    }
  }
  return { explainProject: vi.fn(), ExplainProjectErrorMock };
});

vi.mock("@/lib/api/explain-project", () => ({ explainProject: mocked.explainProject, ExplainProjectError: mocked.ExplainProjectErrorMock }));

const explanation: ProjectExplanation = {
  projectSummary: { title: "A small web application", oneSentence: "A small web application.", plainEnglish: "A person uses the browser interface.", evidenceIds: ["evidence-ui"], confidence: "high" },
  architectureAtAGlance: { plainEnglish: "The browser-facing code connects to application handlers.", layers: [], evidenceIds: ["evidence-ui"] },
  mainComponents: [{ name: "Web interface", simpleName: "Web interface", whatItDoes: "Displays the application.", whyItMatters: "It is the part a person uses.", location: "src/app/page.tsx", evidenceIds: ["evidence-ui"], confidence: "high" }],
  howTheSystemWorks: [{ step: 1, title: "Open the interface", plainEnglish: "A person opens the web interface.", technicalDetail: "The browser-facing entry point is supplied as evidence.", evidenceIds: ["evidence-ui"], confidence: "high" }],
  userJourney: [],
  technologyGuide: [],
  apiGuide: [],
  dataAndIntegrations: [],
  securityAndAuthentication: { plainEnglish: "Authentication was not confirmed.", confirmedControls: [], unknowns: ["Authentication was not confirmed."], evidenceIds: [], confidence: "needs-verification" },
  glossary: [{ technicalTerm: "API route", simpleMeaning: "A named request endpoint.", projectSpecificMeaning: "No API route was included in this fixture." }],
  knownLimitations: ["Static analysis only."],
  confidenceNote: "The main claim has direct evidence.",
};

const evidenceById = new Map([
  ["evidence-ui", { id: "evidence-ui", filePath: "src/app/page.tsx", lineStart: 1, reason: "Shows the web interface." }],
]);

describe("ProjectExplanationPanel", () => {
  beforeEach(() => mocked.explainProject.mockReset());
  afterEach(() => cleanup());

  it("loads a mocked explanation and renders evidence references", async () => {
    mocked.explainProject.mockResolvedValueOnce({ analysisId: "analysis-ui", explanation, model: "openai/gpt-oss-120b", generatedAt: "2026-01-01T00:00:00.000Z" });
    render(<ProjectExplanationPanel analysisId="analysis-ui" evidenceById={evidenceById} />);

    fireEvent.click(screen.getByRole("button", { name: "Explain this project" }));

    expect(await screen.findByText("Evidence-backed explanation")).toBeInTheDocument();
    expect(screen.getByText("A small web application.")).toBeInTheDocument();
    fireEvent.click(screen.getAllByText("Evidence references (1)")[0]!);
    expect(screen.getAllByText("src/app/page.tsx:1").length).toBeGreaterThan(0);
    expect(screen.getByText("Generated with openai/gpt-oss-120b")).toBeInTheDocument();
  });

  it("keeps the deterministic result usable when AI is unavailable", async () => {
    mocked.explainProject.mockRejectedValueOnce(new mocked.ExplainProjectErrorMock({ code: "AI_NOT_CONFIGURED", message: "AI explanations are not configured for this deployment.", status: 503, retryable: false }));
    render(<ProjectExplanationPanel analysisId="analysis-ui" evidenceById={evidenceById} />);

    fireEvent.click(screen.getByRole("button", { name: "Explain this project" }));

    expect(await screen.findByText("AI explanation is unavailable.")).toBeInTheDocument();
    expect(screen.getByText("AI explanations are not configured for this deployment.")).toBeInTheDocument();
    expect(screen.getByText("Deterministic analysis and diagrams remain available.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Explain this project" })).toBeDisabled();
  });

  it("offers retry after a transient failure", async () => {
    mocked.explainProject
      .mockRejectedValueOnce(new mocked.ExplainProjectErrorMock({ code: "AI_UPSTREAM_FAILED", message: "The AI explanation service is temporarily unavailable.", status: 502, retryable: true }))
      .mockResolvedValueOnce({ analysisId: "analysis-ui", explanation, model: "test-model", generatedAt: "2026-01-01T00:00:00.000Z" });
    render(<ProjectExplanationPanel analysisId="analysis-ui" evidenceById={evidenceById} />);

    fireEvent.click(screen.getByRole("button", { name: "Explain this project" }));
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("Evidence-backed explanation")).toBeInTheDocument());
    expect(mocked.explainProject.mock.calls[1]?.[2]).toBe(true);
  });
});
