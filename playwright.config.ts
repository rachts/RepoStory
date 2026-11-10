import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: !process.env.CI,
    env: {
      REPO_STORY_JOB_STORE: "memory",
      REPO_STORY_QUEUE_MODE: "memory",
      ALLOW_IN_MEMORY_QUEUE: "true",
      ANONYMOUS_ANALYSIS_ENABLED: "true",
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
