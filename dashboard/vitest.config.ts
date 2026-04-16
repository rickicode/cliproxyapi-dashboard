import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    exclude: [
      "tests/e2e/**",
      "**/tests/e2e/**",
      "node_modules/**",
      "**/.worktrees/**",
      ".next/**",
      "playwright-report/**",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
