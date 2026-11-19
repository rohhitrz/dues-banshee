// Node types are needed for node:fs and fileURLToPath.
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encode } from "next-auth/jwt";
import { NextRequest, type NextFetchEvent } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { config, proxy, proxyHandler, type ProxyRequest } from "../proxy";

// Feature: dashboard-ui, Req 1.1, 1.4, 1.6, 12.5, 12.11: the proxy clears stale sessions without a redirect loop.

// The real Auth.js wrapper reads the secret when it handles a request. Set before any request is made.
const AUTH_SECRET = "test-secret-for-proxy-tests-only-0123456789";
vi.hoisted(() => {
  process.env["AUTH_SECRET"] = "test-secret-for-proxy-tests-only-0123456789";
});

const SIGNED_IN = { supplierId: "11111111-1111-4111-8111-111111111111" };
const EPOCH = "Thu, 01 Jan 1970 00:00:00 GMT";

/** Builds the part of the Auth.js-wrapped request the handler reads. */
function fakeRequest(url: string, cookie: string | null, auth: ProxyRequest["auth"]): ProxyRequest {
  const request = new NextRequest(url, cookie === null ? {} : { headers: { cookie } });
  return { nextUrl: request.nextUrl, headers: request.headers, auth };
}

/** Calls the exported `proxy` (real Auth.js wrapper) with a real request. */
async function callProxy(url: string, cookie: string | null): Promise<Response> {
  // A real request carries Host and, behind a proxy, X-Forwarded-Proto; Auth.js builds its own
  // action URL from them and picks the plain or `__Secure-` cookie name from the protocol.
  const target = new URL(url);
  const headers: Record<string, string> = { host: target.host, "x-forwarded-proto": target.protocol.slice(0, -1) };
  if (cookie !== null) headers["cookie"] = cookie;
  const request = new NextRequest(url, { headers });
  const res = await proxy(request, {} as NextFetchEvent);
  if (!res) throw new Error("proxy returned no response");
  return res;
}

/** A real session JWT, as Auth.js writes it, for the plain cookie name (http, not https). */
const validSessionToken = (): Promise<string> =>
  encode({ token: { supplierId: SIGNED_IN.supplierId }, secret: AUTH_SECRET, salt: "authjs.session-token" });

/** Each Set-Cookie header as `{ name, value, raw }`. */
const setCookies = (res: Response): { name: string; value: string; raw: string }[] =>
  res.headers.getSetCookie().map((raw) => {
    const [pair = ""] = raw.split(";", 1);
    const at = pair.indexOf("=");
    return { name: pair.slice(0, at), value: pair.slice(at + 1), raw };
  });

