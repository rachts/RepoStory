import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

interface JobResponse {
  jobId: string;
  analysisId?: string;
  status: string;
  stage: string;
  progress: number;
  message?: string;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: unknown;
  };
  coverage?: unknown;
  createdAt: string;
  updatedAt: string;
}

interface TestRunResult {
  repoUrl: string;
  jobId: string;
  analysisId?: string;
  durationMs: number;
  finalStatus: string;
  finalStage: string;
  message?: string;
  errorCode?: string;
  rateLimitUsedDiff?: number;
  diagramsCount?: number;
  diagramTypes?: string[];
  jobJson: unknown;
  analysisJson?: unknown;
}

async function getRateLimitUsed(): Promise<number | null> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch("https://api.github.com/rate_limit", {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "RepoStory-LiveTest",
      },
    });
    if (!res.ok) return null;
    const data = await res.json() as { resources?: { core?: { used?: number } } };
    return data.resources?.core?.used ?? null;
  } catch {
    return null;
  }
}

async function testRepo(repoUrl: string): Promise<TestRunResult> {
  console.log(`\n========================================`);
  console.log(`Testing repository: ${repoUrl}`);
  console.log(`========================================`);

  const initialRateUsed = await getRateLimitUsed();

  const startTime = Date.now();
  const postRes = await fetch("http://localhost:3000/api/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ repositoryUrl: repoUrl }),
  });

  const cookie = postRes.headers.get("set-cookie") || "";
  const postData = (await postRes.json()) as { jobId: string; statusUrl: string };

  if (!postData.jobId) {
    throw new Error(`Failed to initiate analysis for ${repoUrl}: ${JSON.stringify(postData)}`);
  }

  const jobId = postData.jobId;
  console.log(`Job created: ${jobId}. Polling status...`);

  let finalJob: JobResponse | null = null;
  const pollStart = Date.now();
  const maxPollMs = 120_000;

  while (Date.now() - pollStart < maxPollMs) {
    await new Promise((r) => setTimeout(r, 1000));
    const statusRes = await fetch(`http://localhost:3000/api/analyze/jobs/${encodeURIComponent(jobId)}`, {
      headers: cookie ? { Cookie: cookie.split(";")[0]! } : {},
    });

    if (!statusRes.ok) {
      console.log(`Poll failed with status ${statusRes.status}`);
      continue;
    }

    const job = (await statusRes.json()) as JobResponse;
    process.stdout.write(`\r  [${Math.round((Date.now() - startTime) / 1000)}s] Status: ${job.status} | Stage: ${job.stage} | Progress: ${job.progress}% | ${job.message ?? ""}`);

    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled" || job.status === "expired") {
      finalJob = job;
      console.log();
      break;
    }
  }

  const durationMs = Date.now() - startTime;
  const finalRateUsed = await getRateLimitUsed();
  const rateLimitDiff = (finalRateUsed !== null && initialRateUsed !== null)
    ? (finalRateUsed - initialRateUsed)
    : undefined;

  if (!finalJob) {
    throw new Error(`Job ${jobId} did not reach terminal state within 120s`);
  }

  console.log(`Final status: ${finalJob.status} (${durationMs}ms)`);
  if (finalJob.error) {
    console.log(`Error: [${finalJob.error.code}] ${finalJob.error.message}`);
  }

  let analysisJson: unknown = undefined;
  let diagramsCount: number | undefined = undefined;
  let diagramTypes: string[] | undefined = undefined;

  if (finalJob.status === "completed" && finalJob.analysisId) {
    const analysisRes = await fetch(`http://localhost:3000/api/analyze/${encodeURIComponent(finalJob.analysisId)}`, {
      headers: cookie ? { Cookie: cookie.split(";")[0]! } : {},
    });
    if (analysisRes.ok) {
      analysisJson = await analysisRes.json();
      const parsed = analysisJson as { diagrams?: Array<{ id: string; type: string; title: string }> };
      if (Array.isArray(parsed.diagrams)) {
        diagramsCount = parsed.diagrams.length;
        diagramTypes = parsed.diagrams.map((d) => d.type);
        console.log(`Analysis retrieved successfully! Generated ${diagramsCount} diagrams: ${diagramTypes.join(", ")}`);
      }
    }
  }

  return {
    repoUrl,
    jobId,
    analysisId: finalJob.analysisId,
    durationMs,
    finalStatus: finalJob.status,
    finalStage: finalJob.stage,
    message: finalJob.message,
    errorCode: finalJob.error?.code,
    rateLimitUsedDiff: rateLimitDiff,
    diagramsCount,
    diagramTypes,
    jobJson: finalJob,
    analysisJson,
  };
}

async function run() {
  const targetRepos = [
    "https://github.com/facebook/react",
    "https://github.com/expressjs/express",
    "https://github.com/octocat/Hello-World",
    "https://github.com/rachts/does-not-exist-xyz",
  ];

  const results: TestRunResult[] = [];
  const outDir = path.resolve(process.cwd(), "scripts/live-results");
  fs.mkdirSync(outDir, { recursive: true });

  for (const repo of targetRepos) {
    try {
      const result = await testRepo(repo);
      results.push(result);
      const safeName = repo.replace(/^https:\/\/github\.com\//, "").replace(/\//g, "__");
      fs.writeFileSync(path.join(outDir, `${safeName}.json`), JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`Error running ${repo}:`, err);
    }
  }

  console.log(`\n========================================`);
  console.log(`SUMMARY OF LIVE RUNS`);
  console.log(`========================================`);
  console.table(
    results.map((r) => ({
      Repository: r.repoUrl,
      Status: r.finalStatus,
      Stage: r.finalStage,
      "Duration (s)": (r.durationMs / 1000).toFixed(2),
      "Rate Used": r.rateLimitUsedDiff ?? "N/A",
      "Diagrams Count": r.diagramsCount ?? 0,
      Error: r.errorCode ?? "-",
    })),
  );
}

run();
