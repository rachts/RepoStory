import { chromium } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

async function main() {
  const screenshotDir = path.resolve(process.cwd(), "test-results/ui-e2e");
  const artifactDir = "/Users/macbookair/.gemini/antigravity/brain/e1b02ff2-7557-4d0d-9bab-7f2af8e4ed09";
  fs.mkdirSync(screenshotDir, { recursive: true });

  console.log("[E2E] Launching Chromium browser (1440x900)...");
  const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const launchOptions: { headless: boolean; executablePath?: string } = { headless: true };
  if (fs.existsSync(CHROME_PATH)) {
    launchOptions.executablePath = CHROME_PATH;
  }
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(`[Console Error] ${msg.text()}`);
      console.error(`[Console Error] ${msg.text()}`);
    }
  });

  page.on("pageerror", (err) => {
    consoleErrors.push(`[Page Error] ${err.message}`);
    console.error(`[Page Error] ${err.message}`);
  });

  page.on("requestfailed", (req) => {
    networkErrors.push(`[Network Failed] ${req.method()} ${req.url()}: ${req.failure()?.errorText}`);
  });

  const saveScreenshot = async (name: string, locator?: string) => {
    const localPath = path.join(screenshotDir, name);
    const artifactPath = path.join(artifactDir, name);
    if (locator) {
      const el = await page.$(locator);
      if (el) {
        await el.screenshot({ path: localPath });
      } else {
        await page.screenshot({ path: localPath });
      }
    } else {
      await page.screenshot({ path: localPath });
    }
    fs.copyFileSync(localPath, artifactPath);
    console.log(`[E2E] Screenshot saved: ${name}`);
  };

  console.log("[E2E] Phase 1: Navigating to landing page (http://localhost:3000)...");
  await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
  await saveScreenshot("01-landing.png");

  const inputSelector = "#repository-url";
  await page.waitForSelector(inputSelector);
  await page.fill(inputSelector, "https://github.com/rachts/WEATHERGPT");
  console.log("[E2E] Typed URL: https://github.com/rachts/WEATHERGPT");

  console.log("[E2E] Phase 2: Submitting analysis job...");
  await page.click('button[type="submit"]');

  await page.waitForURL(/\/analysis\/.+/, { timeout: 15000 });
  console.log("[E2E] Navigated to analysis URL:", page.url());

  let screenshot0Taken = false;
  let screenshotIntermediateTaken = false;
  let screenshotFinalTaken = false;

  const startTime = Date.now();
  const maxWaitMs = 120000;

  while (Date.now() - startTime < maxWaitMs) {
    await page.waitForTimeout(1000);

    const bodyText = await page.innerText("body");
    const progressEl = await page.$('[role="progressbar"], .progress-bar, .progress-state');
    const progressText = progressEl ? await progressEl.innerText() : "";

    const hasError = bodyText.includes("We couldn’t read this story") || bodyText.includes("The repository could not be analyzed");
    if (hasError) {
      console.error("[E2E] Error detected in UI DOM:", bodyText.slice(0, 300));
      await saveScreenshot("error-stuck.png");
      throw new Error("Analysis failed in UI DOM");
    }

    const isResultsView = bodyText.includes("Diagram workspace") || bodyText.toLowerCase().includes("story maps");

    if (progressText) {
      const cleanProgress = progressText.replace(/\s+/g, " ").trim().slice(0, 80);
      console.log(`[+${Math.round((Date.now() - startTime) / 1000)}s] Progress: ${cleanProgress}`);

      if (!screenshot0Taken && (progressText.includes("0%") || progressText.includes("10%") || progressText.includes("12%") || progressText.includes("validating-input") || progressText.includes("Analysis queued"))) {
        await saveScreenshot("02-progress-initial.png");
        screenshot0Taken = true;
      }

      if (!screenshotIntermediateTaken && (progressText.includes("25%") || progressText.includes("45%") || progressText.includes("fetch-archive") || progressText.includes("file tree") || progressText.includes("Downloading"))) {
        await saveScreenshot("03-progress-intermediate.png");
        screenshotIntermediateTaken = true;
      }
    }

    if (isResultsView) {
      console.log("[E2E] Phase 3: Results view detected! Verifying diagrams and interactive workspace...");

      if (bodyText.includes("No visual map is available")) {
        await saveScreenshot("error-no-visual-map.png");
        throw new Error("UI displayed 'No visual map is available' fallback!");
      }

      // Wait for ReactFlow to render
      await page.waitForSelector(".react-flow", { timeout: 10000 });
      await page.waitForSelector(".react-flow__node", { timeout: 10000 });

      const nodeCount = await page.locator(".react-flow__node").count();
      const edgeCount = await page.locator(".react-flow__edge").count();
      console.log(`[E2E] ReactFlow canvas rendered successfully with ${nodeCount} nodes and ${edgeCount} edges!`);

      // Settle layout
      await page.waitForTimeout(1000);

      // 1. Overall results view
      await saveScreenshot("04-results-overview.png");

      // 2. Focused view on System Overview diagram canvas
      await saveScreenshot("05-diagram-system-overview.png", ".flow-wrap");

      // 3. Tab switching: Click diagram 2 (API request flow)
      const diagramTabs = page.locator(".diagram-list .diagram-item");
      const tabCount = await diagramTabs.count();
      console.log(`[E2E] Discovered ${tabCount} story map diagram tabs.`);

      if (tabCount >= 2) {
        console.log("[E2E] Switching to Story Map 2 (API request flow)...");
        await diagramTabs.nth(1).click();
        await page.waitForTimeout(1000);
        const d2Nodes = await page.locator(".react-flow__node").count();
        const d2Edges = await page.locator(".react-flow__edge").count();
        console.log(`[E2E] Story Map 2 rendered with ${d2Nodes} nodes and ${d2Edges} edges.`);
        await saveScreenshot("06-diagram-api-request-flow.png", ".flow-wrap");
      }

      if (tabCount >= 3) {
        console.log("[E2E] Switching to Story Map 3 (Repository structure)...");
        await diagramTabs.nth(2).click();
        await page.waitForTimeout(1000);
        const d3Nodes = await page.locator(".react-flow__node").count();
        const d3Edges = await page.locator(".react-flow__edge").count();
        console.log(`[E2E] Story Map 3 rendered with ${d3Nodes} nodes and ${d3Edges} edges.`);
        await saveScreenshot("07-diagram-repository-structure.png", ".flow-wrap");
      }

      screenshotFinalTaken = true;
      console.log("[E2E] SUCCESS: Complete end-to-end browser user simulation passed!");
      break;
    }
  }

  if (!screenshotFinalTaken) {
    await saveScreenshot("timeout-state.png");
    throw new Error("E2E timed out waiting for results view");
  }

  await browser.close();
  console.log("[E2E] Chromium browser closed.");
}

main().catch((err) => {
  console.error("[E2E] Fatal test error:", err);
  process.exit(1);
});
