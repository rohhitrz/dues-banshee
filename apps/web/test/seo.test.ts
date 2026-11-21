import { describe, expect, it } from "vitest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { config } from "../proxy";

const patternToRegExp = (pattern: string): RegExp => {
  const star = pattern.endsWith("/:path*");
  const base = star ? pattern.slice(0, -"/:path*".length) : pattern;
  return new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${star ? "(?:/.*)?" : ""}$`);
};
const matchedBy = (path: string): string[] => (config.matcher as string[]).filter((p) => patternToRegExp(p).test(path));

describe("robots.txt", () => {
  const out = robots();
  const rules = Array.isArray(out.rules) ? out.rules : [out.rules];

  it("has one rule for every crawler", () => {
    expect(rules).toHaveLength(1);
    expect(rules[0]?.userAgent).toBe("*");
  });

  it("allows the landing and sign-in pages", () => {
    expect(rules[0]?.allow).toEqual(expect.arrayContaining(["/landing", "/signin"]));
  });

  it("also allows home, build assets and icons", () => {
    expect(rules[0]?.allow).toEqual(
      expect.arrayContaining(["/$", "/_next/", "/icon", "/apple-icon", "/favicon.ico"]),
    );
  });

  it("disallows /api/ and everything else (the signed-in routes)", () => {
    expect(rules[0]?.disallow).toEqual(["/api/", "/"]);
  });

  it("points at the sitemap on the canonical origin", () => {
    expect(out.sitemap).toBe("https://duesbanshee.in/sitemap.xml");
  });
});

describe("sitemap.xml", () => {
  it("lists only the landing page, weekly, priority 1", () => {
    expect(sitemap()).toEqual([{ url: "https://duesbanshee.in/landing", changeFrequency: "weekly", priority: 1 }]);
  });
});

// Next runs the proxy only on matcher paths, so "matches nothing" means "answers 200 signed out".
describe("proxy: SEO routes are not guarded", () => {
  it.each([
    "/robots.txt",
    "/sitemap.xml",
    "/landing",
    "/landing/opengraph-image",
    "/landing/opengraph-image-1a2b3c",
    "/icon",
    "/icon-1a2b3c",
    "/apple-icon",
    "/apple-icon-1a2b3c",
    "/favicon.ico",
  ])(
    "matches no pattern for %s",
    (path) => {
      expect(matchedBy(path)).toEqual([]);
    },
  );
});
