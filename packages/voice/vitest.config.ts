import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "node",
    setupFiles: ["test/setup/fetch-guard.ts"],
    // Tests arrive in later subtasks; an empty suite must not fail the package gate.
    passWithNoTests: true,
  },
});
