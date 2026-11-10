import { runAnalysis } from "../src/application/pipeline";
import { InMemoryAnalysisStore } from "../src/application/store";
import {
  GitHubPublicRepositoryProvider,
  getDebugRequestProfile,
  resetDebugRequestProfile,
} from "../src/infrastructure/providers/github-provider";

interface RateLimitCore {
  limit: number;
  remaining: number;
  reset: number;
  used: number;
}

async function getRateLimit(token?: string): Promise<RateLimitCore> {
  const headers: Record<string, string> = { "User-Agent": "RepoStory-Measure" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch("https://api.github.com/rate_limit", { headers });
  const data = (await res.json()) as { resources?: { core?: RateLimitCore } };
  return data.resources?.core ?? { limit: 0, remaining: 0, reset: 0, used: 0 };
}

async function measureRepo(owner: string, name: string) {
  process.env.REPO_STORY_DEBUG_REQUESTS = "1";
  const token = process.env.GITHUB_TOKEN;
  console.log(`\n========================================`);
  console.log(`Measuring ${owner}/${name}...`);
  console.log(`========================================`);

  const initialRate = await getRateLimit(token);
  console.log(`Initial rate limit: used=${initialRate.used}, remaining=${initialRate.remaining}`);

  resetDebugRequestProfile();
  let peakHeap = process.memoryUsage().heapUsed;
  const heapInterval = setInterval(() => {
    const current = process.memoryUsage().heapUsed;
    if (current > peakHeap) peakHeap = current;
  }, 50);

  const provider = new GitHubPublicRepositoryProvider({
    fetchImpl: fetch,
    token,
  });
  const store = new InMemoryAnalysisStore({ maxAnalyses: 10, ttlMs: 3600_000 });

  const startTime = Date.now();
  let status = "unknown";
  let errorMsg = "";
  let commitSha = "unknown";

  try {
    const result = await runAnalysis(
      { owner, name, url: `https://github.com/${owner}/${name}` },
      provider,
      store,
    );
    if (result.ok) {
      status = "completed";
      commitSha = result.value.repository.defaultBranch;
      console.log(`Analysis succeeded! Files analyzed: ${result.value.filesAnalyzed}`);
    } else {
      status = "failed";
      errorMsg = `${result.error.code}: ${result.error.message}`;
      console.log(`Analysis failed: ${errorMsg}`);
    }
  } catch (err) {
    status = "crashed";
    errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`Analysis crashed: ${errorMsg}`);
  } finally {
    clearInterval(heapInterval);
  }

  const durationMs = Date.now() - startTime;
  const finalRate = await getRateLimit(token);
  const quotaConsumed = finalRate.used - initialRate.used;
  const requests = getDebugRequestProfile();

  console.log(`\n--- Results for ${owner}/${name} ---`);
  console.log(`Final Status: ${status} ${errorMsg ? `(${errorMsg})` : ""}`);
  console.log(`Wall-clock Duration: ${(durationMs / 1000).toFixed(2)}s (${durationMs}ms)`);
  console.log(`Peak Heap: ${(peakHeap / (1024 * 1024)).toFixed(2)} MB (${peakHeap} bytes)`);
  console.log(`Rate-limit Units Consumed: ${quotaConsumed}`);
  console.log(`Final Rate Limit Remaining: ${finalRate.remaining}`);
  console.log(`Total GitHub API Requests: ${requests.total}`);
  console.log(`Request Breakdown:`);
  console.log(`  /repos: ${requests.byEndpoint["/repos"]}`);
  console.log(`  /git/trees: ${requests.byEndpoint["/git/trees"]}`);
  console.log(`  /contents: ${requests.byEndpoint["/contents"]}`);
  console.log(`  /git/blobs: ${requests.byEndpoint["/git/blobs"]}`);
  console.log(`  /compare: ${requests.byEndpoint["/compare"]}`);
  console.log(`  other: ${requests.byEndpoint.other}`);

  return {
    repo: `${owner}/${name}`,
    status,
    errorMsg,
    durationMs,
    peakHeap,
    quotaConsumed,
    remainingQuota: finalRate.remaining,
    requests,
  };
}

async function main() {
  const target = process.argv[2];
  if (target === "express") {
    await measureRepo("expressjs", "express");
  } else if (target === "react") {
    await measureRepo("facebook", "react");
  } else {
    await measureRepo("expressjs", "express");
    await measureRepo("facebook", "react");
  }
}

main().catch(console.error);

