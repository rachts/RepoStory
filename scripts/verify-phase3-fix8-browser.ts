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
  console.log("=== Starting Phase 3 Fix 8 Browser & Private Repo Token Leak Verification ===");

  const SECRET_PRIVATE_TOKEN = "ghp_mock_secret_pat_987654321_strictly_confidential";

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

  const webLogs: string[] = [];
  nextProcess.stdout?.on("data", (d) => {
    const s = d.toString();
    webLogs.push(s);
    if (s.includes("Ready in") || s.includes("started server on")) {
      console.log(`[Next.js stdout] ${s.trim()}`);
    }
  });
  nextProcess.stderr?.on("data", (d) => {
    const s = d.toString();
    webLogs.push(s);
    console.error(`[Next.js stderr] ${s.trim()}`);
  });

  const nextReady = await waitForUrl("http://localhost:3000", 30_000);
  if (!nextReady) {
    throw new Error("Next.js dev server failed to become responsive within 30s");
  }
  console.log("[Next.js] Server is ready on http://localhost:3000");

  const workerLogs: string[] = [];
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
    workerLogs.push(s);
    console.log(`[Worker stdout] ${s.trim()}`);
  });
  workerProcess.stderr?.on("data", (d) => {
    const s = d.toString();
    workerLogs.push(s);
    console.error(`[Worker stderr] ${s.trim()}`);
  });

  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
  });

  try {
    const page = await browser.newPage();

    // 3. Submit analysis for private repo with token
    console.log("[Test] Submitting analysis request for private repo with token...");
    const submitResponse = await fetch("http://localhost:3000/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repositoryUrl: "https://github.com/mock-org/private-repo",
        token: SECRET_PRIVATE_TOKEN,
      }),
    });

    if (submitResponse.status !== 202) {
      const errText = await submitResponse.text();
      console.error(`Submit failed with ${submitResponse.status}:`, errText);
    }
    expectStatus(submitResponse.status, 202, "Submit response status");
    const cookie = submitResponse.headers.get("set-cookie") ?? "";
    const submitData = (await submitResponse.json()) as { jobId: string; statusUrl: string };
    console.log(`[Test] Analysis queued with jobId: ${submitData.jobId}`);

    // Verify raw token is NOT in submit response
    const submitBodyStr = JSON.stringify(submitData);
    if (submitBodyStr.includes(SECRET_PRIVATE_TOKEN)) {
      throw new Error("SECURITY LEAK: Raw token leaked in POST /api/analyze response!");
    }

    // 4. Poll until complete
    let attempts = 0;
    let completed = false;
    let finalStatus: Record<string, unknown> = {};

    while (attempts < 30) {
      attempts++;
      await new Promise((r) => setTimeout(r, 1000));
      const statusRes = await fetch(`http://localhost:3000/api/analyze/jobs/${submitData.jobId}`, {
        headers: cookie ? { Cookie: cookie } : {},
      });
      const statusData = (await statusRes.json()) as Record<string, unknown>;
      finalStatus = statusData;

      const statusDataStr = JSON.stringify(statusData);
      if (statusDataStr.includes(SECRET_PRIVATE_TOKEN)) {
        throw new Error("SECURITY LEAK: Raw token leaked in GET /api/analyze/jobs/[jobId] response!");
      }

      console.log(`[Poll ${attempts}] Status: ${statusData.status}, progress: ${statusData.progress}%, stage: ${statusData.stage}`);
      if (statusData.status === "completed") {
        completed = true;
        break;
      }
      if (statusData.status === "failed") {
        throw new Error(`Job unexpectedly failed: ${JSON.stringify(statusData)}`);
      }
    }

    if (!completed) {
      throw new Error(`Job did not complete in 30s. Final status: ${JSON.stringify(finalStatus)}`);
    }

    // 5. Open UI in Playwright to verify rendering of results
    console.log(`[Playwright] Navigating to http://localhost:3000/analysis/${submitData.jobId}...`);
    await page.goto(`http://localhost:3000/analysis/${submitData.jobId}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    const screenshotPath = path.join(ARTIFACT_DIR, "14-phase3-private-repo-authenticated.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[Playwright] Screenshot captured at: ${screenshotPath}`);

    // 6. Grep logs to ensure no secret token was logged anywhere
    const allLogs = [...webLogs, ...workerLogs].join("\n");
    if (allLogs.includes(SECRET_PRIVATE_TOKEN)) {
      throw new Error("SECURITY LEAK: Raw token found logged in stdout/stderr!");
    }
    console.log("[Security Check] Confirmed ZERO raw token occurrences in logs or API responses.");
    console.log("=== Phase 3 Fix 8 Verification SUCCESSFUL! ===");
  } finally {
    await browser.close();
    workerProcess.kill("SIGTERM");
    nextProcess.kill("SIGTERM");
    await mockServer.close();
  }
}

function expectStatus(actual: number, expected: number, msg: string) {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${expected}, got ${actual}`);
  }
}

run().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
