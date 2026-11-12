import NextAuth from "next-auth";
import { authConfig } from "./auth.config";

// Builds its own `auth` from the shared config. Never import `./auth` here: it pulls the
// Credentials provider and the database into the proxy bundle (enforced by ESLint).
const { auth } = NextAuth(authConfig);

export const proxy = auth((req) => {
  if (req.auth?.supplierId) return;
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return Response.redirect(new URL("/signin", req.nextUrl));
});

export const config = {
  matcher: ["/import/:path*", "/graveyard/:path*", "/debtor/:path*", "/api/import/:path*"],
};
