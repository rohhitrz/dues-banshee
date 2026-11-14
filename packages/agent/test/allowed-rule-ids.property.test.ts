// Feature: escalation-ladder, Property 3: Allowed_Rule_IDs are the Engine's citations plus MSMED-2B by rule
// Validates: Requirements 4.3, 11.3
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  RULE_IDS,
  dueDate,
  nextEscalationStep,
  statutoryInterest,
  taxBomb,
} from "@dues-banshee/engine";
import type { BankRate, RuleId } from "@dues-banshee/engine";
import {
  arbBankRate,
  arbCalendarDate,
  arbCoveredInvoice,
  arbHistory,
  arbLadderConfig,
  arbToday,
} from "../../engine/test/arbitraries";
import { allowedRuleIds } from "../src/core/allowed-rule-ids";
import type { InvoiceFacts } from "../src/core/allowed-rule-ids";

/** Covered invoice, history, config, today, optional bank rate, and the stored acceptance facts. */
const arbScenario = arbCoveredInvoice.chain((invoice) =>
  fc.record({
    invoice: fc.constant(invoice),
    history: arbHistory(invoice),
    config: arbLadderConfig,
    today: arbToday(invoice),
    bankRate: fc.option(arbBankRate, { nil: null, freq: 3 }),
    acceptanceDateDefaulted: fc.boolean(),
    // Half the time the invoice date equals acceptedOn, so both MSMED-2B triggers are exercised.
    invoiceDate: fc.oneof(fc.constant(invoice.acceptedOn), arbCalendarDate()),
  }),
);

/** Independent oracle: collect Engine citations, then order by position in RULE_IDS. */
function expectedRuleIds(
  facts: InvoiceFacts,
  decisionRuleIds: readonly RuleId[],
  today: string,
  bankRate: BankRate | null,
): RuleId[] {
  const { invoice } = facts;
  const rate: BankRate = bankRate ?? { annualBps: 0, asOf: today };
  const cited = new Set<string>([
    ...decisionRuleIds,
    ...dueDate(invoice).ruleIds,
    ...statutoryInterest(invoice, today, rate).ruleIds,
    ...taxBomb(invoice, today).ruleIds,
  ]);
  const acceptanceRule: boolean =
    RULE_IDS.includes("MSMED-2B") &&
    (facts.acceptanceDateDefaulted || invoice.acceptedOn === facts.invoiceDate);
  if (acceptanceRule) cited.add("MSMED-2B");
  return [...cited].sort((a, b) => RULE_IDS.indexOf(a as RuleId) - RULE_IDS.indexOf(b as RuleId)) as RuleId[];
}

describe("Property 3: Allowed_Rule_IDs are the Engine's citations plus MSMED-2B by rule", () => {
  it("equals the RULE_IDS-ordered union of Engine citations, plus MSMED-2B by rule", () => {
    fc.assert(
      fc.property(arbScenario, (s) => {
        const facts: InvoiceFacts = {
          invoice: s.invoice,
          invoiceDate: s.invoiceDate,
          acceptanceDateDefaulted: s.acceptanceDateDefaulted,
        };
        const decision = nextEscalationStep(s.invoice, s.history, s.today, s.config);

        const actual = allowedRuleIds(facts, decision, s.today, s.bankRate);

        expect(actual).toEqual(expectedRuleIds(facts, decision.ruleIds, s.today, s.bankRate));
        expect(actual.every((id) => RULE_IDS.includes(id))).toBe(true);
        expect(new Set(actual).size).toBe(actual.length);

        const hasAcceptance = actual.includes("MSMED-2B");
        expect(hasAcceptance).toBe(
          s.acceptanceDateDefaulted || s.invoice.acceptedOn === s.invoiceDate,
        );
      }),
      { numRuns: 200 },
    );
  });
});
