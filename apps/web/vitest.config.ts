import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["**/node_modules/**", "**/.next/**"],
    environment: "node",
    setupFiles: ["test/setup/fetch-guard.ts"],
    // next-auth imports "next/server" without an extension, which Node's ESM loader rejects. Inlining it
    // lets Vite resolve that import, so tests can use the real AuthError and CredentialsSignin classes.
    server: { deps: { inline: ["next-auth"] } },
    // No tests exist until later subtasks; an empty suite is not a failure.
    passWithNoTests: true,
  },
});
