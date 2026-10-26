import { describe, expect, it, vi } from "vitest";
import { buildExplanationInput, collectExplanationEvidenceIds } from "@/application/ai/build-explanation-input";
import type { AnalysisJob } from "@/domain/analysis";
import { groqProjectExplanationJsonSchema, projectExplanationJsonSchema, projectExplanationSchema, unknownExplanationEvidenceIds, type ProjectExplanation } from "@/domain/ai-explanation";
import type { Diagram } from "@/domain/diagram";
import type { AnalysisFinding } from "@/domain/finding";
import { generateProjectExplanation } from "@/infrastructure/ai/groq-client";

const groqMock = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("groq-sdk", () => ({
  default: class Groq {
    public readonly chat = { completions: { create: groqMock.create } };
    public constructor(options: unknown) { void options; }
  },
}));

function explanation(): ProjectExplanation {
  return {
    projectSummary: { title: "A small browser application", oneSentence: "A small application with a browser-facing interface.", plainEnglish: "People use a web page to interact with the application.", evidenceIds: ["evidence-ui"], confidence: "high" },
    architectureAtAGlance: { plainEnglish: "The browser-facing code connects to application handlers.", layers: [{ name: "application", simpleName: "Application", purpose: "Coordinates application work.", components: ["Web interface"], evidenceIds: ["evidence-ui"], confidence: "high" }], evidenceIds: ["evidence-ui"] },
    mainComponents: [{ name: "Web interface", simpleName: "Web interface", whatItDoes: "Displays the application to a person.", whyItMatters: "It is the part a person can use.", location: "src/app/page.tsx", evidenceIds: ["evidence-ui"], confidence: "high" }],
    howTheSystemWorks: [{ step: 1, title: "Open the interface", plainEnglish: "A person opens the web interface.", technicalDetail: "The supplied UI evidence identifies the browser-facing entry point.", evidenceIds: ["evidence-ui"], confidence: "high" }],
    userJourney: [{ step: 1, title: "Open the application", plainEnglish: "A person opens the web interface.", relatedRoutes: [], relatedComponents: ["Web interface"], evidenceIds: ["evidence-ui"] }],
    technologyGuide: [{ technology: "React", simpleName: "React", whatItIs: "A tool for building browser interfaces.", roleInThisProject: "It builds the browser interface.", evidenceIds: ["evidence-ui"], confidence: "high" }],
    apiGuide: [{ route: "/api/items", method: "GET", simplePurpose: "Returns the items shown by the application.", requestFlow: "The route is the supplied request entry point.", evidenceIds: ["evidence-api"], confidence: "medium" }],
    dataAndIntegrations: [],
    securityAndAuthentication: { plainEnglish: "No authentication control was supplied in this fixture.", confirmedControls: [], unknowns: ["Authentication was not confirmed."], evidenceIds: [], confidence: "needs-verification" },
    glossary: [{ technicalTerm: "API route", simpleMeaning: "A named request endpoint.", projectSpecificMeaning: "Here it refers to the supplied GET /api/items route." }],
    knownLimitations: ["This explanation is based on static evidence."],
    confidenceNote: "The main claims have direct evidence references.",
  };
}

function evidence(id: string, filePath = "src/app/page.tsx") {
  return { id, filePath, lineStart: 1, reason: "Shows the application boundary.", excerpt: "password=super-secret" };
}

