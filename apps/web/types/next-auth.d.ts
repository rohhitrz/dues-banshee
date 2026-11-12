import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session extends DefaultSession {
    supplierId?: string | undefined;
  }
  interface User {
    supplierId?: string | undefined;
  }
}

// The JWT type lives in @auth/core/jwt, which next-auth/jwt only re-exports. TypeScript can't
// augment a re-export, and @auth/core isn't a direct dependency, so the token's `supplierId` is
// narrowed where it is read (auth.config.ts) instead of being declared here.
