// Node types are needed for node:fs and fileURLToPath.
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxyHandler, type ProxyRequest } from "../proxy";

// Feature: dashboard-ui, Req 1.1, 1.4, 1.6, 12.5, 12.11: the proxy clears stale sessions without a redirect loop.

const SIGNED_IN = { supplierId: "11111111-1111-4111-8111-111111111111" };
const EPOCH = "Thu, 01 Jan 1970 00:00:00 GMT";

/** Builds the part of the Auth.js-wrapped request the handler reads. */
function fakeRequest(url: string, cookie: string | null, auth: ProxyRequest["auth"]): ProxyRequest {
  const request = new NextRequest(url, cookie === null ? {} : { headers: { cookie } });
  return { nextUrl: request.nextUrl, headers: request.headers, auth };
}

describe("proxy: /signin?error=SessionExpired", () => {
  const cookie = [
    "authjs.session-token=stale",
    "__Secure-authjs.session-token=stale",
    "authjs.session-token.0=chunk0",
    "authjs.session-token.1=chunk1",
    "__Secure-authjs.session-token.2=chunk2",
    "authjs.csrf-token=keep",
  ].join("; ");

  it("passes through with no Location and expires every session cookie", () => {
    const res = proxyHandler(fakeRequest("http://localhost:3000/signin?error=SessionExpired", cookie, null));

    expect(res).toBeDefined();
    expect(res?.status).toBe(200);
    expect(res?.headers.get("location")).toBeNull();
    expect(res?.headers.get("x-middleware-next")).toBe("1");
    expect(res?.headers.getSetCookie()).toEqual([
      `authjs.session-token=; Path=/; Expires=${EPOCH}; Max-Age=0; HttpOnly; SameSite=lax`,
      `__Secure-authjs.session-token=; Path=/; Expires=${EPOCH}; Max-Age=0; Secure; HttpOnly; SameSite=lax`,
      `authjs.session-token.0=; Path=/; Expires=${EPOCH}; Max-Age=0; HttpOnly; SameSite=lax`,
      `authjs.session-token.1=; Path=/; Expires=${EPOCH}; Max-Age=0; HttpOnly; SameSite=lax`,
      `__Secure-authjs.session-token.2=; Path=/; Expires=${EPOCH}; Max-Age=0; Secure; HttpOnly; SameSite=lax`,
    ]);
  });

  it("removes the session cookies from the forwarded request and keeps the others", () => {
    const res = proxyHandler(fakeRequest("http://localhost:3000/signin?error=SessionExpired", cookie, null));

    expect(res?.headers.get("x-middleware-request-cookie")).toBe("authjs.csrf-token=keep");
  });

  it("sets no cookies when none are stale", () => {
    const res = proxyHandler(fakeRequest("http://localhost:3000/signin?error=SessionExpired", null, null));

    expect(res?.headers.get("location")).toBeNull();
    expect(res?.headers.getSetCookie()).toEqual([]);
  });
});

describe("proxy: /signin never redirects", () => {
  it("passes /signin with a stale session (no loop)", () => {
    const res = proxyHandler(fakeRequest("http://localhost:3000/signin", "authjs.session-token=stale", null));

    expect(res).toBeUndefined();
  });

  it("passes /signin with no session", () => {
    expect(proxyHandler(fakeRequest("http://localhost:3000/signin", null, null))).toBeUndefined();
  });

  it("passes /signin with another error value and does not clear cookies", () => {
    const res = proxyHandler(fakeRequest("http://localhost:3000/signin?error=CredentialsSignin", "authjs.session-token=stale", null));

    expect(res).toBeUndefined();
  });
});

describe("proxy: protected pages", () => {
  it("redirects / to /signin when signed out", () => {
    const res = proxyHandler(fakeRequest("http://localhost:3000/", null, null));

    expect(res?.status).toBe(307);
    expect(res?.headers.get("location")).toBe("http://localhost:3000/signin");
  });

  it("redirects / to /signin when the session has no supplierId", () => {
    const res = proxyHandler(fakeRequest("http://localhost:3000/", null, {}));

    expect(res?.status).toBe(307);
    expect(res?.headers.get("location")).toBe("http://localhost:3000/signin");
  });

  it("passes / when signed in", () => {
    expect(proxyHandler(fakeRequest("http://localhost:3000/", null, SIGNED_IN))).toBeUndefined();
  });
});

describe("proxy: /api/import", () => {
  it("answers 401 JSON when signed out", async () => {
    const res = proxyHandler(fakeRequest("http://localhost:3000/api/import/x", null, null));

    expect(res?.status).toBe(401);
    expect(res?.headers.get("location")).toBeNull();
    expect(await res?.json()).toEqual({ error: "Unauthorized" });
  });

  it("passes when signed in", () => {
    expect(proxyHandler(fakeRequest("http://localhost:3000/api/import/x", null, SIGNED_IN))).toBeUndefined();
  });
});

describe("proxy: module shape", () => {
  const source = readFileSync(fileURLToPath(new URL("../proxy.ts", import.meta.url)), "utf8");

  it("imports exactly next-auth, next/server and ./auth.config", () => {
    const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
    const bare = [...source.matchAll(/^import\s+"([^"]+)";/gm)].map((m) => m[1]);

    expect([...specifiers, ...bare]).toEqual(["next-auth", "next/server", "./auth.config"]);
  });

  it("matches the six guarded routes", () => {
    expect(config.matcher).toEqual(["/", "/signin", "/import/:path*", "/graveyard/:path*", "/debtor/:path*", "/api/import/:path*"]);
  });
});