describe("proxy: /signin?error=SessionExpired", () => {
  const cookie = [
    "authjs.session-token=stale",
    "__Secure-authjs.session-token=stale",
    "authjs.session-token.0=chunk0",
    "authjs.session-token.1=chunk1",
    "__Secure-authjs.session-token.2=chunk2",
    "authjs.csrf-token=keep",
  ].join("; ");

  it("passes through with no Location and expires every session cookie", async () => {
    const res = await callProxy("http://localhost:3000/signin?error=SessionExpired", cookie);

    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.getSetCookie()).toEqual([
      `authjs.session-token=; Path=/; Expires=${EPOCH}; Max-Age=0; HttpOnly; SameSite=lax`,
      `__Secure-authjs.session-token=; Path=/; Expires=${EPOCH}; Max-Age=0; Secure; HttpOnly; SameSite=lax`,
      `authjs.session-token.0=; Path=/; Expires=${EPOCH}; Max-Age=0; HttpOnly; SameSite=lax`,
      `authjs.session-token.1=; Path=/; Expires=${EPOCH}; Max-Age=0; HttpOnly; SameSite=lax`,
      `__Secure-authjs.session-token.2=; Path=/; Expires=${EPOCH}; Max-Age=0; Secure; HttpOnly; SameSite=lax`,
    ]);
  });

  it("removes the session cookies from the forwarded request and keeps the others", async () => {
    const res = await callProxy("http://localhost:3000/signin?error=SessionExpired", cookie);

    expect(res.headers.get("x-middleware-request-cookie")).toBe("authjs.csrf-token=keep");
  });

  it("sets no cookies when none are stale", async () => {
    const res = await callProxy("http://localhost:3000/signin?error=SessionExpired", null);

    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("ends a VALID session: every session-token Set-Cookie is expired and none has a value (real auth() wrapper)", async () => {
    const jwt = await validSessionToken();
    const half = Math.ceil(jwt.length / 2);
    const names = [
      "authjs.session-token",
      "__Secure-authjs.session-token",
      "authjs.session-token.0",
      "authjs.session-token.1",
    ];
    const validCookie = [
      `authjs.session-token=${jwt}`,
      `__Secure-authjs.session-token=${jwt}`,
      `authjs.session-token.0=${jwt.slice(0, half)}`,
      `authjs.session-token.1=${jwt.slice(half)}`,
    ].join("; ");

    const res = await callProxy("http://localhost:3000/signin?error=SessionExpired", validCookie);

    const sessionCookies = setCookies(res).filter(({ name }) => /authjs\.session-token/.test(name));
    expect(sessionCookies.map(({ name }) => name)).toEqual(names);
    for (const { value, raw } of sessionCookies) {
      expect(value).toBe("");
      expect(raw).toContain("Max-Age=0");
      expect(raw).toContain(`Expires=${EPOCH}`);
    }
    expect(res.headers.get("x-middleware-request-cookie")).toBeNull();
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

describe("proxy: the real Auth.js wrapper", () => {
  it("passes / through, not redirected, when the cookie holds a valid session", async () => {
    const jwt = await validSessionToken();

    const res = await callProxy("http://localhost:3000/", `authjs.session-token=${jwt}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("redirects / to /signin when the cookie was signed with another secret", async () => {
    const jwt = await encode({ token: { supplierId: SIGNED_IN.supplierId }, secret: "another-secret-0123456789-abcdefghij", salt: "authjs.session-token" });

    const res = await callProxy("http://localhost:3000/", `authjs.session-token=${jwt}`);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/signin");
  });

  it("redirects / to /signin when there is no cookie", async () => {
    const res = await callProxy("http://localhost:3000/", null);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/signin");
  });

  it("does not clear cookies on /signin?error=CredentialsSignin", async () => {
    const jwt = await validSessionToken();

    const res = await callProxy("http://localhost:3000/signin?error=CredentialsSignin", `authjs.session-token=${jwt}`);

    expect(res.headers.get("location")).toBeNull();
    expect(setCookies(res).every(({ value }) => value !== "")).toBe(true);
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

describe("proxy: /approvals", () => {
  it("redirects /approvals to /signin when signed out", () => {
    const res = proxyHandler(fakeRequest("http://localhost:3000/approvals", null, null));

    expect(res?.status).toBe(307);
    expect(res?.headers.get("location")).toBe("http://localhost:3000/signin");
  });

  it("passes /approvals when signed in", () => {
    expect(proxyHandler(fakeRequest("http://localhost:3000/approvals", null, SIGNED_IN))).toBeUndefined();
  });
});

describe("proxy: /api/drafts", () => {
  it("answers 401 JSON for the document route when signed out", async () => {
    const res = proxyHandler(fakeRequest("http://localhost:3000/api/drafts/x/document", null, null));

    expect(res?.status).toBe(401);
    expect(res?.headers.get("location")).toBeNull();
    expect(await res?.json()).toEqual({ error: "Unauthorized" });
  });

  it("passes the document route when signed in", () => {
    expect(proxyHandler(fakeRequest("http://localhost:3000/api/drafts/x/document", null, SIGNED_IN))).toBeUndefined();
  });
});

// Feature: debtor-ui, Req 1.1, 10.3: the Debtor_Page is behind the same session guard.
describe("proxy: /debtors/[id]", () => {
  const DEBTOR_URL = "http://localhost:3000/debtors/22222222-2222-4222-8222-222222222222";

  it("redirects /debtors/<uuid> to /signin when signed out", () => {
    const res = proxyHandler(fakeRequest(DEBTOR_URL, null, null));

    expect(res?.status).toBe(307);
    expect(res?.headers.get("location")).toBe("http://localhost:3000/signin");
  });

  it("redirects /debtors/<uuid> to /signin when the session has no supplierId", () => {
    const res = proxyHandler(fakeRequest(DEBTOR_URL, null, {}));

    expect(res?.status).toBe(307);
    expect(res?.headers.get("location")).toBe("http://localhost:3000/signin");
  });

  it("passes /debtors/<uuid> when signed in", () => {
    expect(proxyHandler(fakeRequest(DEBTOR_URL, null, SIGNED_IN))).toBeUndefined();
  });

  it("keeps the query string out of the redirect target (no ?today= leak)", () => {
    const res = proxyHandler(fakeRequest(`${DEBTOR_URL}?today=2027-03-10`, null, null));

    expect(res?.status).toBe(307);
    expect(res?.headers.get("location")).toBe("http://localhost:3000/signin");
  });

  it("redirects through the real Auth.js wrapper when there is no cookie", async () => {
    const res = await callProxy(DEBTOR_URL, null);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/signin");
  });

  it("passes through the real Auth.js wrapper when the cookie holds a valid session", async () => {
    const jwt = await validSessionToken();

    const res = await callProxy(DEBTOR_URL, `authjs.session-token=${jwt}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("proxy: module shape", () => {
  const source = readFileSync(fileURLToPath(new URL("../proxy.ts", import.meta.url)), "utf8");

  it("imports exactly next-auth, next/server and ./auth.config", () => {
    const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
    const bare = [...source.matchAll(/^import\s+"([^"]+)";/gm)].map((m) => m[1]);

    expect([...specifiers, ...bare]).toEqual(["next-auth", "next/server", "./auth.config"]);
  });

  it("guards /debtors/:path* and keeps /debtor/:path*", () => {
    expect(config.matcher).toContain("/debtors/:path*");
    expect(config.matcher).toContain("/debtor/:path*");
  });

  it("matches the nine guarded routes", () => {
    expect(config.matcher).toEqual([
      "/",
      "/signin",
      "/import/:path*",
      "/approvals/:path*",
      "/graveyard/:path*",
      "/debtor/:path*",
      "/debtors/:path*",
      "/api/import/:path*",
      "/api/drafts/:path*",
    ]);
  });
});

// Shared by the two blocks below. A matcher pattern is `/literal` or `/literal/:name*`; no other form is in use.
const patternToRegExp = (pattern: string): RegExp => {
  const star = pattern.endsWith("/:path*");
  const base = star ? pattern.slice(0, -"/:path*".length) : pattern;
  expect(base).not.toContain(":");
  return new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${star ? "(?:/.*)?" : ""}$`);
};
/** The matcher patterns that match `path`. */
const matchedBy = (path: string): string[] => (config.matcher as string[]).filter((p) => patternToRegExp(p).test(path));

// Feature: whatsapp-channel, Req 8.6, 8.7, 9.15: the webhooks have no session, only a signature, so the
// proxy must not run on them.
describe("proxy: webhook routes are not guarded", () => {

  it.each(["/api/webhooks/razorpay", "/api/webhooks/twilio"])("matches no pattern for %s", (path) => {
    expect(matchedBy(path)).toEqual([]);
  });

  it("matches nothing under /api/webhooks", () => {
    expect(matchedBy("/api/webhooks/razorpay/extra")).toEqual([]);
    expect(matchedBy("/api/webhooks")).toEqual([]);
  });

  it("still matches a guarded route with the same helper (control)", () => {
    expect(matchedBy("/api/import/preview")).toEqual(["/api/import/:path*"]);
    expect(matchedBy("/debtors/abc")).toEqual(["/debtors/:path*"]);
  });
});

// Feature: buyer-voice-call, Req 10.3, 11.10: the buyer is signed out, so the Call_Page and the four voice
// routes must stay outside the proxy (the matcher is unchanged), while `/` and `/debtors/<id>` stay guarded.
// Next runs the proxy only on paths the matcher lists, so "not matched" means "never redirected".
describe("proxy: call page and voice routes are not guarded", () => {

  const TOKEN = "aB3_-xYz0123456789abcdefghijklmnopqrstuvwxy";
  const DEBTOR_ID = "22222222-2222-4222-8222-222222222222";

  it("matches no pattern for /call/<token>", () => {
    expect(matchedBy(`/call/${TOKEN}`)).toEqual([]);
    expect(matchedBy("/call")).toEqual([]);
  });

  it.each(["session", "tool", "transcript", "end"])("matches no pattern for /api/voice/%s", (name) => {
    expect(matchedBy(`/api/voice/${name}`)).toEqual([]);
  });

  it("matches nothing under /api/voice", () => {
    expect(matchedBy("/api/voice")).toEqual([]);
    expect(matchedBy("/api/voice/session/extra")).toEqual([]);
  });

  it("still matches / and /debtors/<id>, so a signed-out request reaches the redirect", () => {
    expect(matchedBy("/")).toEqual(["/"]);
    expect(matchedBy(`/debtors/${DEBTOR_ID}`)).toEqual(["/debtors/:path*"]);
  });

  it("redirects signed-out / and /debtors/<id> to /signin through the real Auth.js wrapper", async () => {
    for (const path of ["/", `/debtors/${DEBTOR_ID}`]) {
      const res = await callProxy(`http://localhost:3000${path}`, null);

      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("http://localhost:3000/signin");
    }
  });
});
