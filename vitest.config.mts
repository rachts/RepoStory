import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "jsdom",
    setupFiles: [path.resolve(import.meta.dirname, "tests/setup.ts")],
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
