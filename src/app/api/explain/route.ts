import { NextResponse } from "next/server";
import { z } from "zod";
import { buildExplanationInput, collectExplanationEvidenceIds } from "@/application/ai/build-explanation-input";
import { analysisStore } from "@/composition/container";
import { analysisRepository } from "@/composition/container";
import { ownerIdFromRequest } from "@/application/jobs/job-identity";
import { projectExplanationSchema, unknownExplanationEvidenceIds } from "@/domain/ai-explanation";
import { AppError } from "@/domain/errors";
import { generateProjectExplanation } from "@/infrastructure/ai/groq-client";
import { errorResponse, jsonResponse, readJsonBody } from "@/shared/http";
import { redactPathValues } from "@/shared/redaction";
import { serverConfig } from "@/shared/config";

const MAX_REQUEST_BYTES = 8 * 1024;
const requestSchema = z.object({ analysisId: z.string().trim().min(1).max(256), force: z.boolean().optional().default(false) }).strict();

export async function POST(request: Request): Promise<NextResponse> {
  let persistedJob: Awaited<ReturnType<typeof analysisRepository.getJobByAnalysisId>>;
  let persistedAnalysisId: string | undefined;
  try {
    const body = await readJsonBody(request, MAX_REQUEST_BYTES);
    const input = requestSchema.parse(body);
    persistedAnalysisId = input.analysisId;
    const { ownerId } = ownerIdFromRequest(request);
    const job = await analysisRepository.getJobByAnalysisId(input.analysisId, ownerId);
    persistedJob = job;
    const cachedExplanation = job && !input.force ? await analysisRepository.getExplanation(input.analysisId, ownerId) : undefined;
    if (cachedExplanation) {
      const parsedCachedExplanation = projectExplanationSchema.safeParse(cachedExplanation);
      if (parsedCachedExplanation.success) return jsonResponse(redactPathValues({ analysisId: input.analysisId, explanation: parsedCachedExplanation.data, model: serverConfig.groqModel, generatedAt: new Date().toISOString(), cached: true }));
    }
    const cachedUnavailable = job && !input.force ? await analysisRepository.getExplanationUnavailable(input.analysisId, ownerId) : undefined;
    // Request/schema rejections can be fixed by a server deployment. Do not
    // let an old cached provider rejection permanently disable explanations.
    const retryAfterProviderFix = cachedUnavailable?.code === "AI_REQUEST_REJECTED" || cachedUnavailable?.code === "AI_INVALID_RESPONSE";
    if (cachedUnavailable && !retryAfterProviderFix) return jsonResponse({ error: { code: cachedUnavailable.code, message: cachedUnavailable.message, retryable: false } }, { status: 503 });
    const analysis = job ? await analysisRepository.getAnalysisResult(input.analysisId, ownerId) : analysisStore.get(input.analysisId);
    if (!analysis) return jsonResponse({ error: { code: "ANALYSIS_NOT_FOUND", message: "Analysis not found.", retryable: false } }, { status: 404 });
    if (analysis.status !== "completed") return jsonResponse({ error: { code: "AI_NOT_READY", message: "The deterministic analysis is not complete yet.", retryable: true } }, { status: 409 });

    const diagrams = job ? await analysisRepository.listAnalysisDiagrams(input.analysisId, ownerId) : analysisStore.listDiagrams(input.analysisId);
    const explanationInput = buildExplanationInput(analysis, diagrams, serverConfig.groqMaxInputChars);
    const explanation = await generateProjectExplanation(explanationInput.serialized);
    const unknownEvidenceIds = unknownExplanationEvidenceIds(explanation, collectExplanationEvidenceIds(explanationInput.payload));
    if (unknownEvidenceIds.length) throw new AppError({ code: "AI_INVALID_RESPONSE", message: "The AI explanation referenced evidence that was not supplied by the analysis.", retryable: true, details: { unknownEvidenceReferences: unknownEvidenceIds.length } });
    if (job) await analysisRepository.saveExplanation(input.analysisId, explanation, ownerId);
    return jsonResponse(redactPathValues({ analysisId: input.analysisId, explanation, model: serverConfig.groqModel, generatedAt: new Date().toISOString() }));
  } catch (error) {
    if (error instanceof z.ZodError) return jsonResponse({ error: { code: "INVALID_REQUEST", message: "Provide a valid analysis ID.", retryable: false } }, { status: 400 });
    if (persistedJob && persistedAnalysisId && error instanceof AppError && !error.retryable) await analysisRepository.saveExplanationUnavailable(persistedAnalysisId, { code: error.code, message: error.message }, persistedJob.ownerId).catch(() => undefined);
    return errorResponse(error);
  }
}
