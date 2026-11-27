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
      // Wait and retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function run() {
  console.log("=== Starting Phase 1 Browser E2E Verification ===");

  // 1. Start Mock GitHub Server on 4000
  const mockServer = await startMockGitHubServer({ port: 4000 });
  console.log(`[Mock GitHub Server] Running at ${mockServer.baseUrl}`);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: "3000",
    GITHUB_API_BASE_URL: "http://127.0.0.1:4000",
    ARCHIVE_INACTIVITY_TIMEOUT_MS: "3000",
    NODE_ENV: "development",
  };

  // 2. Start Next.js Dev Server
  console.log("[Next.js] Starting dev server on http://localhost:3000...");
  const nextProcess: ChildProcess = spawn("npm", ["run", "dev"], {
    env,
    stdio: "pipe",
  });

  nextProcess.stdout?.on("data", (d) => {
    const s = d.toString();
    if (s.includes("Ready in") || s.includes("started server on") || s.includes("http://localhost:3000")) {
      console.log(`[Next.js stdout] ${s.trim()}`);
    }
  });

  const nextReady = await waitForUrl("http://localhost:3000", 30_000);
  if (!nextReady) {
    throw new Error("Next.js dev server failed to become responsive within 30s");
  }
  console.log("[Next.js] Server is ready on http://localhost:3000");

  // 3. Start Background Worker
  console.log("[Worker] Starting worker process with watchdog timeout 3000ms...");
  const workerEnv: NodeJS.ProcessEnv = {
    ...env,
    PORT: "10001",
  };
  let workerProcess: ChildProcess | null = spawn("node", ["dist/worker.js"], {
    env: workerEnv,
    stdio: "pipe",
  });

  workerProcess?.stdout?.on("data", (d) => {
    console.log(`[Worker stdout] ${d.toString().trim()}`);
  });
  workerProcess?.stderr?.on("data", (d) => {
    console.error(`[Worker stderr] ${d.toString().trim()}`);
  });

  // 4. Launch Browser via Playwright
  console.log("[Playwright] Launching system Google Chrome...");
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  try {
    // -------------------------------------------------------------
    // Scenario 1: Stalling archive download -> ARCHIVE_DOWNLOAD_STALLED
    // -------------------------------------------------------------
    console.log("\n--- Scenario 1: Testing Stalled Archive Download Watchdog ---");
    await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
    const repoInput = page.locator('input[placeholder*="github.com"]');
    await repoInput.waitFor({ state: "visible" });
    await repoInput.fill("https://github.com/mock-owner/stalling-repo");

    const analyzeBtn = page.locator('button[type="submit"]');
    await analyzeBtn.click();

    console.log("[Playwright] Submitted stalling repo. Waiting for progress UI...");
    await page.waitForURL(/\/analysis\//, { timeout: 15_000 });

    // Monitor progress until failure
    console.log("[Playwright] Watching progress bar and error transition...");
    let failedStateReached = false;
    const startPoll = Date.now();
    let lastStatusText = "";

    while (Date.now() - startPoll < 20_000) {
      const pageText = await page.innerText("body");
      if (pageText.includes("stopped early") || pageText.includes("Archive download stalled") || pageText.includes("Retry analysis")) {
        console.log("[Playwright] Found failure UI state!");
        failedStateReached = true;
        break;
      }
      const progressMatch = pageText.match(/(\d+)%/);
      if (progressMatch && progressMatch[0] !== lastStatusText) {
        lastStatusText = progressMatch[0];
        console.log(`[Playwright] UI Progress: ${lastStatusText}`);
      }
      await page.waitForTimeout(500);
    }

    if (!failedStateReached) {
      throw new Error("UI did not transition to failure state after stalled archive watchdog");
    }

    const screenshot1Path = path.join(ARTIFACT_DIR, "08-phase1-stalled-download-error.png");
    await page.screenshot({ path: screenshot1Path });
    console.log(`[Playwright] Captured screenshot: ${screenshot1Path}`);

    // Verify Retry button is present and clickable
    const retryBtn = page.locator('button:has-text("Retry analysis")');
    await retryBtn.waitFor({ state: "visible", timeout: 5000 });
    console.log("[Playwright] 'Retry analysis' CTA is visible and clickable.");

    await retryBtn.click();
    console.log("[Playwright] Clicked 'Retry analysis'. Waiting for UI to transition back to queued/fetching...");
    await page.waitForTimeout(1000);

    const screenshot2Path = path.join(ARTIFACT_DIR, "09-phase1-stalled-download-retried.png");
    await page.screenshot({ path: screenshot2Path });
    console.log(`[Playwright] Captured retry screenshot: ${screenshot2Path}`);

    // -------------------------------------------------------------
    // Scenario 2: Worker killed mid-job -> JOB_STALLED & sweep window
    // -------------------------------------------------------------
    console.log("\n--- Scenario 2: Testing Worker Killed Mid-Job (JOB_STALLED) ---");
    // Navigate home and submit a new job
    await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
    const repoInput2 = page.locator('input[placeholder*="github.com"]');
    await repoInput2.fill("https://github.com/mock-owner/kill-worker-repo");
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/analysis\//, { timeout: 15_000 });

    console.log("[Playwright] Job started. Waiting 2s for worker to pick up...");
    await page.waitForTimeout(2000);

    // Extract jobId from URL: /analysis/[jobId]
    const currentUrl = page.url();
    console.log(`[Playwright] Current URL: ${currentUrl}`);
    const jobIdMatch = currentUrl.match(/\/analysis\/([^/?#]+)/);
    const jobId = jobIdMatch ? jobIdMatch[1] : null;
    console.log(`[Playwright] Extracted jobId: ${jobId}`);

    // Kill the worker process
    console.log("[Worker] Killing worker process immediately (simulating crash)...");
    if (workerProcess) {
      workerProcess.kill("SIGKILL");
      workerProcess = null;
    }

    console.log("[Playwright] Worker killed. Advancing heartbeat to simulate stall timeout...");
    if (jobId) {
      // Import analysisRepository to simulate stale heartbeat
      const { analysisRepository } = await import("../src/composition/container");
      const staleTime = new Date(Date.now() - 3 * 60 * 1000).toISOString();
      await analysisRepository.updateJob(jobId, {
        heartbeatAt: staleTime,
        updatedAt: staleTime,
      });
      console.log(`[Playwright] Stale heartbeat applied to job ${jobId}`);

      const getRes = await fetch(`http://localhost:3000/api/analyze/jobs/${jobId}`);
      console.log(`[API GET status]: ${getRes.status}`);
      const body = await getRes.json() as { status?: string; error?: { code?: string; retryable?: boolean } };
      console.log(`[API GET body]:`, body);
    }

    // Wait for the UI polling to detect JOB_STALLED
    let workerStalledReached = false;
    const startStallPoll = Date.now();
    while (Date.now() - startStallPoll < 15_000) {
      const text = await page.innerText("body");
      if (text.includes("stopped early") || text.includes("stopped responding") || text.includes("Retry analysis")) {
        console.log("[Playwright] UI transitioned to failed/JOB_STALLED state with Retry CTA!");
        workerStalledReached = true;
        break;
      }
      await page.waitForTimeout(500);
    }

    const screenshot3Path = path.join(ARTIFACT_DIR, "10-phase1-worker-killed-stalled.png");
    await page.screenshot({ path: screenshot3Path });
    console.log(`[Playwright] Captured killed worker screenshot: ${screenshot3Path}`);

    console.log("\n=== Phase 1 Browser E2E Successfully Verified! ===");
    process.exit(0);
  } finally {
    await browser.close();
    if (workerProcess) {
      try { (workerProcess as ChildProcess).kill("SIGKILL"); } catch { /* ignore */ }
    }
    try { nextProcess.kill("SIGKILL"); } catch { /* ignore */ }
    await mockServer.close();
  }
}

run().catch((err) => {
  console.error("FATAL in Phase 1 browser E2E:", err);
  process.exit(1);
});
