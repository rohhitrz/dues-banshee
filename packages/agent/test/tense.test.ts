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
  ["H2 karna hoga", 1, "{{due_date}} tak payment karna hoga", "{{due_date}} tak payment karna hoga"],
  ["H2 due ho jayega", 1, "{{due_date}} ko payment due ho jayega", "{{due_date}} ko payment due ho jayega"],
  ["E1 on or before", 2, "The amount is due on or before {{due_date}}.", "is due on or before {{due_date}}"],
  ["E1 becomes due on", 2, "The amount becomes due on {{due_date}}.", "becomes due on {{due_date}}"],
  [
    "E1 is due for payment on",
    2,
    "The amount is due for payment on {{due_date}}.",
    "is due for payment on {{due_date}}",
  ],
  ["E2 on or before", 3, "It is payable on or before {{due_date}}.", "is payable on or before {{due_date}}"],
  ["E3 pay by", 4, "Please pay {{principal}} by {{due_date}}.", "pay {{principal}} by {{due_date}}"],
  [
    "E3 kindly pay before",
    4,
    "Kindly pay the amount at {{pay_link}} before {{due_date}}.",
    "pay the amount at {{pay_link}} before {{due_date}}",
  ],
  [
    "E3 settle on or before",
    4,
    "You may settle {{principal}} on or before {{due_date}}.",
    "settle {{principal}} on or before {{due_date}}",
  ],
  ["E3 clear by", 4, "Clear the dues by {{due_date}}", "clear the dues by {{due_date}}"],
  ["H3 tak bhugtan karein", 5, "{{due_date}} tak bhugtan karein.", "{{due_date}} tak bhugtan karein"],
  ["H3 tak payment kar dein", 5, "{{due_date}} tak payment kar dein.", "{{due_date}} tak payment kar dein"],
  ["H3 se pehle bhugtan kardein", 5, "{{due_date}} se pehle bhugtan kardein", "{{due_date}} se pehle bhugtan kardein"],
  ["H3 se pehle payment kar dijiye", 5, "{{due_date}} se pehle payment kar dijiye", "{{due_date}} se pehle payment kar dijiye"],
  ["H3 tak bhugtan karna hoga", 5, "{{due_date}} tak bhugtan karna hoga", "{{due_date}} tak bhugtan karna hoga"],
];

describe("tenseCheck on an overdue invoice", () => {
  it("has the six documented patterns", () => {
    expect(FUTURE_TENSE_PATTERNS).toHaveLength(6);
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
    "The invoice, which was due on {{due_date}}, is unpaid.",
    "which was due on {{due_date}}",
    "Please pay {{principal}} at {{pay_link}}",
    "Please pay {{principal}} at {{pay_link}}. It was due by {{due_date}}",
    "Please pay {{principal}}, which was due by {{due_date}}",
    "Kindly clear {{principal}}; it was due before {{due_date}}",
    "Please settle {{principal}}, which were due on or before {{due_date}}",
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
