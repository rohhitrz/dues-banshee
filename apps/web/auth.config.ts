import type { NextAuthConfig } from "next-auth";

/**
 * Auth configuration shared by `auth.ts` and `proxy.ts`.
 * It must not import the database: the proxy bundles this file and only decodes the JWT cookie.
 */
export const authConfig = {
  session: { strategy: "jwt" },
  pages: { signIn: "/signin" },
  providers: [], // added in auth.ts
  callbacks: {
    jwt({ token, user }) {
      if (user?.supplierId) token.supplierId = user.supplierId;
      return token;
    },
    session({ session, token }) {
      // JWT is an open record in Auth.js, so narrow the value instead of trusting its type.
      session.supplierId = typeof token.supplierId === "string" ? token.supplierId : undefined;
      return session;
    },
  },
} satisfies NextAuthConfig;
