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
  console.log("=== Starting Phase 5 Fix 14 Browser Verification: Diagram Availability & Structure Fallback ===");

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

    const testAnalysisId = "analysis-fix14-fallback-sim";
    const testPayload = {
      id: testAnalysisId,
      repository: {
        id: "repo-fix14",
        owner: "sample-org",
        name: "micro-lib",
        url: "https://github.com/sample-org/micro-lib",
        defaultBranch: "main",
        selectedBranch: "main",
        sizeBytes: 1500,
        fileCount: 4,
      },
      status: "completed",
      stage: "completed",
      progressPercent: 100,
      filesDiscovered: 4,
      filesAnalyzed: 4,
      technologies: [],
      findings: [
        {
          id: "finding-lib",
          kind: "technology",
          category: "application",
          confidence: "high",
          technicalLabel: "TypeScript Library",
          plainEnglishLabel: "TypeScript Library",
          explanation: "Shared utility library",
          evidence: [
            {
              id: "ev-src-index",
              filePath: "src/index.ts",
              reason: "Main export file",
            },
            {
              id: "ev-lib-utils",
              filePath: "lib/utils.ts",
              reason: "Helper functions",
            },
          ],
        },
      ],
      diagrams: [],
      diagramAvailability: [
        { type: "system-overview", available: false, reason: "Insufficient multi-tier technology evidence." },
        { type: "api-request-flow", available: false, reason: "No HTTP or API endpoints detected in library." },
        { type: "authentication-flow", available: false, reason: "No session or authentication logic." },
        { type: "repository-structure", available: false, reason: "Default structure diagram omitted." },
      ],
      diagramIds: [],
      createdAt: new Date().toISOString(),
    };

    // Route both jobs endpoint and analyze result endpoint
    await page.route(`**/api/analyze/jobs/${testAnalysisId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(testPayload),
      });
    });

    await page.route(`**/api/analyze/${testAnalysisId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(testPayload),
      });
    });

    console.log(`[Playwright] Navigating to http://localhost:3000/analysis/${testAnalysisId}...`);
    await page.goto(`http://localhost:3000/analysis/${testAnalysisId}`, { waitUntil: "domcontentloaded" });

    // 1. Verify diagramAvailability reasons in empty state
    console.log("[Playwright] Checking for diagram availability reasons in empty state...");
    await page.waitForSelector(".availability-list", { timeout: 15_000 });
    const emptyStateText = await page.textContent(".availability-list");
    console.log(`[Playwright] Availability list text:\n${emptyStateText}`);

    if (!emptyStateText?.includes("No HTTP or API endpoints detected in library")) {
      throw new Error("Expected API request flow availability reason not found!");
    }

    // 2. Verify and click 'Show repository structure fallback' button
    console.log("[Playwright] Clicking 'Show repository structure fallback' CTA...");
    const fallbackButton = page.locator('[data-testid="load-structure-fallback"]');
    await fallbackButton.waitFor({ state: "visible", timeout: 5_000 });
    await fallbackButton.click();

    // 3. Verify transition to diagram workspace with structure fallback diagram
    console.log("[Playwright] Verifying diagram workspace rendered with structure fallback...");
    await page.waitForSelector(".diagram-toolbar", { timeout: 10_000 });
    await page.waitForSelector('.flow-wrap, [data-diagram-type="repository-structure"]', { timeout: 10_000 });

    const titleText = await page.textContent(".results-title h2");
    console.log(`[Playwright] Diagram title: "${titleText}"`);
    if (!titleText?.includes("Repository structure (fallback)")) {
      throw new Error(`Expected title 'Repository structure (fallback)', got: "${titleText}"`);
    }

    // 4. Capture screenshot
    const screenshotPath = path.join(ARTIFACT_DIR, "17-phase5-diagram-fallback.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[Playwright] Captured screenshot: ${screenshotPath}`);

    console.log("=== Phase 5 Fix 14 Browser Verification Succeeded! ===");
  } finally {
    if (browser) await browser.close();
    nextProcess.kill("SIGTERM");
  }
}

run().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
