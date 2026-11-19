// Feature: guardrails-evals, Property 1: Citation first
// Feature: guardrails-evals, Property 2: Normalisation invariance
// Feature: guardrails-evals, Property 3: Not Overdue never blocks on tense
// Validates: Requirements 1.8, 2.3, 3.1, 3.2, 3.7
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LADDER_STEPS, RULE_IDS } from "@dues-banshee/engine";
import type { RuleId } from "@dues-banshee/engine";
import { validateCitations, type BlockReason, type CitationResult } from "../src/core/citations";
import { guardDraft, type GuardContext } from "../src/core/draft-guard";
import type { ModelOutput } from "../src/core/model-output";
import { tenseCheck } from "../src/core/tense";
import { toneCheck } from "../src/core/tone";
import { BEGGING_LIST, THREAT_LIST } from "../src/core/tone-phrases";

const NEW_REASONS: readonly BlockReason[] = [
  "missing_address",
  "threat_phrase",
  "begging_phrase",
  "overdue_tense",
];

const ADDRESS = "{{buyer_name}} ji";
const TENSE_PHRASES = [
  "{{due_date}} ko due hai",
  "{{due_date}} tak due hoga",
  "{{due_date}} tak payment karna hai",
  "invoice is due on {{due_date}}",
  "the amount will be payable by {{due_date}}",
];
const FILLER = [
  "namaste",
  "payment pending hai",
  "please pay the invoice",
  "kripya payment kar dijiye",
  "{{principal}} abhi bhi due hai",
  "{{due_date}} ko due tha",
  "was due on {{due_date}}",
];

/** A phrase that is often on a tone or tense list, or harmless filler. */
const arbSegment = fc.oneof(
  { weight: 2, arbitrary: fc.constantFrom(...THREAT_LIST) },
  { weight: 2, arbitrary: fc.constantFrom(...BEGGING_LIST) },
  { weight: 2, arbitrary: fc.constantFrom(...TENSE_PHRASES) },
  { weight: 3, arbitrary: fc.constantFrom(...FILLER) },
);

const arbStep = fc.constantFrom(...LADDER_STEPS);

interface Case {
  out: ModelOutput;
  ctx: GuardContext;
}

const arbArbitraryCase: fc.Arbitrary<Case> = fc
  .record({
    text: fc.oneof(
      fc.string(),
      fc.array(arbSegment, { maxLength: 4 }).map((s) => s.join(" ")),
    ),
    ruleIds: fc.array(fc.oneof(fc.constantFrom(...RULE_IDS), fc.string()), { maxLength: 3 }),
    step: arbStep,
    allowed: fc.subarray([...RULE_IDS]),
    bankRateExists: fc.boolean(),
    overdue: fc.boolean(),
  })
  .map(({ text, ruleIds, step, allowed, bankRateExists, overdue }) => ({
    out: { text, ruleIds },
    ctx: { step, allowed, ruleIds: RULE_IDS, bankRateExists, overdue },
  }));

/** Text with no digits, no unknown tokens and MSMED-15 cited, so citations usually accept. */
const arbConstructedCase: fc.Arbitrary<Case> = fc
  .record({
    withAddress: fc.boolean(),
    segments: fc.array(arbSegment, { maxLength: 3 }),
    cited: fc.constantFrom<string[]>(["MSMED-15"], ["MSMED-15"], ["MSMED-15"], [], ["MSMED-99"]),
    extraAllowed: fc.subarray([...RULE_IDS]),
    step: arbStep,
    bankRateExists: fc.boolean(),
    overdue: fc.boolean(),
  })
  .map(({ withAddress, segments, cited, extraAllowed, step, bankRateExists, overdue }) => {
    const head = withAddress ? `Namaste ${ADDRESS},` : "Namaste {{buyer_name}},";
    const allowed: RuleId[] = [...new Set<RuleId>([...extraAllowed, "MSMED-15"])];
    return {
      out: { text: [head, ...segments].join(" "), ruleIds: cited },
      ctx: { step, allowed, ruleIds: RULE_IDS, bankRateExists, overdue },
    };
  });

const arbCase = fc.oneof(
  { weight: 1, arbitrary: arbArbitraryCase },
  { weight: 3, arbitrary: arbConstructedCase },
);

