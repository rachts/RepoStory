import { NextResponse } from "next/server";
import { analysisStore } from "@/composition/container";
import { redactPathValues } from "@/shared/redaction";
import { jsonResponse } from "@/shared/http";

interface RouteContext {
  params: Promise<{ analysisId: string }>;
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  const { analysisId } = await context.params;
  if (analysisId.length > 256) return jsonResponse({ error: { code: "ANALYSIS_NOT_FOUND", message: "Analysis not found.", retryable: false } }, { status: 404 });
  if (!analysisStore.get(analysisId)) return jsonResponse({ error: { code: "ANALYSIS_NOT_FOUND", message: "Analysis not found.", retryable: false } }, { status: 404 });
  return jsonResponse(redactPathValues({ diagrams: analysisStore.listDiagrams(analysisId) }));
}
