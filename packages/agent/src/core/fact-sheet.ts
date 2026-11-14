import { dueDate, formatDisplayDate, formatINR, statutoryInterest, taxBomb } from "@dues-banshee/engine";
import type { BankRate, CalendarDate } from "@dues-banshee/engine";
import type { LadderRecord } from "@dues-banshee/db";

/** Every Placeholder value, already formatted. Built only from Engine output. */
export interface FactSheet {
  buyer_name: string;
  invoice_number: string;
  principal: string;
  due_date: string;
  /** `null` with no Bank_Rate. */
  interest: string | null;
  /** `null` with no Bank_Rate. */
  rate_as_of: string | null;
  tax_bomb_date: string;
  tax_bomb_days: string;
  deduction_at_risk: string;
  pay_link: string;
}

export const PAY_LINK_TEXT = "[payment link added on send]";

/**
 * Formats the facts for one covered invoice (the Decision was `advance`).
 * Money goes through `formatINR(..., "full")`, dates through `formatDisplayDate`;
 * paise stay integers until formatting.
 */
export function buildFactSheet(
  r: Pick<LadderRecord, "invoice" | "buyerName" | "invoiceNumber">,
  today: CalendarDate,
  bankRate: BankRate | null,
): FactSheet {
  const { invoice } = r;

  const due = dueDate(invoice);
  const bomb = taxBomb(invoice, today);
  if (!due.applicable || !bomb.applicable) {
    throw new Error("buildFactSheet requires a covered invoice");
  }

  let interest: string | null = null;
  let rateAsOf: string | null = null;
  if (bankRate !== null) {
    const result = statutoryInterest(invoice, today, bankRate);
    if (!result.applicable) throw new Error("buildFactSheet requires a covered invoice");
    interest = formatINR(result.interestPaise, "full");
    rateAsOf = formatDisplayDate(bankRate.asOf);
  }

  return {
    buyer_name: r.buyerName,
    invoice_number: r.invoiceNumber,
    principal: formatINR(invoice.amountPaise, "full"),
    due_date: formatDisplayDate(due.dueDate),
    interest,
    rate_as_of: rateAsOf,
    tax_bomb_date: formatDisplayDate(bomb.taxBombDate),
    tax_bomb_days: String(bomb.daysLeft),
    deduction_at_risk: formatINR(bomb.deductionAtRiskPaise, "full"),
    pay_link: PAY_LINK_TEXT,
  };
}

/**
 * Replaces `{{name}}` tokens in one regex pass, so a value that itself contains `{{...}}`
 * is never re-scanned. Unknown names and null-valued names are left as-is.
 */
export function fillPlaceholders(text: string, facts: FactSheet): string {
  return text.replace(/\{\{([a-z_]+)\}\}/g, (token, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(facts, name)) return token;
    const value = (facts as unknown as Record<string, string | null>)[name];
    return value ?? token;
  });
}
