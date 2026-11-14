import { RULE_IDS, type RuleId } from "@dues-banshee/engine";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PLACEHOLDERS, validateCitations, type BlockReason, type CitationResult } from "../src/core/citations";
import type { ModelOutput } from "../src/core/model-output";

// Feature: escalation-ladder, Property 1: Citation_Validator matches its reference model
// **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.8, 4.9, 5.4, 11.1**

// ---------------------------------------------------------------------------
// Reference model: a plain, independent restatement of the eight ordered checks in design.md.
// It scans by hand instead of using the implementation's regexes.
// ---------------------------------------------------------------------------

type Token = { token: string; name: string };

/** Splits text into `{{name}}` tokens and the text left once tokens are removed. */
function scanTokens(text: string): { tokens: Token[]; stripped: string } {
  const tokens: Token[] = [];
  let stripped = "";
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("{{", i)) {
      let j = i + 2;
      while (j < text.length && text[j] !== "{" && text[j] !== "}") j++;
      if (text.startsWith("}}", j)) {
        tokens.push({ token: text.slice(i, j + 2), name: text.slice(i + 2, j) });
        i = j + 2;
        continue;
      }
    }
    stripped += text[i];
    i++;
  }
  return { tokens, stripped };
}

const isDigit = (ch: string): boolean => {
  const c = ch.charCodeAt(0);
  return (c >= 0x30 && c <= 0x39) || (c >= 0x966 && c <= 0x96f);
};

const isWordChar = (ch: string | undefined): boolean => {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
};

/** First digit, rupee sign, or standalone word "Rs"/"INR" (any case), by position. */
function firstFigure(s: string): string | null {
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (isDigit(ch) || ch === "₹") return ch;
    if (isWordChar(ch) && !isWordChar(s[i - 1])) {
      let j = i;
      while (isWordChar(s[j])) j++;
      const word = s.slice(i, j);
      if (word.toLowerCase() === "rs" || word.toLowerCase() === "inr") return word;
    }
  }
  return null;
}

/** First mention of delivery (English substring, any case, or the Devanagari word). */
function firstDelivery(text: string): string | null {
  const en = text.toLowerCase().indexOf("deliver");
  const hi = text.indexOf("डिलीवर");
  if (en === -1 && hi === -1) return null;
  if (hi === -1 || (en !== -1 && en < hi)) return text.slice(en, en + "deliver".length);
  return "डिलीवर";
}

const REQUIRED_RULE: Record<string, string> = {
  due_date: "MSMED-15",
  interest: "MSMED-16",
  rate_as_of: "MSMED-16",
  tax_bomb_date: "IT-43BH",
  tax_bomb_days: "IT-43BH",
  deduction_at_risk: "IT-43BH",
};

function reference(
  out: ModelOutput,
  allowed: readonly string[],
  ruleIds: readonly string[],
  bankRateExists: boolean,
): CitationResult {
  const fail = (reason: BlockReason, offending: string | null): CitationResult => ({ ok: false, reason, offending });
  const cited = out.ruleIds;

  if (out.text.replace(/[ \n\r\t]/g, "") === "") return fail("empty_body", null);
  if (cited.length === 0) return fail("missing_citation", null);
  for (const id of cited) if (!ruleIds.includes(id)) return fail("invalid_rule_id", id);
  for (const id of cited) if (!allowed.includes(id)) return fail("rule_not_applicable", id);

  const { tokens, stripped } = scanTokens(out.text);
  for (const t of tokens) {
    if (!(PLACEHOLDERS as readonly string[]).includes(t.name)) return fail("unknown_placeholder", t.token);
  }
  for (const t of tokens) {
    const need = REQUIRED_RULE[t.name];
    if (need !== undefined && !cited.includes(need)) return fail("uncited_placeholder", t.token);
  }
  if (!bankRateExists) {
    for (const t of tokens) {
      if (t.name === "interest" || t.name === "rate_as_of") return fail("bank_rate_missing", t.token);
    }
  }
  const figure = firstFigure(stripped);
  if (figure !== null) return fail("literal_figure", figure);

  const delivery = firstDelivery(out.text);
  if (delivery !== null && !(ruleIds.includes("MSMED-2B") && cited.includes("MSMED-2B"))) {
    return fail("acceptance_rule_missing", delivery);
  }

  const deduped: string[] = [];
  for (const id of cited) if (!deduped.includes(id)) deduped.push(id);
  return { ok: true, ruleIds: deduped as RuleId[] };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const ALL_RULES: RuleId[] = [...RULE_IDS];
const RULES_WITHOUT_2B: RuleId[] = ALL_RULES.filter((id) => id !== "MSMED-2B");
const INVENTED = ["MADE-UP", "MSMED-17", "msmed-16", "IT-43B", ""];

const WORDS = ["Namaste", "Sharma", "ji", "kripya", "bhugtan", "reminder", "payment", "invoice", "pending", "dhanyavaad"];
const UNKNOWN_TOKENS = ["{{foo}}", "{{ interest }}", "{{}}", "{{INTEREST}}", "{{interest_rate}}"];
const DIGIT_PIECES = ["5", "१२", "3.5%", "0"];
const MONEY_PIECES = ["₹", "Rs", "INR", "inr", "rs"];
const DELIVER_PIECES = ["deliver", "Delivered", "DELIVERY", "डिलीवरी"];
const FRAGMENTS = ["{{", "}}", "{", "R", "s"];
const BLANKS = [" ", "\n", "\t", "  \n"];

const pieceArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 10, arbitrary: fc.constantFrom(...WORDS) },
  { weight: 4, arbitrary: fc.constantFrom(...PLACEHOLDERS).map((p) => `{{${p}}}`) },
  { weight: 1, arbitrary: fc.constantFrom(...UNKNOWN_TOKENS) },
  { weight: 1, arbitrary: fc.constantFrom(...DIGIT_PIECES) },
  { weight: 1, arbitrary: fc.constantFrom(...MONEY_PIECES) },
  { weight: 1, arbitrary: fc.constantFrom(...DELIVER_PIECES) },
  { weight: 1, arbitrary: fc.constantFrom(...FRAGMENTS) },
  { weight: 1, arbitrary: fc.constantFrom(...BLANKS) },
);