describe("Property 1: Citation first", () => {
  // Feature: guardrails-evals, Property 1: Citation first
  it("returns the citation block unchanged, and adds only the four new reasons after an accept", () => {
    const seen = { citationBlock: 0, accepted: 0, newBlock: 0 };
    fc.assert(
      fc.property(arbCase, ({ out, ctx }) => {
        const c = validateCitations(out, ctx.allowed, ctx.ruleIds, ctx.bankRateExists);
        const g = guardDraft(out, ctx);
        if (!c.ok) {
          seen.citationBlock++;
          expect(g).toEqual(c);
        } else if (g.ok) {
          seen.accepted++;
          expect(g).toEqual(c);
          expect(g.ruleIds).toEqual(c.ruleIds);
        } else {
          seen.newBlock++;
          expect(NEW_REASONS).toContain(g.reason);
        }
      }),
      { numRuns: 200 },
    );
    // The generator reaches all three outcomes, so the property is not vacuous.
    expect(seen.citationBlock).toBeGreaterThan(0);
    expect(seen.accepted).toBeGreaterThan(0);
    expect(seen.newBlock).toBeGreaterThan(0);
  });
});

const WHITESPACE_UNITS = [" ", "\t", "\n", "\r\n", "\u00a0", "\u2003"];

/** A non-empty whitespace run. */
const arbRun = fc
  .array(fc.constantFrom(...WHITESPACE_UNITS), { minLength: 1, maxLength: 3 })
  .map((u) => u.join(""));

const arbPhrase = fc.oneof(
  { weight: 2, arbitrary: fc.constantFrom(...THREAT_LIST) },
  { weight: 2, arbitrary: fc.constantFrom(...BEGGING_LIST) },
  { weight: 2, arbitrary: fc.constantFrom(...TENSE_PHRASES) },
  { weight: 3, arbitrary: fc.constantFrom(...FILLER) },
);

/**
 * A text as words (no whitespace, no whitespace inside `{{...}}` tokens), plus two
 * different whitespace runs per gap and a case mask. The address form is often present
 * so the threat and begging checks (which run after it) are reached.
 */
const arbPair = fc
  .record({
    withAddress: fc.boolean(),
    phrases: fc.array(arbPhrase, { maxLength: 4 }),
    step: arbStep,
    overdue: fc.boolean(),
    mask: fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
  })
  .chain((r) => {
    const words = [...(r.withAddress ? [ADDRESS] : []), ...r.phrases]
      .join(" ")
      .split(" ")
      .filter((w) => w !== "");
    const gaps = Math.max(words.length - 1, 0);
    return fc
      .record({
        original: fc.array(arbRun, { minLength: gaps, maxLength: gaps }),
        changed: fc.array(arbRun, { minLength: gaps, maxLength: gaps }),
      })
      .map(({ original, changed }) => {
        const join = (runs: string[]) =>
          words.map((w, i) => (i === 0 ? w : `${runs[i - 1]}${w}`)).join("");
        const variant = [...join(changed)]
          .map((ch, i) => (r.mask[i % r.mask.length] ? ch.toUpperCase() : ch.toLowerCase()))
          .join("");
        return { base: join(original), variant, step: r.step, overdue: r.overdue };
      });
  });

/** The block reason, or null when the check passed. */
const shape = (r: CitationResult | null): BlockReason | null =>
  r === null || r.ok ? null : r.reason;

describe("Property 2: Normalisation invariance", () => {
  // Feature: guardrails-evals, Property 2: Normalisation invariance
  it("gives the same tone and tense reason after whitespace and letter-case changes", () => {
    const seen = new Map<string, number>();
    fc.assert(
      fc.property(arbPair, ({ base, variant, step, overdue }) => {
        const toneBase = toneCheck(base, step);
        const toneVariant = toneCheck(variant, step);
        expect(shape(toneVariant)).toBe(shape(toneBase));
        const tenseBase = tenseCheck(base, overdue);
        const tenseVariant = tenseCheck(variant, overdue);
        expect(shape(tenseVariant)).toBe(shape(tenseBase));
        for (const r of [shape(toneBase), shape(tenseBase)]) {
          const key = r ?? "pass";
          seen.set(key, (seen.get(key) ?? 0) + 1);
        }
      }),
      { numRuns: 200 },
    );
    // Every reason is reached, so the property is not vacuous.
    for (const reason of [...NEW_REASONS, "pass"]) {
      expect(seen.get(reason) ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("Property 3: Not Overdue never blocks on tense", () => {
  // Feature: guardrails-evals, Property 3: Not Overdue never blocks on tense
  it("returns null for any text when the invoice is not overdue", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.array(arbPhrase, { maxLength: 4 }).map((s) => s.join(" ")),
          fc.constantFrom(...TENSE_PHRASES),
        ),
        (text) => {
          expect(tenseCheck(text, false)).toBeNull();
        },
      ),
      { numRuns: 200 },
    );
  });
});
