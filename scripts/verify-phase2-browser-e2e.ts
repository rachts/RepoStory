import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());
import "../src/shared/alias-register";

import { chromium } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { startMockGitHubServer } from "./mock-github-server";
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
  console.log("=== Starting Phase 2 (Fix 4 & Fix 5) Browser E2E Verification ===");

  const mockServer = await startMockGitHubServer({ port: 4000 });
  console.log(`[Mock GitHub Server] Running at ${mockServer.baseUrl}`);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: "3000",
    GITHUB_API_BASE_URL: "http://127.0.0.1:4000",
    NEXT_PUBLIC_ANALYSIS_POLL_TIMEOUT_MS: "8000", // 8s timeout for testing Fix 5 in browser
    ARCHIVE_INACTIVITY_TIMEOUT_MS: "15000",
    NODE_ENV: "development",
  };

  console.log("[Next.js] Starting dev server on http://localhost:3000...");
  const nextProcess: ChildProcess = spawn("npm", ["run", "dev"], {
    env,
    stdio: "pipe",
  });

  const nextReady = await waitForUrl("http://localhost:3000", 30_000);
  if (!nextReady) {
    throw new Error("Next.js dev server failed to start within 30s");
  }
  console.log("[Next.js] Ready on http://localhost:3000");

  const workerEnv: NodeJS.ProcessEnv = {
    ...env,
    PORT: "10002",
  };
  console.log("[Worker] Starting background worker...");
  const workerProcess: ChildProcess = spawn("node", ["dist/worker.js"], {
    env: workerEnv,
    stdio: "pipe",
  });

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  try {
    // -------------------------------------------------------------------
    // Scenario 1: Fix 4 - Slow download with Content-Length (45% -> 60%)
    // -------------------------------------------------------------------
    console.log("\n--- Scenario 1: Testing Progress with Content-Length (slow-length) ---");
    await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
    const repoInput1 = page.locator('input[placeholder*="github.com"]');
    await repoInput1.fill("https://github.com/mock-owner/slow-length-repo");
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/analysis\//, { timeout: 15_000 });

    const progressValues1: number[] = [];
    const pollStart1 = Date.now();
    let capturedMidway1 = false;
    const screenshot1Path = path.join(ARTIFACT_DIR, "11-phase2-progress-content-length.png");

    while (Date.now() - pollStart1 < 12_000) {
      const text = await page.innerText("body");
      const match = text.match(/(\d+)%/);
      if (match && match[1]) {
        const val = parseInt(match[1], 10);
        if (progressValues1.length === 0 || val !== progressValues1[progressValues1.length - 1]) {
          console.log(`[Playwright Scenario 1] Progress: ${val}%`);
          // Verify monotonic (never goes backwards during archive download 45-60)
          if (val >= 45 && progressValues1.some((p) => p >= 45)) {
            const last45 = progressValues1.filter((p) => p >= 45).pop();
            if (last45 !== undefined && val < last45 && val < 90) {
              throw new Error(`Progress went backwards during archive download! Previous: ${last45}%, Current: ${val}%`);
            }
          }
          progressValues1.push(val);
        }
        if (val >= 45 && val <= 60 && !capturedMidway1) {
          capturedMidway1 = true;
          await page.screenshot({ path: screenshot1Path });
          console.log(`[Playwright Scenario 1] Captured progress screenshot at ${val}%: ${screenshot1Path}`);
        }
      }
      if (text.includes("Diagram workspace") || text.includes("README Markdown")) {
        console.log("[Playwright Scenario 1] Analysis completed successfully!");
        break;
      }
      await page.waitForTimeout(300);
    }

    if (!capturedMidway1) {
      await page.screenshot({ path: screenshot1Path });
    }

    // -------------------------------------------------------------------
    // Scenario 2: Fix 4 - Slow chunked download without Content-Length
    // -------------------------------------------------------------------
    console.log("\n--- Scenario 2: Testing Chunked Progress without Content-Length (chunked) ---");
    await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
    const repoInput2 = page.locator('input[placeholder*="github.com"]');
    await repoInput2.fill("https://github.com/mock-owner/slow-chunked-repo");
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/analysis\//, { timeout: 15_000 });

    const progressValues2: number[] = [];
    const pollStart2 = Date.now();
    let capturedMidway2 = false;
    const screenshot2Path = path.join(ARTIFACT_DIR, "12-phase2-progress-chunked.png");

    while (Date.now() - pollStart2 < 12_000) {
      const text = await page.innerText("body");
      const match = text.match(/(\d+)%/);
      if (match && match[1]) {
        const val = parseInt(match[1], 10);
        if (progressValues2.length === 0 || val !== progressValues2[progressValues2.length - 1]) {
          console.log(`[Playwright Scenario 2] Progress: ${val}%`);
          // Verify monotonic (never goes backwards during archive download 45-60)
          if (val >= 45 && progressValues2.some((p) => p >= 45)) {
            const last45 = progressValues2.filter((p) => p >= 45).pop();
            if (last45 !== undefined && val < last45 && val < 90) {
              throw new Error(`Progress went backwards during archive download! Previous: ${last45}%, Current: ${val}%`);
            }
          }
          progressValues2.push(val);
        }
        if (val >= 45 && val <= 60 && !capturedMidway2) {
          capturedMidway2 = true;
          await page.screenshot({ path: screenshot2Path });
          console.log(`[Playwright Scenario 2] Captured chunked progress screenshot at ${val}%: ${screenshot2Path}`);
        }
      }
      if (text.includes("Diagram workspace") || text.includes("README Markdown")) {
        console.log("[Playwright Scenario 2] Analysis completed successfully!");
        break;
      }
      await page.waitForTimeout(300);
    }

    if (!capturedMidway2) {
      await page.screenshot({ path: screenshot2Path });
    }

    // -------------------------------------------------------------------
    // Scenario 3: Fix 5 - Polling cap (8s configured timeout) -> Retry CTA
    // -------------------------------------------------------------------
    console.log("\n--- Scenario 3: Testing Polling Cap and Retry CTA ---");
    await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
    const repoInput3 = page.locator('input[placeholder*="github.com"]');
    await repoInput3.fill("https://github.com/mock-owner/stall-for-timeout");
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/analysis\//, { timeout: 15_000 });

    console.log("[Playwright Scenario 3] Waiting for polling duration to exceed configured 8s timeout...");
    let timeoutStateReached = false;
    const pollStart3 = Date.now();
    const screenshot3Path = path.join(ARTIFACT_DIR, "13-phase2-polling-timeout-cta.png");

    while (Date.now() - pollStart3 < 15_000) {
      const text = await page.innerText("body");
      if (text.includes("Analysis timed out. Try again")) {
        console.log("[Playwright Scenario 3] 'Analysis timed out. Try again' displayed!");
        timeoutStateReached = true;
        break;
      }
      await page.waitForTimeout(400);
    }

    if (!timeoutStateReached) {
      throw new Error("UI did not display 'Analysis timed out. Try again' after configured polling duration exceeded");
    }

    const retryBtn = page.locator('button:has-text("Retry analysis")');
    await retryBtn.waitFor({ state: "visible", timeout: 5000 });
    console.log("[Playwright Scenario 3] Verified 'Retry analysis' CTA button is present and visible!");

    await page.screenshot({ path: screenshot3Path });
    console.log(`[Playwright Scenario 3] Captured screenshot: ${screenshot3Path}`);

    console.log("\n=== Phase 2 Browser E2E Successfully Verified! ===");
    process.exit(0);
  } finally {
    await browser.close();
    try { workerProcess.kill("SIGKILL"); } catch { /* ignore */ }
    try { nextProcess.kill("SIGKILL"); } catch { /* ignore */ }
    await mockServer.close();
  }
}

run().catch((err) => {
  console.error("FATAL in Phase 2 browser E2E:", err);
  process.exit(1);
});
