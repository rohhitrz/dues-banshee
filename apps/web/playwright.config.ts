import { defineConfig, devices } from "@playwright/test";

// Run on demand with `pnpm --filter web e2e`. Needs a demo-seeded database and the env from
// `.env.local` (DATABASE_URL, AUTH_SECRET). Not part of `pnpm test`.
export default defineConfig({
  testDir: "e2e",
  use: { baseURL: "http://localhost:3000" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm build && pnpm start",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    // `next build` runs before the server starts, so allow for it.
    timeout: 300_000,
  },
});
