import { z } from "zod";
import { NextResponse } from "next/server";
import { analysisRepository, analysisStore } from "@/composition/container";
import { ownerIdFromRequest } from "@/application/jobs/job-identity";
import { toMarkdown, toMermaid } from "@/analysis/exports";
import { stableId } from "@/shared/ids";
import { AppError } from "@/domain/errors";
import { errorResponse, jsonResponse, readJsonBody } from "@/shared/http";

const MAX_REQUEST_BYTES = 64 * 1024;

const requestSchema = z.object({
  diagramId: z.string().trim().min(1).max(256),
  format: z.enum(["mermaid", "markdown"]),
  includeExplanation: z.boolean().default(true),
  includeEvidence: z.boolean().default(true),
  includeAttribution: z.boolean().default(false),
  includeArchitectureSummary: z.boolean().default(false),
}).strict();

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const input = requestSchema.parse(await readJsonBody(request, MAX_REQUEST_BYTES));
    const { ownerId } = ownerIdFromRequest(request);
    const repositoryDiagram = await analysisRepository.getAnalysisDiagram(input.diagramId, ownerId);
    const diagram = repositoryDiagram ?? analysisStore.getDiagram(input.diagramId);
    if (!diagram) return jsonResponse({ error: { code: "DIAGRAM_NOT_FOUND", message: "Diagram not found.", retryable: false } }, { status: 404 });
    const analysis = input.includeArchitectureSummary
      ? (await analysisRepository.getAnalysisResult(diagram.analysisId, ownerId)) ?? analysisStore.get(diagram.analysisId)
      : undefined;
    const content = input.format === "mermaid"
      ? toMermaid(diagram)
      : toMarkdown(diagram, { ...input, ...(analysis?.architectureStory ? { architectureStory: analysis.architectureStory } : {}) });
    const filename = `${diagram.type}.${input.format === "mermaid" ? "mmd" : "md"}`;
    return jsonResponse({ id: stableId("export", diagram.id, input.format), diagramId: diagram.id, format: input.format, filename, content, mimeType: input.format === "mermaid" ? "text/plain" : "text/markdown" });
  } catch (error) {
    if (error instanceof z.ZodError) return jsonResponse({ error: { code: "INVALID_REQUEST", message: "The export request is invalid.", retryable: false } }, { status: 400 });
    if (error instanceof AppError) return errorResponse(error);
    return jsonResponse({ error: { code: "EXPORT_FAILED", message: "The export could not be generated.", retryable: true } }, { status: 500 });
  }
}