const textArb: fc.Arbitrary<string> = fc
  .tuple(fc.array(pieceArb, { maxLength: 7 }), fc.constantFrom(" ", ""))
  .map(([pieces, sep]) => pieces.join(sep));

const allowedArb: fc.Arbitrary<RuleId[]> = fc.oneof(
  { weight: 3, arbitrary: fc.constant(ALL_RULES) },
  { weight: 5, arbitrary: fc.subarray(ALL_RULES) },
);

function citedArb(allowed: RuleId[]): fc.Arbitrary<string[]> {
  const one: fc.Arbitrary<string> = fc.oneof(
    ...(allowed.length > 0 ? [{ weight: 6, arbitrary: fc.constantFrom(...allowed) as fc.Arbitrary<string> }] : []),
    { weight: 2, arbitrary: fc.constantFrom(...ALL_RULES) },
    { weight: 1, arbitrary: fc.constantFrom(...INVENTED) },
  );
  return fc.oneof(
    { weight: 1, arbitrary: fc.constant<string[]>([]) },
    ...(allowed.length > 0 ? [{ weight: 3, arbitrary: fc.constant<string[]>([...allowed]) }] : []),
    { weight: 6, arbitrary: fc.array(one, { minLength: 1, maxLength: 4 }) },
  );
}

type Case = { out: ModelOutput; allowed: RuleId[]; ruleIds: string[]; bankRateExists: boolean };

const caseArb: fc.Arbitrary<Case> = allowedArb.chain((allowed) =>
  fc.record({
    out: fc.record({ text: textArb, ruleIds: citedArb(allowed) }),
    allowed: fc.constant(allowed),
    ruleIds: fc.constantFrom<string[]>(ALL_RULES, RULES_WITHOUT_2B),
    bankRateExists: fc.boolean(),
  }),
);

const outcome = (r: CitationResult): string => (r.ok ? "accepted" : r.reason);

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Property 1: Citation_Validator matches its reference model", () => {
  it("returns the reference result and is pure and deterministic", () => {
    fc.assert(
      fc.property(caseArb, (c) => {
        const snapshot = structuredClone(c);
        const frozen = deepFreeze(structuredClone(c));

        const first = validateCitations(frozen.out, frozen.allowed, frozen.ruleIds, frozen.bankRateExists);
        const second = validateCitations(frozen.out, frozen.allowed, frozen.ruleIds, frozen.bankRateExists);

        expect(first).toEqual(reference(c.out, c.allowed, c.ruleIds, c.bankRateExists));
        expect(second).toEqual(first);
        expect(frozen).toEqual(snapshot);
      }),
      { numRuns: 500 },
    );
  });

  it("the generators reach every outcome", () => {
    const seen = new Set(
      fc.sample(caseArb, { numRuns: 3000, seed: 20261113 }).map((c) => outcome(reference(c.out, c.allowed, c.ruleIds, c.bankRateExists))),
    );
    const expected: string[] = [
      "accepted",
      "empty_body",
      "missing_citation",
      "invalid_rule_id",
      "rule_not_applicable",
      "unknown_placeholder",
      "uncited_placeholder",
      "bank_rate_missing",
      "literal_figure",
      "acceptance_rule_missing",
    ];
    expect([...seen].sort()).toEqual([...expected].sort());
  });
});
