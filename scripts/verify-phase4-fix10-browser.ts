import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
import "../src/shared/alias-register";

import { chromium } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { startMockGitHubServer } from "./mock-github-server";
import fs from "node:fs";
import path from "node:path";

const ARTIFACT_DIR = "/Users/macbookair/.gemini/antigravity/brain/e1b02ff2-7557-4d0d-9bab-7f2af8e4ed09";
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function waitForUrl(url: string, timeoutMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404 || res.status === 200) return true;
    } catch {
      // Retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function run() {
  console.log("=== Starting Phase 4 Fix 10 Browser & Cache Hit Diagram Persistence Verification ===");

  // 1. Start Mock GitHub Server on port 4000
  const mockServer = await startMockGitHubServer({ port: 4000 });
  console.log(`[Mock GitHub Server] Running at ${mockServer.baseUrl}`);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: "3000",
    GITHUB_API_BASE_URL: "http://127.0.0.1:4000",
    GITHUB_CODELOAD_BASE_URL: "http://127.0.0.1:4000",
    REPO_STORY_TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    REPO_STORY_CACHE_STORE: "supabase",
    REPO_STORY_JOB_STORE: "supabase",
    REPO_STORY_QUEUE_MODE: "supabase",
    NODE_ENV: "development",
  };

  // 2. Start Next.js dev server on port 3000
  console.log("[Next.js] Starting dev server on http://localhost:3000...");
  const nextProcess: ChildProcess = spawn("npm", ["run", "dev"], {
    env,
    stdio: "pipe",
  });

  nextProcess.stdout?.on("data", (d) => {
    const s = d.toString();
    if (s.includes("Ready in") || s.includes("started server on")) {
      console.log(`[Next.js stdout] ${s.trim()}`);
    }
  });

  const nextReady = await waitForUrl("http://localhost:3000", 30_000);
  if (!nextReady) {
    throw new Error("Next.js dev server failed to become responsive within 30s");
  }
  console.log("[Next.js] Server is ready on http://localhost:3000");

  console.log("[Worker] Starting background worker process on port 10002...");
  const workerProcess: ChildProcess = spawn("node", ["dist/worker.js"], {
    env: {
      ...env,
      PORT: "10002",
    },
    stdio: "pipe",
  });

  workerProcess.stdout?.on("data", (d) => {
    const s = d.toString();
    console.log(`[Worker stdout] ${s.trim()}`);
  });

  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    // Step 1: Submit Run 1 (Cold analysis)
    console.log("[Test] Submitting Run 1 (Cold analysis)...");
    const submit1 = await fetch("http://localhost:3000/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repositoryUrl: "https://github.com/mock-org/cached-repo" }),
    });
    if (submit1.status !== 202) {
      throw new Error(`Run 1 submit failed: ${submit1.status} ${await submit1.text()}`);
    }
    const cookie1 = submit1.headers.get("set-cookie") ?? "";
    const job1Data = (await submit1.json()) as { jobId: string };
    console.log(`[Test] Run 1 queued with jobId: ${job1Data.jobId}`);

    // Poll Run 1 until completed
    let attempts = 0;
    let job1Completed = false;
    let job1AnalysisId = "";
    while (attempts < 30) {
      attempts++;
      await new Promise((r) => setTimeout(r, 1000));
      const res = await fetch(`http://localhost:3000/api/analyze/jobs/${job1Data.jobId}`, {
        headers: cookie1 ? { Cookie: cookie1 } : {},
      });
      const data = (await res.json()) as { status: string; progress: number; stage: string; analysisId?: string };
      console.log(`[Run 1 Poll ${attempts}] Status: ${data.status}, progress: ${data.progress}%, stage: ${data.stage}`);
      if (data.status === "completed") {
        job1Completed = true;
        job1AnalysisId = data.analysisId ?? "";
        break;
      }
      if (data.status === "failed") {
        throw new Error(`Run 1 failed: ${JSON.stringify(data)}`);
      }
    }
    if (!job1Completed) throw new Error("Run 1 did not complete within 30s");
    console.log(`[Test] Run 1 completed with analysisId: ${job1AnalysisId}`);

    // Step 2: Submit Run 2 (Cache hit)
    console.log("[Test] Submitting Run 2 (Cache hit analysis)...");
    const submit2 = await fetch("http://localhost:3000/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie1 },
      body: JSON.stringify({ repositoryUrl: "https://github.com/mock-org/cached-repo" }),
    });
    if (submit2.status !== 202) {
      throw new Error(`Run 2 submit failed: ${submit2.status} ${await submit2.text()}`);
    }
    const cookie2 = submit2.headers.get("set-cookie") ?? cookie1;
    const job2Data = (await submit2.json()) as { jobId: string };
    console.log(`[Test] Run 2 queued with jobId: ${job2Data.jobId}`);

    // Poll Run 2 until completed
    attempts = 0;
    let job2Completed = false;
    let job2AnalysisId = "";
    while (attempts < 30) {
      attempts++;
      await new Promise((r) => setTimeout(r, 1000));
      const res = await fetch(`http://localhost:3000/api/analyze/jobs/${job2Data.jobId}`, {
        headers: cookie2 ? { Cookie: cookie2 } : {},
      });
      const data = (await res.json()) as { status: string; progress: number; stage: string; analysisId?: string };
      console.log(`[Run 2 Poll ${attempts}] Status: ${data.status}, progress: ${data.progress}%, stage: ${data.stage}`);
      if (data.status === "completed") {
        job2Completed = true;
        job2AnalysisId = data.analysisId ?? "";
        break;
      }
      if (data.status === "failed") {
        throw new Error(`Run 2 failed: ${JSON.stringify(data)}`);
      }
    }
    if (!job2Completed) throw new Error("Run 2 did not complete within 30s");
    console.log(`[Test] Run 2 completed with analysisId: ${job2AnalysisId}`);

    // Step 3: Verify /api/analysis/[id]/diagrams for Run 2
    console.log(`[API Check] Querying /api/analysis/${job2AnalysisId}/diagrams...`);
    const diagRes = await fetch(`http://localhost:3000/api/analysis/${job2AnalysisId}/diagrams`, {
      headers: cookie2 ? { Cookie: cookie2 } : {},
    });
    const diagData = (await diagRes.json()) as { diagrams?: unknown[] };
    console.log(`[API Check] Status: ${diagRes.status}, diagrams count: ${diagData.diagrams?.length}`);
    if (!diagData.diagrams || diagData.diagrams.length === 0) {
      throw new Error(`Expected /api/analysis/${job2AnalysisId}/diagrams to return diagrams, but got 0`);
    }

    // Step 4: Open UI in Playwright for Run 2
    console.log(`[Browser] Navigating to http://localhost:3000/analysis/${job2Data.jobId}...`);
    if (cookie2) {
      const match = cookie2.match(/([^=]+)=([^;]+)/);
      if (match) {
        await page.context().addCookies([{
          name: match[1]!.trim(),
          value: match[2]!.trim(),
          domain: "localhost",
          path: "/",
        }]);
      }
    }
    await page.goto(`http://localhost:3000/analysis/${job2Data.jobId}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2000);

    const screenshotPath = path.join(ARTIFACT_DIR, "15-phase4-cache-hit-diagrams.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[Browser] Captured screenshot to: ${screenshotPath}`);

    console.log("=== Phase 4 Fix 10 Browser & Cache Hit Verification PASSED ===");
  } finally {
    await browser.close();
    workerProcess.kill("SIGTERM");
    nextProcess.kill("SIGTERM");
    await mockServer.close();
  }
}

run().catch((err) => {
  console.error("FATAL verification error:", err);
  process.exit(1);
});
