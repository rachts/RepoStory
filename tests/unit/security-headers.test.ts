import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { handleCors } from "@/infrastructure/security/cors";
import { middleware } from "@/middleware";
import { NextRequest } from "next/server";

describe("Workstream 10: Security Headers and CORS", () => {
  describe("next.config headers", () => {
    it("configures strict security headers across all routes", async () => {
      const headerList = await nextConfig.headers!();
      const globalHeaders = headerList.find((h) => h.source === "/:path*");
      expect(globalHeaders).toBeDefined();

      const headersMap = new Map(globalHeaders!.headers.map((h) => [h.key, h.value]));

      expect(headersMap.get("X-Content-Type-Options")).toBe("nosniff");
      expect(headersMap.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains; preload");
      expect(headersMap.get("X-Frame-Options")).toBe("DENY");
      expect(headersMap.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
      expect(headersMap.get("Permissions-Policy")).toContain("camera=()");
      expect(headersMap.get("Permissions-Policy")).toContain("microphone=()");
      expect(headersMap.get("Permissions-Policy")).toContain("geolocation=()");

      const csp = headersMap.get("Content-Security-Policy") || "";
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
      expect(csp).toContain("connect-src 'self' https://api.github.com");
    });
  });

  describe("CORS handler", () => {
    const allowed = ["https://dashboard.example.com", "https://app.repostory.dev"];

    it("allows non-browser direct requests (no Origin header)", () => {
      const result = handleCors(null, "GET", allowed);
      expect(result.allowed).toBe(true);
      expect(result.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    });

    it("rejects unauthorized cross-origin requests with 403", () => {
      const result = handleCors("https://malicious.evil.com", "POST", allowed);
      expect(result.allowed).toBe(false);
      expect(result.status).toBe(403);
      expect(result.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    });

    it("rejects unauthorized preflight OPTIONS requests with 403", () => {
      const result = handleCors("https://malicious.evil.com", "OPTIONS", allowed);
      expect(result.allowed).toBe(false);
      expect(result.status).toBe(403);
    });

    it("permits allowed origin and returns exact matching Access-Control-Allow-Origin", () => {
      const result = handleCors("https://dashboard.example.com", "POST", allowed);
      expect(result.allowed).toBe(true);
      expect(result.headers["Access-Control-Allow-Origin"]).toBe("https://dashboard.example.com");
      expect(result.headers["Access-Control-Allow-Credentials"]).toBe("true");
    });

    it("handles preflight OPTIONS requests for allowed origin with 204 status", () => {
      const result = handleCors("https://app.repostory.dev", "OPTIONS", allowed);
      expect(result.allowed).toBe(true);
      expect(result.isPreflight).toBe(true);
      expect(result.status).toBe(204);
      expect(result.headers["Access-Control-Allow-Origin"]).toBe("https://app.repostory.dev");
      expect(result.headers["Access-Control-Allow-Methods"]).toContain("POST");
    });
  });

  describe("Middleware integration", () => {
    it("injects x-request-id on incoming requests", () => {
      const req = new NextRequest("http://localhost:3000/api/health/live");
      const res = middleware(req);
      expect(res.headers.get("x-request-id")).toBeDefined();
    });

    it("blocks cross-origin API calls from unauthorized origins with structured 403 JSON", async () => {
      const req = new NextRequest("http://localhost:3000/api/analyze", {
        headers: {
          origin: "https://unauthorized-site.com",
        },
      });
      const res = middleware(req);
      expect(res.status).toBe(403);
      expect(res.headers.get("content-type")).toContain("application/json");
      const json = await res.json();
      expect(json.error).toEqual({
        code: "FORBIDDEN",
        message: "Cross-origin request forbidden",
        retryable: false,
      });
    });

    it("allows same-origin API calls with matching Origin header without blocking", () => {
      const req = new NextRequest("http://localhost:3000/api/analyze", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
        },
      });
      const res = middleware(req);
      expect(res.status).not.toBe(403);
    });
  });
});
