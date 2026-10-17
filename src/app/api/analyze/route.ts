import { z } from "zod";
import { NextResponse } from "next/server";
import { parseGitHubUrl } from "@/infrastructure/providers/github-url";
import { analysisStore, repositoryProvider, runAnalysis } from "@/composition/container";
import { errorResponse } from "@/shared/http";

const requestSchema = z.object({
  repositoryUrl: z.string().trim().min(1).max(500),
  branch: z.string().trim().min(1).max(255).optional(),
}).strict();

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body: unknown = await request.json();
    const input = requestSchema.parse(body);
    const parsed = parseGitHubUrl(input.repositoryUrl);
    if (!parsed.ok) return errorResponse(parsed.error);
    const reference = { ...parsed.value, ...(input.branch ? { branch: input.branch } : {}) };
    const result = await runAnalysis(reference, repositoryProvider, analysisStore);
    if (!result.ok) return errorResponse(result.error);
    return NextResponse.json({ analysisId: result.value.id, status: result.value.status });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "Provide a valid public GitHub repository URL.", details: { issues: error.issues.length }, retryable: false } }, { status: 400 });
    }
    return errorResponse(error);
  }
}
