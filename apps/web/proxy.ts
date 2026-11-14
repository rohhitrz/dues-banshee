import NextAuth from "next-auth";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { authConfig } from "./auth.config";

// Builds its own `auth` from the shared config. Never import `./auth` here: it pulls the
// Credentials provider and the database into the proxy bundle (enforced by ESLint).
const { auth } = NextAuth(authConfig);

/** Auth.js session cookie, plain or `__Secure-` prefixed, with the `.0`, `.1`... suffix of a chunked token. */
const SESSION_COOKIE = /^(?:__Secure-)?authjs\.session-token(?:\.\d+)?$/;

/** The parts of the Auth.js-wrapped request the handler reads, so tests can pass a fake. */
export type ProxyRequest = Pick<NextRequest, "nextUrl" | "headers"> & {
  auth: { supplierId?: string | undefined } | null;
};

/** Splits a `Cookie` request header into `name=value` pairs, keeping each pair's raw text. */
function parseCookieHeader(header: string | null): { name: string; pair: string }[] {
  if (!header) return [];
  return header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((pair) => ({ name: pair.split("=", 1)[0] ?? "", pair }));
}

/**
 * Passes the request on with every Auth.js session cookie removed from the request headers (so the
 * page sees a signed-out request) and expired on the response (so the browser drops them).
 * Server Components cannot write cookies, which is why this happens here.
 */
function clearSessionCookies(req: Pick<NextRequest, "headers">): NextResponse {
  const cookies = parseCookieHeader(req.headers.get("cookie"));
  const stale = cookies.filter(({ name }) => SESSION_COOKIE.test(name));

  const headers = new Headers(req.headers);
  const kept = cookies.filter(({ name }) => !SESSION_COOKIE.test(name)).map(({ pair }) => pair);
  if (kept.length > 0) headers.set("cookie", kept.join("; "));
  else headers.delete("cookie");

  const res = NextResponse.next({ request: { headers } });
  for (const { name } of stale) {
    res.cookies.set(name, "", {
      path: "/",
      expires: new Date(0),
      maxAge: 0,
      httpOnly: true,
      sameSite: "lax",
      secure: name.startsWith("__Secure-"),
    });
  }
  return res;
}

/**
 * The handler Auth.js wraps. `/signin` never redirects, so a stale or missing session cannot loop.
 * The SessionExpired cookie clearing is NOT here: see `proxy` below.
 */
export function proxyHandler(req: ProxyRequest): Response | undefined {
  const { pathname } = req.nextUrl;

  if (pathname === "/signin") return undefined;

  if (req.auth?.supplierId) return undefined;

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/signin", req.nextUrl));
}

const authProxy = auth(proxyHandler);

/**
 * The exported proxy. `/signin?error=SessionExpired` is answered here, before the Auth.js wrapper,
 * because the wrapper appends its own session `Set-Cookie` after the handler's response, and
 * @auth/core re-encodes a JWT that is still valid. Clearing inside the wrapped handler would send an
 * expiring cookie followed by a fresh one, and the browser would keep the session. Every other
 * request goes to the wrapped handler unchanged.
 */
export function proxy(req: NextRequest, event: NextFetchEvent): ReturnType<typeof authProxy> | NextResponse {
  const { pathname, searchParams } = req.nextUrl;
  if (pathname === "/signin" && searchParams.get("error") === "SessionExpired") {
    return clearSessionCookies(req);
  }
  // Auth.js types the wrapper as a route handler (second argument `{ params }`), but it is mounted
  // as a proxy and called with the fetch event; it passes the second argument straight through.
  return authProxy(req, event as unknown as Parameters<typeof authProxy>[1]);
}

export const config = {
  // `:path*` also matches the bare prefix (`/approvals`). `/api/ladder/run` is deliberately absent:
  // it authenticates with its own bearer secret, not a session.
  matcher: [
    "/",
    "/signin",
    "/import/:path*",
    "/approvals/:path*",
    "/graveyard/:path*",
    "/debtor/:path*",
    "/debtors/:path*",
    "/api/import/:path*",
    "/api/drafts/:path*",
  ],
};
