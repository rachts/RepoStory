import { z } from "zod";
import { NextResponse } from "next/server";
import { parseGitHubUrl, validateGitHubBranch } from "@/infrastructure/providers/github-url";
import { analysisStore, repositoryProvider, runAnalysis } from "@/composition/container";
import { errorResponse, jsonResponse, readJsonBody } from "@/shared/http";

const MAX_REQUEST_BYTES = 8 * 1024;

const requestSchema = z.object({
  repositoryUrl: z.string().trim().min(1).max(500),
  branch: z.string().trim().min(1).max(255).optional(),
}).strict();

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await readJsonBody(request, MAX_REQUEST_BYTES);
    const input = requestSchema.parse(body);
    const parsed = parseGitHubUrl(input.repositoryUrl);
    if (!parsed.ok) return errorResponse(parsed.error);
    if (input.branch) {
      const branch = validateGitHubBranch(input.branch);
      if (!branch.ok) return errorResponse(branch.error);
    }
    const reference = { ...parsed.value, ...(input.branch ? { branch: input.branch } : {}) };
    const result = await runAnalysis(reference, repositoryProvider, analysisStore);
    if (!result.ok) return errorResponse(result.error);
    return jsonResponse({ analysisId: result.value.id, status: result.value.status });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonResponse({ error: { code: "INVALID_REQUEST", message: "Provide a valid public GitHub repository URL.", details: { issues: error.issues.length }, retryable: false } }, { status: 400 });
    }
    return errorResponse(error);
  }
}
