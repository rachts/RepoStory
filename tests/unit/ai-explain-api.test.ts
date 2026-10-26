import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/explain/route";
import { analysisStore } from "@/composition/container";
import type { AnalysisJob } from "@/domain/analysis";
import type { ProjectExplanation } from "@/domain/ai-explanation";
import { AppError } from "@/domain/errors";

const generateMock = vi.hoisted(() => vi.fn());
vi.mock("@/infrastructure/ai/groq-client", () => ({ generateProjectExplanation: generateMock }));

const analysisId = "analysis-explain-api";

function explanation(evidenceIds: string[] = []): ProjectExplanation {
  return {
    projectSummary: { title: "A statically analyzed application", oneSentence: "A statically analyzed application.", plainEnglish: "It presents a web interface.", evidenceIds, confidence: "medium" },
    architectureAtAGlance: { plainEnglish: "The evidence shows a browser-facing application.", layers: [], evidenceIds },
    mainComponents: [],
    howTheSystemWorks: [],
    userJourney: [],
    technologyGuide: [],
    apiGuide: [],
    dataAndIntegrations: [],
    securityAndAuthentication: { plainEnglish: "Authentication was not confirmed.", confirmedControls: [], unknowns: ["Authentication was not confirmed."], evidenceIds: [], confidence: "needs-verification" },
    glossary: [],
    knownLimitations: ["Static analysis only."],
    confidenceNote: "The explanation is bounded by the supplied evidence.",
  };
}

function job(status: AnalysisJob["status"] = "completed"): AnalysisJob {
  return {
    id: analysisId,
    repository: { id: "repo-explain-api", owner: "fixture", name: "explain-api", url: "https://github.com/fixture/explain-api", defaultBranch: "main", selectedBranch: "main", sizeBytes: 10, fileCount: 1 },
    status,
    stage: status === "completed" ? "completed" : "analyzing",
    progressPercent: status === "completed" ? 100 : 40,
    filesDiscovered: 1,
    filesAnalyzed: status === "completed" ? 1 : 0,
    technologies: [],
    findings: [],
    diagramIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function request(body: unknown): Request {
  return new Request("http://localhost/api/explain", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

describe("POST /api/explain", () => {
  beforeEach(() => {
    generateMock.mockReset();
    analysisStore.delete(analysisId);
  });

  afterEach(() => {
    analysisStore.delete(analysisId);
  });

  it("rejects malformed, missing, and incomplete analysis requests", async () => {
    await expect((await POST(request({}))).status).toBe(400);
    await expect((await POST(request({ analysisId }))).status).toBe(404);

    analysisStore.save(job("running"));
    const response = await POST(request({ analysisId }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "AI_NOT_READY" } });
  });

  it("builds sanitized evidence input and returns a validated explanation", async () => {
    analysisStore.save(job());
    generateMock.mockResolvedValueOnce(explanation());

    const response = await POST(request({ analysisId }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ analysisId, explanation: { projectSummary: { oneSentence: "A statically analyzed application." } } });
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(generateMock.mock.calls[0]?.[0]).toContain("explain-api");
  });

  it("rejects model output that invents evidence IDs", async () => {
    analysisStore.save(job());
    generateMock.mockResolvedValueOnce(explanation(["invented-evidence"]));

    const response = await POST(request({ analysisId }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "AI_INVALID_RESPONSE" } });
  });

  it("surfaces provider configuration failures instead of mislabeling them as transient outages", async () => {
    analysisStore.save(job());
    generateMock.mockRejectedValueOnce(new AppError({ code: "AI_AUTH_FAILED", message: "The AI explanation credentials were rejected.", retryable: false }));
    const response = await POST(request({ analysisId }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "AI_AUTH_FAILED", retryable: false } });
  });
});
