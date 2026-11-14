import { RULE_IDS, dueDate, statutoryInterest, taxBomb } from "@dues-banshee/engine";
import type {
  BankRate,
  CalendarDate,
  EscalationDecision,
  Invoice,
  RuleId,
} from "@dues-banshee/engine";

/** One invoice as the agent sees it: Engine input plus the stored facts that decide MSMED-2B. */
export interface InvoiceFacts {
  invoice: Invoice;
  invoiceDate: CalendarDate;
  acceptanceDateDefaulted: boolean;
}

/**
 * The rule IDs a draft for this invoice may cite, in `RULE_IDS` order.
 *
 * Union of the Decision's, `dueDate`'s, `statutoryInterest`'s and `taxBomb`'s rule IDs,
 * plus `MSMED-2B` when the acceptance date is defaulted or equals the invoice date.
 * With no Bank_Rate a zero-rate placeholder is used; only its `ruleIds` are read, so
 * `MSMED-16` stays citable.
 */
export function allowedRuleIds(
  facts: InvoiceFacts,
  decision: EscalationDecision,
  today: CalendarDate,
  bankRate: BankRate | null,
): RuleId[] {
  const { invoice } = facts;
  const zeroRate: BankRate = { annualBps: 0, asOf: today };
  const present = new Set<string>([
    ...decision.ruleIds,
    ...dueDate(invoice).ruleIds,
    ...statutoryInterest(invoice, today, bankRate ?? zeroRate).ruleIds,
    ...taxBomb(invoice, today).ruleIds,
  ]);

  const acceptanceApplies =
    facts.acceptanceDateDefaulted || invoice.acceptedOn === facts.invoiceDate;
  if (acceptanceApplies) present.add("MSMED-2B");

  return RULE_IDS.filter((id) => present.has(id));
}
