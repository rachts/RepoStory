import pino from "pino";

export const REDACTION_PATHS = [
  "authorization",
  "Authorization",
  "token",
  "tokens",
  "cookie",
  "Cookie",
  "headers.authorization",
  "headers.cookie",
  "headers.Authorization",
  "headers.Cookie",
  "req.headers.authorization",
  "req.headers.cookie",
  "*.token",
  "*.tokens",
  "*.secret",
  "*.password",
  "*.apiKey",
  "githubToken",
  "bearer",
];

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  redact: {
    paths: REDACTION_PATHS,
    censor: "[REDACTED]",
  },
});

export interface LogContext {
  requestId?: string;
  jobId?: string;
  analysisId?: string;
  stage?: string;
  code?: string;
  [key: string]: unknown;
}

export function createChildLogger(context: LogContext): pino.Logger {
  return logger.child(context);
}
