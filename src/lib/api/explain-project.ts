import { projectExplanationSchema, type ProjectExplanation } from "@/domain/ai-explanation";

export interface ProjectExplanationResponse {
  analysisId: string;
  explanation: ProjectExplanation;
  model: string;
  generatedAt: string;
}

export class ExplainProjectError extends Error {
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

export async function explainProject(analysisId: string, signal?: AbortSignal, force = false): Promise<ProjectExplanationResponse> {
  const response = await fetch("/api/explain", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ analysisId, ...(force ? { force: true } : {}) }),
    ...(signal ? { signal } : {}),
  });
  const payload = await response.json().catch(() => null) as ProjectExplanationResponse | { error?: { code?: string; message?: string; retryable?: boolean } } | null;
  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; retryable?: boolean } } | null)?.error;
    throw new ExplainProjectError({ code: error?.code ?? "AI_EXPLANATION_FAILED", message: error?.message ?? "The project explanation could not be generated.", status: response.status, retryable: error?.retryable ?? response.status >= 500 });
  }
  const parsed = payload as ProjectExplanationResponse | null;
  const explanation = projectExplanationSchema.safeParse(parsed?.explanation);
  if (!parsed?.analysisId || !parsed.model || !parsed.generatedAt || !explanation.success) {
    throw new ExplainProjectError({ code: "AI_INVALID_RESPONSE", message: "The project explanation response was incomplete.", status: 502, retryable: true });
  }
  return { analysisId: parsed.analysisId, model: parsed.model, generatedAt: parsed.generatedAt, explanation: explanation.data };
}
