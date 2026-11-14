// Feature: escalation-ladder, Property 5: Final_Text shape
// Validates: Requirements 5.8, 6.5
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RULE_IDS, RULE_SOURCES } from "@dues-banshee/engine";
import { DISCLAIMER, basisLine, buildFinalText } from "../src/core/final-text";

/** Any text, including blank lines, newlines and non-BMP characters. */
const arbBody = fc.oneof(fc.string(), fc.string({ unit: "binary" }));

/** Non-empty, in any order, repeats allowed. */
const arbRuleIds = fc.array(fc.constantFrom(...RULE_IDS), { minLength: 1, maxLength: 8 });

describe("Property 5: Final_Text shape", () => {
  // Feature: escalation-ladder, Property 5: Final_Text shape
  it("is body, blank line, Basis_Line, then the Disclaimer as the last line", () => {
    fc.assert(
      fc.property(arbBody, arbRuleIds, (body, ruleIds) => {
        const text = buildFinalText(body, ruleIds);
        const basis = basisLine(ruleIds);

        expect(text).toEqual(`${body}\n\n${basis}\n${DISCLAIMER}`);
        expect(text.split("\n").at(-1)).toEqual(DISCLAIMER);
        expect(text.endsWith(`\n${basis}\n${DISCLAIMER}`)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: escalation-ladder, Property 5: Final_Text shape
  it("Basis_Line starts with `Basis: ` and lists `<id> (<source>)` per rule ID in the given order", () => {
    fc.assert(
      fc.property(arbRuleIds, (ruleIds) => {
        const basis = basisLine(ruleIds);

        expect(basis.startsWith("Basis: ")).toBe(true);
        expect(basis).not.toContain("\n");
        const entries = ruleIds.map((id) => `${id} (${RULE_SOURCES[id]})`);
        expect(basis).toEqual(`Basis: ${entries.join("; ")}`);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: escalation-ladder, Property 5: Final_Text shape
  it("Basis_Line depends only on the rule IDs, so an edited body keeps it", () => {
    fc.assert(
      fc.property(arbBody, arbBody, arbRuleIds, (body, editedBody, ruleIds) => {
        const basis = basisLine(ruleIds);
        const original = buildFinalText(body, ruleIds);
        const rebuilt = buildFinalText(editedBody, ruleIds);

        expect(original.includes(`\n\n${basis}\n${DISCLAIMER}`)).toBe(true);
        expect(rebuilt.includes(`\n\n${basis}\n${DISCLAIMER}`)).toBe(true);
        expect(rebuilt).toEqual(`${editedBody}\n\n${basis}\n${DISCLAIMER}`);
        expect(basisLine(ruleIds)).toEqual(basis);
      }),
      { numRuns: 100 },
    );
  });

  it("renders the exact literal for MSMED-15 and MSMED-16", () => {
    expect(basisLine(["MSMED-15", "MSMED-16"])).toEqual(
      "Basis: MSMED-15 (MSMED Act 2006, s.15); MSMED-16 (MSMED Act 2006, s.16)",
    );
  });

  it("DISCLAIMER matches the app footer text", () => {
    // Reads the source as text, so packages/agent has no import dependency on apps/web.
    const source = readFileSync(
      new URL("../../../apps/web/components/app-shell.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain(`export const FOOTER_TEXT = ${JSON.stringify(DISCLAIMER)};`);
  });
});
