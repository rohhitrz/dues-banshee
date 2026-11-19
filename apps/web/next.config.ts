import path from "node:path";
import type { NextConfig } from "next";
const fonts = "../../packages/agent/assets/fonts/**";
const nextConfig: NextConfig = {
  // The workspace packages export TypeScript source, so Next must compile them.
  transpilePackages: [
    "@dues-banshee/engine",
    "@dues-banshee/ledger",
    "@dues-banshee/db",
    "@dues-banshee/agent",
    "@dues-banshee/voice",
  ],
  // Trace from the repo root so files in `packages/` are reachable, and ship the PDF fonts the agent reads
  // at run time (they are not imported, so the tracer cannot find them).
  outputFileTracingRoot: path.join(__dirname, "../../"),
  outputFileTracingIncludes: {
    "/approvals": [fonts],
    "/api/ladder/run": [fonts],
  },
  async headers() {
    return [
      {
        // The call link carries the Join_Token: never send it on as a Referer.
        source: "/call/:path*",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },
};
export default nextConfig;
