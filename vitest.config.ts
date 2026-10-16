import path from "node:path";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "jsdom",
    setupFiles: [path.resolve(__dirname, "tests/setup.ts")],
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
