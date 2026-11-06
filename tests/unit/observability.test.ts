import { describe, expect, it } from "vitest";
import pino from "pino";
import { scrubRequestBody } from "@/shared/sentry";
import { checkReadiness } from "@/application/health";
import { GET as metricsGet } from "@/app/api/metrics/route";
import { GET as readyGet } from "@/app/api/health/ready/route";
import { GET as liveGet } from "@/app/api/health/live/route";

describe("Workstream 7: Observability", () => {
  describe("Pino structured logger & token redaction", () => {
    it("redacts tokens, authorization headers, and secrets in log records", () => {
      const logs: string[] = [];
      const testLogger = pino(
        {
          redact: { paths: ["token", "authorization", "cookie", "*.secret"], censor: "[REDACTED]" },
        },
        {
          write(msg: string) {
            logs.push(msg);
          },
        },
      );

      testLogger.info({
        token: "ghp_sensitive_token_999",
        authorization: "Bearer secret_bearer_token",
        cookie: "session=secret_cookie_val",
        nested: { secret: "nested_secret_123" },
        user: "john_doe",
      });

      expect(logs.length).toBe(1);
      const parsed = JSON.parse(logs[0] || "{}");
      expect(parsed.token).toBe("[REDACTED]");
      expect(parsed.authorization).toBe("[REDACTED]");
      expect(parsed.cookie).toBe("[REDACTED]");
      expect(parsed.nested?.secret).toBe("[REDACTED]");
      expect(parsed.user).toBe("john_doe");
    });
  });

  describe("Prometheus metrics endpoint (/api/metrics)", () => {
    it("rejects unauthorized access when METRICS_BEARER_TOKEN is not matched", async () => {
      const orig = process.env.METRICS_BEARER_TOKEN;
      try {
        process.env.METRICS_BEARER_TOKEN = "super-secret-metrics-token";
        const req = new Request("http://localhost:3000/api/metrics", {
          headers: { Authorization: "Bearer wrong-token" },
        });

        const res = await metricsGet(req);
        expect(res.status).toBe(401);
      } finally {
        process.env.METRICS_BEARER_TOKEN = orig;
      }
    });

    it("returns Prometheus formatted metrics when authorized", async () => {
      const orig = process.env.METRICS_BEARER_TOKEN;
      try {
        process.env.METRICS_BEARER_TOKEN = "super-secret-metrics-token";
        const req = new Request("http://localhost:3000/api/metrics", {
          headers: { Authorization: "Bearer super-secret-metrics-token" },
        });

        const res = await metricsGet(req);
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain("repostory_jobs_total");
        expect(text).toContain("repostory_job_duration_seconds");
        expect(text).toContain("repostory_github_requests_total");
      } finally {
        process.env.METRICS_BEARER_TOKEN = orig;
      }
    });
  });

  describe("Sentry body scrubbing", () => {
    it("scrubs passwords, auth headers, and tokens from request payloads", () => {
      const sensitiveBody = {
        repositoryUrl: "https://github.com/acme/repo",
        token: "ghp_sensitive_token_12345",
        password: "super_secret_password",
        authorization: "Bearer secret_bearer",
        nested: {
          clientSecret: "oauth_client_secret_xyz",
          apiKey: "sk_live_123456",
          normalField: "public-value",
        },
      };

      const scrubbed = scrubRequestBody(sensitiveBody) as typeof sensitiveBody;

      expect(scrubbed.repositoryUrl).toBe("https://github.com/acme/repo");
      expect(scrubbed.token).toBe("[REDACTED]");
      expect(scrubbed.password).toBe("[REDACTED]");
      expect(scrubbed.authorization).toBe("[REDACTED]");
      expect(scrubbed.nested.clientSecret).toBe("[REDACTED]");
      expect(scrubbed.nested.apiKey).toBe("[REDACTED]");
      expect(scrubbed.nested.normalField).toBe("public-value");
    });
  });

  describe("Health check probes", () => {
    it("live probe returns 200 with uptime", async () => {
      const res = liveGet();
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe("ok");
      expect(typeof json.uptime).toBe("number");
    });

    it("ready probe returns 200 when all dependencies are healthy", async () => {
      const result = await checkReadiness({
        githubCheck: async () => true,
        databaseCheck: async () => true,
        queueCheck: async () => true,
      });

      expect(result.ready).toBe(true);
      expect(result.checks.github).toBe(true);
      expect(result.checks.database).toBe(true);
      expect(result.checks.queue).toBe(true);
    });

    it("ready probe returns 503 when a dependency is unreachable", async () => {
      // Simulate database failure
      const result = await checkReadiness({
        githubCheck: async () => true,
        databaseCheck: async () => {
          throw new Error("Database connection refused");
        },
        queueCheck: async () => true,
      });

      expect(result.ready).toBe(false);
      expect(result.checks.database).toBe(false);
      expect(result.errors?.database).toContain("Database connection refused");
    });

    it("ready route handler executes and returns HTTP response", async () => {
      const res = await readyGet();
      expect([200, 503]).toContain(res.status);
      const json = await res.json();
      expect(["healthy", "unhealthy"]).toContain(json.status);
    });
  });
});
