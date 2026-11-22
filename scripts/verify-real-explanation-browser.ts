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

  console.log("[E2E] Launching browser to verify real AI explanation on WEATHERGPT...");
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

  // Check if explanation button or try again is visible
  const tryAgainBtn = page.locator('.project-explanation-header button:has-text("Try again")');
  const explainBtn = page.locator('.project-explanation-header button:has-text("Explain this project")');

  if (await tryAgainBtn.isVisible()) {
    console.log("[E2E] 'Try again' visible, clicking it...");
    await tryAgainBtn.click();
    await page.waitForTimeout(3000);
  } else if (await explainBtn.isVisible()) {
    console.log("[E2E] 'Explain this project' visible, clicking it...");
    await explainBtn.click();
    await page.waitForTimeout(3000);
  }

  // Wait for explanation content to render
  console.log("[E2E] Waiting for .project-explanation-content...");
  await page.waitForSelector(".project-explanation-content", { timeout: 35000 });

  // Assert NO error banner is visible
  const hasError = await page.locator(".project-explanation-feedback").isVisible();
  console.log(`[E2E] Has feedback error banner: ${hasError}`);
  if (hasError) {
    const errorText = await page.innerText(".project-explanation-feedback");
    throw new Error(`Unexpected error feedback displayed: ${errorText}`);
  }

  const title = await page.innerText(".explanation-summary-title");
  console.log(`[E2E] Verified explanation title: "${title}"`);

  const summary = await page.innerText(".project-explanation-summary");
  console.log(`[E2E] Summary snippet: ${summary.slice(0, 150).replace(/\s+/g, " ")}`);

  // Save screenshot
  const screenshotPath = path.join(auditDir, "20-weathergpt-ai-explanation-rendered.png");
  const artifactPath = path.join(artifactDir, "20-weathergpt-ai-explanation-rendered.png");
  await page.screenshot({ path: screenshotPath });
  fs.copyFileSync(screenshotPath, artifactPath);
  console.log(`[E2E] Screenshot saved to ${screenshotPath}`);

  await browser.close();
  console.log("[E2E] Real AI explanation verified successfully in browser!");
}

main().catch((err) => {
  console.error("[E2E] Verification failed:", err);
  process.exit(1);
});
