// Feature: whatsapp-channel, Property 1: Outbound_Text invariant
// Validates: Requirements 3.6, 3.7, 9.5
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RULE_IDS, formatINR } from "@dues-banshee/engine";
import { PAY_LINK_TEXT } from "../src/core/fact-sheet";
import { DISCLAIMER, basisLine } from "../src/core/final-text";
import { buildOutboundText, payLinkLine } from "../src/channel/outbound-text";

/** Body fragments. None holds `[` (so no stray marker can form) or `https://` (so the URL count is exact). */
const FRAGMENTS = [
  "Namaste Sharma ji, ",
  "aapka invoice abhi tak pending hai.",
  "नमस्ते शर्मा जी, कृपया भुगतान करें।",
  "{{principal}} ",
  "{ ",
  "} ",
  "$& ",
  "$' ",
  "$1 ",
  "\n",
  "\n\n",
  "₹4,12,000",
];
const arbFragment = fc.oneof(
  fc.constantFrom(...FRAGMENTS),
  fc.string({ maxLength: 12 }).filter((s) => !s.includes("[") && !s.includes("https://")),
);
const arbText = fc.array(arbFragment, { maxLength: 6 }).map((parts) => parts.join(""));

/** `https://host/path`, with `$&` and `$'` allowed in the path so a replace-based builder would fail. */
const arbUrl = fc
  .tuple(
    fc.stringMatching(/^[a-z][a-z0-9]{0,10}$/),
    fc.string({ unit: fc.constantFrom(..."abcXYZ019_-$&'.".split("")), maxLength: 16 }),
  )
  .map(([host, path]) => `https://${host}.example/${path}`);

const arbRuleIds = fc.uniqueArray(fc.constantFrom(...RULE_IDS), { minLength: 1, maxLength: RULE_IDS.length });
const arbAmount = fc.integer({ min: 1, max: 1_000_000_000_000 });

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe("Property 1: Outbound_Text invariant", () => {
  it("with one marker, replaces only the marker with the URL", () => {
    fc.assert(
      fc.property(arbText, arbText, arbUrl, arbRuleIds, arbAmount, (before, after, url, ruleIds, amountPaise) => {
        const body = `${before}${PAY_LINK_TEXT}${after}`;
        const result = buildOutboundText({ body, ruleIds, url, amountPaise });
        expect(result).toEqual({
          ok: true,
          text: `${before}${url}${after}\n\n${basisLine(ruleIds)}\n${DISCLAIMER}`,
        });
        if (!result.ok) return;
        expect(occurrences(result.text, url)).toBe(1);
        expect(result.text).not.toContain(PAY_LINK_TEXT);
        expect(result.text).toContain(basisLine(ruleIds));
        expect(result.text.split("\n").at(-1)).toEqual(DISCLAIMER);
        // No Pay_Link_Line is added when the body already places the link.
        expect(result.text).not.toContain(payLinkLine(amountPaise, url));
      }),
      { numRuns: 200 },
    );
  });

  it("with no marker, appends a blank line and the Pay_Link_Line to the unchanged body", () => {
    fc.assert(
      fc.property(arbText, arbUrl, arbRuleIds, arbAmount, (body, url, ruleIds, amountPaise) => {
        const result = buildOutboundText({ body, ruleIds, url, amountPaise });
        const line = `Pay ${formatINR(amountPaise, "full")} here: ${url}`;
        expect(result).toEqual({
          ok: true,
          text: `${body}\n\n${line}\n\n${basisLine(ruleIds)}\n${DISCLAIMER}`,
        });
        if (!result.ok) return;
        expect(payLinkLine(amountPaise, url)).toEqual(line);
        expect(occurrences(result.text, url)).toBe(1);
        expect(result.text).not.toContain(PAY_LINK_TEXT);
        expect(result.text).toContain(basisLine(ruleIds));
        expect(result.text.split("\n").at(-1)).toEqual(DISCLAIMER);
      }),
      { numRuns: 200 },
    );
  });

  it("refuses a body with two or more markers", () => {
    fc.assert(
      fc.property(
        fc.array(arbText, { minLength: 3, maxLength: 5 }),
        arbUrl,
        arbRuleIds,
        arbAmount,
        (pieces, url, ruleIds, amountPaise) => {
          const body = pieces.join(PAY_LINK_TEXT);
          expect(buildOutboundText({ body, ruleIds, url, amountPaise })).toEqual({
            ok: false,
            reason: "multiple_markers",
          });
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("buildOutboundText examples", () => {
  it("renders the marker sentence for a whatsapp_paylink body", () => {
    expect(
      buildOutboundText({
        body: `Kripya ${PAY_LINK_TEXT} se bhugtan kar dein.`,
        ruleIds: ["MSMED-15", "MSMED-16"],
        url: "https://rzp.example/plink_1",
        amountPaise: 41200000,
      }),
    ).toEqual({
      ok: true,
      text:
        "Kripya https://rzp.example/plink_1 se bhugtan kar dein.\n\n" +
        "Basis: MSMED-15 (MSMED Act 2006, s.15); MSMED-16 (MSMED Act 2006, s.16)\n" +
        DISCLAIMER,
    });
  });

  it("appends the Pay_Link_Line with the Engine-formatted amount when there is no marker", () => {
    expect(
      buildOutboundText({
        body: "Namaste Sharma ji.",
        ruleIds: ["MSMED-15"],
        url: "https://rzp.example/plink_1",
        amountPaise: 41200000,
      }),
    ).toEqual({
      ok: true,
      text:
        `Namaste Sharma ji.\n\nPay ${formatINR(41200000, "full")} here: https://rzp.example/plink_1\n\n` +
        `Basis: MSMED-15 (MSMED Act 2006, s.15)\n${DISCLAIMER}`,
    });
  });
});
