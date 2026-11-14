import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The workspace packages export TypeScript source, so Next must compile them.
  transpilePackages: [
    "@dues-banshee/engine",
    "@dues-banshee/ledger",
    "@dues-banshee/db",
    "@dues-banshee/agent",
  ],
};

export default nextConfig;
