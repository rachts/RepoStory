import * as Sentry from "@sentry/nextjs";

export function scrubRequestBody(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return body;
  if (Array.isArray(body)) return body.map(scrubRequestBody);

  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes("token") ||
      lowerKey.includes("password") ||
      lowerKey.includes("secret") ||
      lowerKey.includes("authorization") ||
      lowerKey.includes("cookie") ||
      lowerKey.includes("apikey")
    ) {
      scrubbed[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null) {
      scrubbed[key] = scrubRequestBody(value);
    } else {
      scrubbed[key] = value;
    }
  }
  return scrubbed;
}

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    beforeSend(event) {
      if (event.request?.data) {
        try {
          if (typeof event.request.data === "string") {
            const parsed = JSON.parse(event.request.data);
            event.request.data = JSON.stringify(scrubRequestBody(parsed));
          } else {
            event.request.data = scrubRequestBody(event.request.data);
          }
        } catch {
          event.request.data = "[SCRUBBED]";
        }
      }
      return event;
    },
  });
}
