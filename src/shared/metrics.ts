import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "repostory_" });

export const repostoryJobsTotal = new Counter({
  name: "repostory_jobs_total",
  help: "Total analysis jobs partitioned by terminal status",
  labelNames: ["status"] as const,
  registers: [registry],
});

export const repostoryJobDurationSeconds = new Histogram({
  name: "repostory_job_duration_seconds",
  help: "Duration of repository analysis jobs and pipeline stages",
  labelNames: ["stage"] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120],
  registers: [registry],
});

export const repostoryGitHubRequestsTotal = new Counter({
  name: "repostory_github_requests_total",
  help: "Total GitHub requests sent by the application",
  labelNames: ["endpoint", "status"] as const,
  registers: [registry],
});

export const repostoryGitHubRateLimitErrorsTotal = new Counter({
  name: "repostory_github_rate_limit_errors_total",
  help: "Total rate limit errors encountered against GitHub API",
  registers: [registry],
});
