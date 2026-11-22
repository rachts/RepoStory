import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
import "../src/shared/alias-register";

import { chromium } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
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
  console.log("=== Starting Phase 5 Fix 13 Browser Verification: Worker Heartbeat & Offline Indicator ===");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: "3000",
    REPO_STORY_CACHE_STORE: "file",
    REPO_STORY_JOB_STORE: "file",
    REPO_STORY_QUEUE_MODE: "memory",
    NODE_ENV: "development",
  };

  // Start Next.js dev server
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

  let browser;
  try {
    const launchOptions: { headless: boolean; executablePath?: string } = { headless: true };
    if (fs.existsSync(CHROME_PATH)) {
      launchOptions.executablePath = CHROME_PATH;
    }
    browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    // Intercept job status API to simulate a job that is actively analyzing but has a stale heartbeat (>40s old)
    const testJobId = "job-worker-offline-sim";
    const staleHeartbeatTime = new Date(Date.now() - 55_000).toISOString(); // 55 seconds ago

    await page.route(`**/api/analyze/jobs/${testJobId}`, async (route) => {
      console.log(`[Playwright Route] Intercepted job status request for ${testJobId}`);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          jobId: testJobId,
          analysisId: null,
          repositoryUrl: "https://github.com/facebook/react",
          branch: "main",
          status: "analyzing",
          stage: "analyzing-repository",
          progress: 55,
          message: "Finding architecture and entry points",
          createdAt: new Date(Date.now() - 120_000).toISOString(),
          updatedAt: staleHeartbeatTime,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          retryCount: 0,
          explanationRequested: false,
          heartbeatAt: staleHeartbeatTime,
          workerStatus: "offline",
          statusUrl: `/api/analyze/jobs/${testJobId}`,
          resultUrl: null,
        }),
      });
    });

    console.log(`[Playwright] Navigating to http://localhost:3000/analysis/${testJobId}...`);
    await page.goto(`http://localhost:3000/analysis/${testJobId}`, { waitUntil: "domcontentloaded" });

    // Wait for the worker offline indicator
    console.log("[Playwright] Waiting for worker offline indicator in DOM...");
    const indicator = page.locator('[data-testid="worker-offline-indicator"]');
    await indicator.waitFor({ state: "visible", timeout: 15_000 });

    const text = await indicator.textContent();
    console.log(`[Playwright] Found indicator with text: "${text}"`);
    if (!text?.includes("Worker offline")) {
      throw new Error(`Expected text to include 'Worker offline', got: "${text}"`);
    }

    // Capture screenshot
    const screenshotPath = path.join(ARTIFACT_DIR, "16-phase5-worker-offline-indicator.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[Playwright] Captured screenshot: ${screenshotPath}`);

    console.log("=== Phase 5 Fix 13 Browser Verification Succeeded! ===");
  } finally {
    if (browser) await browser.close();
    nextProcess.kill("SIGTERM");
  }
}

run().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
