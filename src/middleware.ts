import { NextResponse, type NextRequest } from "next/server";
import { handleCors } from "@/infrastructure/security/cors";

export function middleware(request: NextRequest): NextResponse {
  const origin = request.headers.get("origin");
  const isApi = request.nextUrl.pathname.startsWith("/api/");
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();

  // Handle CORS for /api routes
  if (isApi && origin) {
    const cors = handleCors(origin, request.method);
    if (!cors.allowed) {
      return new NextResponse(JSON.stringify({ error: "Cross-origin request forbidden" }), {
        status: 403,
        headers: {
          "Content-Type": "application/json",
          "x-request-id": requestId,
        },
      });
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
