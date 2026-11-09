import { analysisRepository, jobQueue } from "@/composition/container";
import { Octokit } from "@octokit/rest";

export interface ReadinessCheckResult {
  ready: boolean;
  checks: {
    github: boolean;
    database: boolean;
    queue: boolean;
  };
  errors?: Record<string, string>;
}

export async function checkReadiness(overrides?: {
  githubCheck?: () => Promise<boolean>;
  databaseCheck?: () => Promise<boolean>;
  queueCheck?: () => Promise<boolean>;
}): Promise<ReadinessCheckResult> {
  const errors: Record<string, string> = {};
  let github = false;
  let database = false;
  let queue = false;

  // 1. Check GitHub connectivity
  if (overrides?.githubCheck) {
    try {
      github = await overrides.githubCheck();
    } catch (e) {
      errors.github = String(e);
    }
  } else {
    try {
      const octokit = new Octokit({ request: { redirect: "error" } });
      const res = await octokit.request("GET https://api.github.com/zen", {
        headers: { "user-agent": "RepoStory-HealthCheck" },
        request: { signal: AbortSignal.timeout(3000) },
      });
      github = res.status === 200;
    } catch (e: unknown) {
      const status = typeof e === "object" && e !== null && "status" in e ? (e as { status?: unknown }).status : undefined;
      github = status === 403 || status === 429;
      if (!github) errors.github = String(e);
    }
  }

  // 2. Check Database connectivity
  if (overrides?.databaseCheck) {
    try {
      database = await overrides.databaseCheck();
    } catch (e) {
      errors.database = String(e);
    }
  } else {
    try {
      const ping = await analysisRepository.getJob("non-existent-probe-id");
      database = ping === null || ping === undefined || typeof ping === "object";
    } catch (e) {
      errors.database = String(e);
    }
  }

  // 3. Check Queue functionality
  if (overrides?.queueCheck) {
    try {
      queue = await overrides.queueCheck();
    } catch (e) {
      errors.queue = String(e);
    }
  } else {
    try {
      const dummyClaim = await jobQueue.claim("health-probe-worker");
      queue = dummyClaim === undefined || Boolean(dummyClaim);
    } catch (e) {
      errors.queue = String(e);
    }
  }

  const ready = github && database && queue;
  return {
    ready,
    checks: { github, database, queue },
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  };
}
