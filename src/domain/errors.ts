export interface AppErrorOptions {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, string | number | boolean>;
}

export class AppError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly details?: Record<string, string | number | boolean>;

  public constructor(options: AppErrorOptions) {
    super(options.message);
    this.name = "AppError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}
