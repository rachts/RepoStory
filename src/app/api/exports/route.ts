import { z } from "zod";
import { NextResponse } from "next/server";
import { analysisStore } from "@/composition/container";
import { toMarkdown, toMermaid } from "@/analysis/exports";
import { stableId } from "@/shared/ids";

const requestSchema = z.object({
  diagramId: z.string().min(1),
  format: z.enum(["mermaid", "markdown"]),
  includeExplanation: z.boolean().default(true),
  includeEvidence: z.boolean().default(true),
  includeAttribution: z.boolean().default(false),
}).strict();

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const input = requestSchema.parse(await request.json());
    const diagram = analysisStore.getDiagram(input.diagramId);
    if (!diagram) return NextResponse.json({ error: { code: "DIAGRAM_NOT_FOUND", message: "Diagram not found.", retryable: false } }, { status: 404 });
    const content = input.format === "mermaid"
      ? toMermaid(diagram)
      : toMarkdown(diagram, input);
    const filename = `${diagram.type}.${input.format === "mermaid" ? "mmd" : "md"}`;
    return NextResponse.json({ id: stableId("export", diagram.id, input.format), diagramId: diagram.id, format: input.format, filename, content, mimeType: input.format === "mermaid" ? "text/plain" : "text/markdown" });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "The export request is invalid.", retryable: false } }, { status: 400 });
    return NextResponse.json({ error: { code: "EXPORT_FAILED", message: "The export could not be generated.", retryable: true } }, { status: 500 });
  }
}
