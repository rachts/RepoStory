import { expect, test } from "@playwright/test";

test("landing page exposes the RepoStory foundation", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Turn any GitHub repository into a story",
  );
});