function diagram(): Diagram {
  return {
    id: "diagram-test",
    analysisId: "analysis-test",
    type: "system-overview",
    title: "System overview",
    description: "A bounded overview.",
    direction: "LR",
    nodes: [{ id: "node-ui", technicalLabel: "React", plainEnglishLabel: "Web interface", explanation: "The browser UI.", kind: "frontend", visible: true, confidence: "high", evidence: [evidence("evidence-ui")] }],
    edges: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function analysis(): AnalysisJob {
  const finding: AnalysisFinding = {
    id: "finding-ui",
    kind: "technology",
    technicalLabel: "React",
    plainEnglishLabel: "Web interface",
    explanation: "The repository contains a browser-facing interface.",
    confidence: "high",
    evidence: [evidence("evidence-ui")],
  };
  return {
    id: "analysis-test",
    repository: { id: "repo-test", owner: "fixture", name: "explanation-fixture", url: "https://github.com/fixture/explanation-fixture", defaultBranch: "main", selectedBranch: "main", sizeBytes: 10, fileCount: 1 },
    status: "completed",
    stage: "completed",
    progressPercent: 100,
    filesDiscovered: 1,
    filesAnalyzed: 1,
    technologies: [finding],
    findings: [finding],
    diagramIds: ["diagram-test"],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("AI explanation contracts", () => {
  it("builds a bounded, redacted payload without executing repository content", () => {
    const largeAnalysis = analysis();
    largeAnalysis.findings = Array.from({ length: 80 }, (_, index) => ({
      id: `finding-${index}`,
      kind: "technology" as const,
      technicalLabel: `Technology ${index}`,
      plainEnglishLabel: `Technology ${index} in plain English`,
      explanation: "A long repository-derived explanation that must remain bounded. ".repeat(12),
      confidence: "medium" as const,
      evidence: [evidence(index === 0 ? "evidence-ui" : `evidence-${index}`)],
    }));
    largeAnalysis.technologies = largeAnalysis.findings;
    const result = buildExplanationInput(largeAnalysis, [diagram()], 4_000);

    expect(result.truncated).toBe(true);
    expect(result.serialized.length).toBeLessThanOrEqual(4_000);
    expect(result.serialized).toContain("evidence-ui");
    expect(result.serialized).not.toContain("super-secret");
    expect(result.payload.technologies[0]?.evidenceIds).toContain("evidence-ui");
  });

  it("collects only evidence IDs supplied by the deterministic input", () => {
    const payload = buildExplanationInput(analysis(), [diagram()]).payload;
    const ids = collectExplanationEvidenceIds(payload);

    expect(ids).toEqual(new Set(["evidence-ui"]));
  });

  it("rejects extra output fields and unknown evidence references", () => {
    const valid = explanation();
    expect(projectExplanationSchema.safeParse({ ...valid, unexpected: true }).success).toBe(false);
    expect(unknownExplanationEvidenceIds(valid, new Set(["evidence-ui", "evidence-api"]))).toEqual([]);
    expect(unknownExplanationEvidenceIds({ ...valid, apiGuide: [{ ...valid.apiGuide[0]!, evidenceIds: ["invented-id"] }] }, new Set(["evidence-ui", "evidence-api"]))).toEqual(["invented-id"]);
    expect(projectExplanationJsonSchema.additionalProperties).toBe(false);
    expect(JSON.stringify(groqProjectExplanationJsonSchema)).not.toContain("minLength");
    expect(JSON.stringify(groqProjectExplanationJsonSchema)).not.toContain("maxLength");
  });
});

describe("Groq explanation client", () => {
  it("requests strict structured output and validates the response", async () => {
    groqMock.create.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(explanation()) } }] });

    const result = await generateProjectExplanation("{\"repository\":{}}", { apiKey: "test-key", model: "openai/gpt-oss-120b", timeoutMs: 1_000, enabled: true });

    expect(result).toEqual(explanation());
    expect(groqMock.create).toHaveBeenCalledWith(expect.objectContaining({
      model: "openai/gpt-oss-120b",
      temperature: 0.1,
      reasoning_effort: "low",
      include_reasoning: false,
      response_format: expect.objectContaining({ type: "json_schema" }),
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const request = groqMock.create.mock.calls.at(-1)?.[0] as { messages: Array<{ content?: string }> };
    expect(request.messages[0]?.content).toContain("{\"repository\":{}}");
  });

  it("fails closed when disabled or unconfigured", async () => {
    await expect(generateProjectExplanation("{}", { apiKey: "test-key", model: "test", timeoutMs: 100, enabled: false })).rejects.toMatchObject({ code: "AI_DISABLED" });
    await expect(generateProjectExplanation("{}", { model: "test", timeoutMs: 100, enabled: true })).rejects.toMatchObject({ code: "AI_NOT_CONFIGURED" });
  });

  it("falls back to JSON mode for models without the strict-output capability", async () => {
    groqMock.create.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(explanation()) } }] });

    await generateProjectExplanation("{}", { apiKey: "test-key", model: "custom/model", timeoutMs: 1_000, enabled: true });

    expect(groqMock.create).toHaveBeenCalledWith(expect.objectContaining({ response_format: { type: "json_object" } }), expect.anything());
  });

  it("falls back to JSON mode when Groq rejects the strict schema request", async () => {
    groqMock.create.mockClear();
    groqMock.create
      .mockRejectedValueOnce(Object.assign(new Error("schema rejected"), { status: 400 }))
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(explanation()) } }] });

    const result = await generateProjectExplanation("{}", { apiKey: "test-key", model: "openai/gpt-oss-120b", timeoutMs: 1_000, enabled: true });

    expect(result).toEqual(explanation());
    expect(groqMock.create).toHaveBeenCalledTimes(2);
    expect(groqMock.create.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ response_format: { type: "json_object" } }));
  });

  it("normalizes invalid, rate-limited, and malformed upstream responses", async () => {
    groqMock.create.mockResolvedValueOnce({ choices: [{ message: { content: "{}" } }] });
    await expect(generateProjectExplanation("{}", { apiKey: "test-key", model: "test", timeoutMs: 100, enabled: true })).rejects.toMatchObject({ code: "AI_INVALID_RESPONSE" });

    groqMock.create.mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }));
    await expect(generateProjectExplanation("{}", { apiKey: "test-key", model: "test", timeoutMs: 100, enabled: true })).rejects.toMatchObject({ code: "AI_RATE_LIMITED" });

    groqMock.create.mockRejectedValueOnce(Object.assign(new Error("bad request"), { status: 400 }));
    await expect(generateProjectExplanation("{}", { apiKey: "test-key", model: "test", timeoutMs: 100, enabled: true })).rejects.toMatchObject({ code: "AI_REQUEST_REJECTED", retryable: false });

    groqMock.create.mockRejectedValueOnce(Object.assign(new Error("unauthorized"), { status: 401 }));
    await expect(generateProjectExplanation("{}", { apiKey: "test-key", model: "test", timeoutMs: 100, enabled: true })).rejects.toMatchObject({ code: "AI_AUTH_FAILED", retryable: false });

    groqMock.create.mockResolvedValueOnce({ choices: [{ message: { content: "not-json" } }] });
    await expect(generateProjectExplanation("{}", { apiKey: "test-key", model: "test", timeoutMs: 100, enabled: true })).rejects.toMatchObject({ code: "AI_INVALID_RESPONSE" });
  });
});
