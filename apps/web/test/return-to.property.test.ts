import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseReturnTo } from "@/lib/approvals/return-to";

// Feature: debtor-ui, Property 9: returnTo allowlist
// **Validates: Requirements 7.4, 10.5**

const arbUuid = fc.uuid().chain((id) => fc.constantFrom(id, id.toUpperCase()));
const arbValidTarget = fc.oneof(fc.constant("/approvals"), arbUuid.map((id) => `/debtors/${id}`));
const arbSuffix = fc.constantFrom("?x", "#x", "/x", "//", "?today=2026-11-12", " ", "\n");
const arbHost = fc.constantFrom("evil.example", "evil.example/debtors", "localhost:3000");

const arbCandidate = fc.oneof(
  arbValidTarget,
  fc.tuple(arbValidTarget, arbSuffix).map(([target, suffix]) => `${target}${suffix}`),
  fc.tuple(arbSuffix, arbValidTarget).map(([prefix, target]) => `${prefix}${target}`),
  arbHost.map((host) => `//${host}`),
  arbHost.map((host) => `https://${host}`),
  fc.tuple(arbHost, arbValidTarget).map(([host, target]) => `//${host}${target}`),
  fc.tuple(arbHost, arbValidTarget).map(([host, target]) => `https://${host}${target}`),
  fc.constantFrom("", "/", "/debtors/", "/debtors/not-a-uuid", "/approvals/", "approvals", "/APPROVALS"),
  fc.string(),
  fc.string({ unit: "grapheme-ascii" }).map((s) => `/debtors/${s}`),
);

/** The reference rule, written independently of the implementation. */
function isAllowed(s: string): boolean {
  if (s === "/approvals") return true;
  const prefix = "/debtors/";
  if (!s.startsWith(prefix)) return false;
  const rest = s.slice(prefix.length);
  return rest.length === 36 && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(rest);
}

describe("Property 9: returnTo allowlist", () => {
  it("returns the (lowercased) input only for /approvals or /debtors/<uuid>, else /approvals", () => {
    fc.assert(
      fc.property(arbCandidate, (raw) => {
        expect(parseReturnTo(raw)).toBe(isAllowed(raw) ? raw.toLowerCase() : "/approvals");
      }),
      { numRuns: 200 },
    );
  });

  it("accepts every valid target, lowercased", () => {
    fc.assert(
      fc.property(arbValidTarget, (target) => {
        expect(parseReturnTo(target)).toBe(target.toLowerCase());
      }),
      { numRuns: 100 },
    );
  });
  it("lowercases an uppercase uuid", () => {
    expect(parseReturnTo("/debtors/0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D")).toBe(
      "/debtors/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    );
  });
});
