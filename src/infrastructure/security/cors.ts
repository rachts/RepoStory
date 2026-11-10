export interface CorsResult {
  allowed: boolean;
  headers: Record<string, string>;
  isPreflight: boolean;
  status?: number;
}

export function getAllowedOrigins(): string[] {
  const env = process.env.CORS_ALLOWED_ORIGINS?.trim();
  if (!env) return [];
  return env.split(",").map((o) => o.trim()).filter((o) => o.length > 0);
}

export function handleCors(
  requestOrigin: string | null | undefined,
  requestMethod: string = "GET",
  allowedOrigins: string[] = getAllowedOrigins(),
): CorsResult {
  const isPreflight = requestMethod.toUpperCase() === "OPTIONS";

  // Same-origin or non-browser requests (no Origin header)
  if (!requestOrigin) {
    return {
      allowed: true,
      headers: {},
      isPreflight,
    };
  }

  const isAllowed = allowedOrigins.includes(requestOrigin);

  if (!isAllowed) {
    return {
      allowed: false,
      headers: {},
      isPreflight,
      status: 403,
    };
  }

  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": requestOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-request-id",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
  };

  return {
    allowed: true,
    headers,
    isPreflight,
    status: isPreflight ? 204 : undefined,
  };
}
