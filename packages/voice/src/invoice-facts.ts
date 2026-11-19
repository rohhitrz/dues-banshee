import { dueDate, formatDisplayDate, statutoryInterest, taxBomb } from "@dues-banshee/engine";
import type { BankRate, CalendarDate, Caveat, Invoice, Paise, RuleId } from "@dues-banshee/engine";
import { paiseToWords } from "./rupee-words";

/**
 * What `get_invoice_facts` returns to the agent. Every amount is spoken-word text (`paiseToWords`) and
 * every date a `formatDisplayDate` string; the figures come only from Engine results. No amount is a
 * digit string, so the model has nothing to read out as digits or with the rupee symbol. The one number
 * is `total_due_paise`, an integer the agent passes on to `record_promise_to_pay` limits, never speaks.
 */
export interface InvoiceFacts {
  buyer_name: string;
  supplier_name: string;
  invoice_number: string;
  principal_words: string;
  due_date: string;
  due_rule_ids: RuleId[];
  days_overdue: number;
  /** Absent when no Bank_Rate is effective. */
  interest_words?: string;
  interest_rule_ids?: RuleId[];
  total_due_words?: string;
  total_due_paise?: Paise;
  tax_bomb_date: string;
  tax_bomb_days_left: number;
  tax_bomb_rule_ids: RuleId[];
  caveat?: Caveat;
}

export type BuildInvoiceFactsResult =
  | { ok: true; facts: InvoiceFacts; totalDuePaise: Paise }
  | { ok: false; error: "bank_rate_missing"; facts: InvoiceFacts };

/**
 * Facts for one covered invoice on `callToday`. Throws if the invoice is not covered, as
 * `buildFactSheet` does: callers only reach this for a Callable_Invoice.
 */
export function buildInvoiceFacts(i: {
  invoice: Invoice;
  bankRate: BankRate | null;
  callToday: CalendarDate;
  buyerName: string;
  supplierName: string;
  invoiceNumber: string;
}): BuildInvoiceFactsResult {
  const { invoice, bankRate, callToday } = i;

  const due = dueDate(invoice);
  const bomb = taxBomb(invoice, callToday);
  if (!due.applicable || !bomb.applicable) {
    throw new Error("buildInvoiceFacts requires a covered invoice");
  }

  // Days overdue is the interest accrual length. With no Bank_Rate a zero-rate placeholder gives the
  // same day count; its interest is never read (same approach as `allowedRuleIds`).
  const accrual = statutoryInterest(invoice, callToday, bankRate ?? { annualBps: 0, asOf: callToday });
  if (!accrual.applicable) {
    throw new Error("buildInvoiceFacts requires a covered invoice");
  }

  const caveat = due.caveat ?? bomb.caveat;
  const base: InvoiceFacts = {
    buyer_name: i.buyerName,
    supplier_name: i.supplierName,
    invoice_number: i.invoiceNumber,
    principal_words: paiseToWords(invoice.amountPaise),
    due_date: formatDisplayDate(due.dueDate),
    due_rule_ids: due.ruleIds,
    days_overdue: accrual.accrualDays,
    tax_bomb_date: formatDisplayDate(bomb.taxBombDate),
    tax_bomb_days_left: bomb.daysLeft,
    tax_bomb_rule_ids: bomb.ruleIds,
    ...(caveat === undefined ? {} : { caveat }),
  };

  if (bankRate === null) {
    return { ok: false, error: "bank_rate_missing", facts: base };
  }

  const totalDuePaise = invoice.amountPaise + accrual.interestPaise;
  return {
    ok: true,
    totalDuePaise,
    facts: {
      ...base,
      interest_words: paiseToWords(accrual.interestPaise),
      interest_rule_ids: accrual.ruleIds,
      total_due_words: paiseToWords(totalDuePaise),
      total_due_paise: totalDuePaise,
    },
  };
}

/** A promise amount is valid iff `1 <= amount <= total`; it is partial iff below the total. */
export function checkPromiseAmount(amount: number, total: Paise): { ok: true; isPartial: boolean } | { ok: false } {
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > total) return { ok: false };
  return { ok: true, isPartial: amount < total };
}
