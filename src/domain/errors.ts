export type AnalysisErrorStage =
  | "fetch"
  | "tree"
  | "blob"
  | "parse"
  | "analyze"
  | "diagram"
  | "persist";

export interface AppErrorOptions {
  code: string;
  message: string;
  stage?: AnalysisErrorStage;
  reason?: string;
  hint?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export class AppError extends Error {
  public readonly code: string;
  public readonly stage?: AnalysisErrorStage;
  public readonly reason?: string;
  public readonly hint?: string;
  public readonly retryable: boolean;
  public readonly details?: Record<string, unknown>;

  public constructor(options: AppErrorOptions) {
    super(options.message);
    this.name = "AppError";
    this.code = options.code;
    this.stage = options.stage;
    this.reason = options.reason;
    this.hint = options.hint;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}
