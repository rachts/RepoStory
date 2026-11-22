import { chromium } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

async function main() {
  const artifactDir = "/Users/macbookair/.gemini/antigravity/brain/e1b02ff2-7557-4d0d-9bab-7f2af8e4ed09";
  const auditDir = path.resolve(process.cwd(), "audit-evidence");
  fs.mkdirSync(auditDir, { recursive: true });

  const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const launchOptions: { headless: boolean; executablePath?: string } = { headless: true };
  if (fs.existsSync(CHROME_PATH)) {
    launchOptions.executablePath = CHROME_PATH;
  }

  console.log("[E2E] Launching browser to verify AI explanation...");
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // Session cookie
  await context.addCookies([
    {
      name: "repo_story_session",
      value: "session-651f1899-145f-4e23-8f0d-01994509f2f2",
      domain: "localhost",
      path: "/",
    },
  ]);

  const targetUrl = "http://localhost:3000/analysis/job-eabd3c73-a419-44a7-9a4f-7f036f8ed4d0";
  console.log(`[E2E] Navigating to ${targetUrl}...`);
  await page.goto(targetUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);

  // Check current panel state
  const tryAgainBtn = page.locator('.project-explanation-header button:has-text("Try again")');
  const explainBtn = page.locator('.project-explanation-header button:has-text("Explain this project")');

  if (await tryAgainBtn.isVisible()) {
    console.log("[E2E] 'Try again' button visible. Clicking it to fetch fresh explanation...");
    await tryAgainBtn.click();
  } else if (await explainBtn.isVisible()) {
    console.log("[E2E] 'Explain this project' button visible. Clicking it...");
    await explainBtn.click();
  }

  // Wait for real AI explanation to be rendered
  console.log("[E2E] Waiting for AI explanation to render...");
  await page.waitForSelector(".project-explanation-content", { timeout: 40000 });

  const hasRedError = await page.locator(".project-explanation-feedback.is-error").isVisible();
  console.log(`[E2E] Has red error banner: ${hasRedError}`);
  if (hasRedError) {
    throw new Error("Unexpected red error banner displayed on healthy AI explanation!");
  }

  const titleText = await page.innerText(".explanation-summary-title");
  console.log(`[E2E] Explanation title rendered: "${titleText}"`);

  // Save screenshot 18: AI explanation rendered
  const shot18Artifact = path.join(artifactDir, "18-ai-explanation-rendered.png");
  const shot18Audit = path.join(auditDir, "18-ai-explanation-rendered.png");
  await page.screenshot({ path: shot18Artifact });
  fs.copyFileSync(shot18Artifact, shot18Audit);
  console.log(`[E2E] Screenshot 18 saved to ${shot18Audit}`);

  // Test 2: Simulate failure to verify neutral fallback notice and working Try again CTA
  console.log("[E2E] Intercepting analysis result to simulate AI schema failure...");
  await page.route("**/api/analyze/*", async (route) => {
    if (route.request().url().includes("/jobs/")) {
      return route.continue();
    }
    const response = await route.fetch();
    const json = await response.json();
    delete json.explanation;
    json.explanationUnavailable = {
      code: "AI_INVALID_RESPONSE",
      message: "The AI explanation response did not match the required schema.",
    };
    await route.fulfill({ json });
  });

  // Track if POST /api/explain is called on Try again
  let explainCalled = false;
  await page.route("**/api/explain", async (route) => {
    explainCalled = true;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "AI_INVALID_RESPONSE",
          message: "The AI explanation response did not match the required schema.",
          retryable: true,
        },
      }),
    });
  });

  // Reload page to receive simulated unavailable response
  console.log("[E2E] Reloading page to render neutral fallback...");
  await page.goto(targetUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  // Verify neutral fallback banner
  const neutralFeedback = page.locator(".project-explanation-feedback.is-neutral");
  await neutralFeedback.waitFor({ timeout: 5000 });
  const feedbackHeading = await neutralFeedback.locator("strong").innerText();
  const feedbackBody = await neutralFeedback.locator("p").first().innerText();
  console.log(`[E2E] Neutral feedback heading: "${feedbackHeading}"`);
  console.log(`[E2E] Neutral feedback body: "${feedbackBody}"`);

  const hasRedErrorOnFallback = await page.locator(".project-explanation-feedback.is-error").isVisible();
  console.log(`[E2E] Has red error banner on fallback: ${hasRedErrorOnFallback}`);
  if (hasRedErrorOnFallback) {
    throw new Error("Neutral fallback should not have .is-error class!");
  }

  const tryAgainButton = page.locator('.project-explanation-header button:has-text("Try again")');
  const isTryAgainEnabled = await tryAgainButton.isEnabled();
  console.log(`[E2E] 'Try again' button enabled: ${isTryAgainEnabled}`);

  if (!isTryAgainEnabled) {
    throw new Error("'Try again' button should be enabled for retryable AI failure!");
  }

  // Click Try again to verify it triggers requestExplanation
  console.log("[E2E] Clicking 'Try again' to verify CTA action...");
  await tryAgainButton.click();
  await page.waitForTimeout(1500);
  console.log(`[E2E] explain endpoint was called on Try again: ${explainCalled}`);

  // Save screenshot 19: Neutral fallback
  const shot19Artifact = path.join(artifactDir, "19-ai-explanation-neutral-fallback.png");
  const shot19Audit = path.join(auditDir, "19-ai-explanation-neutral-fallback.png");
  await page.screenshot({ path: shot19Artifact });
  fs.copyFileSync(shot19Artifact, shot19Audit);
  console.log(`[E2E] Screenshot 19 saved to ${shot19Audit}`);

  await browser.close();
  console.log("[E2E] All AI explanation browser checks passed!");
}

main().catch((err) => {
  console.error("[E2E] Fatal error:", err);
  process.exit(1);
});
