import { NextResponse, type NextRequest } from "next/server";
import { handleCors } from "@/infrastructure/security/cors";

function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || request.nextUrl.host;
    return originUrl.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

export function middleware(request: NextRequest): NextResponse {
  const origin = request.headers.get("origin");
  const isApi = request.nextUrl.pathname.startsWith("/api/");
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();

  // Handle CORS for /api routes
  if (isApi && origin) {
    // Same-origin requests sent by browsers (which include Origin on POST) are not cross-origin
    if (isSameOrigin(request)) {
      const response = NextResponse.next();
      response.headers.set("x-request-id", requestId);
      return response;
    }

    const cors = handleCors(origin, request.method);
    if (!cors.allowed) {
      return new NextResponse(
        JSON.stringify({
          error: {
            code: "FORBIDDEN",
            message: "Cross-origin request forbidden",
            retryable: false,
          },
        }),
        {
          status: 403,
          headers: {
            "Content-Type": "application/json",
            "x-request-id": requestId,
          },
        },
      );
    }

    if (cors.isPreflight) {
      return new NextResponse(null, {
        status: 204,
        headers: {
          ...cors.headers,
          "x-request-id": requestId,
        },
      });
    }

    const response = NextResponse.next();
    response.headers.set("x-request-id", requestId);
    for (const [key, value] of Object.entries(cors.headers)) {
      response.headers.set(key, value);
    }
    return response;
  }

  const response = NextResponse.next();
  response.headers.set("x-request-id", requestId);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
