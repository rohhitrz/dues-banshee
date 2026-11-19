import { describe, expect, it } from "vitest";
import { FUTURE_TENSE_PATTERNS, tenseCheck } from "../src/core/tense";

/** One sample per pattern: [name, index in FUTURE_TENSE_PATTERNS, text, expected offending]. */
const BLOCKED_SAMPLES: ReadonlyArray<readonly [string, number, string, string]> = [
  ["H1", 0, "Namaste {{buyer_name}} ji, {{due_date}} ko due hai.", "{{due_date}} ko due hai"],
  ["H1 hoga", 0, "{{due_date}} tak due hoga", "{{due_date}} tak due hoga"],
  ["H1 ho jayega", 0, "{{due_date}} ko due ho jayega", "{{due_date}} ko due ho jayega"],
  ["H2", 1, "{{buyer_name}} ji, {{due_date}} tak payment karna hai.", "{{due_date}} tak payment karna hai"],
  ["H2 bhugtan", 1, "{{due_date}} ko bhugtan dena hai", "{{due_date}} ko bhugtan dena hai"],
  ["E1", 2, "The amount is due on {{due_date}}.", "is due on {{due_date}}"],
  ["E1 will be due by", 2, "It will be due by {{due_date}}", "will be due by {{due_date}}"],
  ["E2", 3, "The amount is payable by {{due_date}}.", "is payable by {{due_date}}"],
  ["E2 will be payable on", 3, "It will be payable on {{due_date}}", "will be payable on {{due_date}}"],
];

describe("tenseCheck on an overdue invoice", () => {
  it("has the four documented patterns", () => {
    expect(FUTURE_TENSE_PATTERNS).toHaveLength(4);
  });

  it.each(BLOCKED_SAMPLES)("%s blocks with the matched text as offending", (_name, index, text, offending) => {
    expect(FUTURE_TENSE_PATTERNS[index]?.test(text.toLowerCase().replace(/\s+/g, " "))).toBe(true);
    expect(tenseCheck(text, true)).toEqual({ ok: false, reason: "overdue_tense", offending });
  });

  it("matches in any letter case and across whitespace runs, reporting the normalised text", () => {
    expect(tenseCheck("{{due_date}}  KO\n Due   HAI", true)).toEqual({
      ok: false,
      reason: "overdue_tense",
      offending: "{{due_date}} ko due hai",
    });
    expect(tenseCheck("Is Due\tOn {{due_date}}", true)).toEqual({
      ok: false,
      reason: "overdue_tense",
      offending: "is due on {{due_date}}",
    });
  });

  it.each([
    "{{due_date}} ko due tha",
    "Payment due ho chuka hai.",
    "The invoice was due on {{due_date}}.",
    "{{principal}} abhi bhi due hai",
  ])("passes %j", (text) => {
    expect(tenseCheck(text, true)).toBeNull();
  });

  it("does not match a longer word after the verb", () => {
    expect(tenseCheck("{{due_date}} ko due haiyaa", true)).toBeNull();
  });
});

describe("tenseCheck when the invoice is not overdue", () => {
  it.each(BLOCKED_SAMPLES)("%s passes", (_name, _index, text) => {
    expect(tenseCheck(text, false)).toBeNull();
  });
});
