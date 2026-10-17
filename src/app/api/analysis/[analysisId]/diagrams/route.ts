import { NextResponse } from "next/server";
import { analysisStore } from "@/composition/container";

interface RouteContext {
  params: Promise<{ analysisId: string }>;
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  const { analysisId } = await context.params;
  if (!analysisStore.get(analysisId)) return NextResponse.json({ error: { code: "ANALYSIS_NOT_FOUND", message: "Analysis not found.", retryable: false } }, { status: 404 });
  return NextResponse.json({ diagrams: analysisStore.listDiagrams(analysisId) });
}
