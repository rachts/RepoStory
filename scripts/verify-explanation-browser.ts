import { chromium } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

async function main() {
  const artifactDir = "/Users/macbookair/.gemini/antigravity/brain/e1b02ff2-7557-4d0d-9bab-7f2af8e4ed09";
  const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const launchOptions: { headless: boolean; executablePath?: string } = { headless: true };
  if (fs.existsSync(CHROME_PATH)) {
    launchOptions.executablePath = CHROME_PATH;
  }

  console.log("[E2E] Launching browser to verify AI explanation...");
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // Use the session from the user's screenshot
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

  // Check if "Try again" or "Explain this project" is visible
  const tryAgainBtn = page.locator('button:has-text("Try again")');
  const explainBtn = page.locator('button:has-text("Explain this project")');

  if (await tryAgainBtn.isVisible()) {
    console.log("[E2E] 'Try again' button detected. Clicking it...");
    await tryAgainBtn.click();
    await page.waitForTimeout(3000);
  } else if (await explainBtn.isVisible()) {
    console.log("[E2E] 'Explain this project' button detected. Clicking it...");
    await explainBtn.click();
    await page.waitForTimeout(3000);
  }

  // Wait for explanation content to appear
  console.log("[E2E] Waiting for 'Evidence-backed explanation' or explanation summary...");
  await page.waitForSelector(".project-explanation-content, .project-explanation-ready", { timeout: 30000 });

  const bodyText = await page.innerText(".project-explanation-panel");
  console.log("[E2E] Panel text snippet:", bodyText.slice(0, 200).replace(/\s+/g, " "));

  const screenshotPath = path.join(artifactDir, "18-ai-explanation-rendered.png");
  await page.screenshot({ path: screenshotPath });
  console.log(`[E2E] Screenshot saved to ${screenshotPath}`);

  await browser.close();
  console.log("[E2E] AI explanation verified successfully!");
}

main().catch((err) => {
  console.error("[E2E] Fatal error:", err);
  process.exit(1);
});
