import { addDays } from "./calendar-date";
import { coverage, withCaveat } from "./coverage";
import type { CalendarDate, DueDateResult, Invoice } from "./types";
import { validateInvoice } from "./validate";

/** Term in days when there is no written agreement (MSMED-15). */
const DEFAULT_TERM_DAYS = 15;
/** Longest term the law allows, even if the parties agreed to more (MSMED-15). */
const MAX_TERM_DAYS = 45;

type CoveredDueDate = Extract<DueDateResult, { applicable: true }>;

/**
 * Statutory last date for payment under MSMED-15: acceptance date plus the
 * agreed term capped at 45 days, or 15 days when no term was agreed.
 * Non-covered invoices get the Non_Coverage_Result and no `dueDate`.
 */
export function dueDate(invoice: Invoice): DueDateResult {
  validateInvoice(invoice);
  const cov = coverage(invoice);
  if (!cov.applicable) {
    return cov;
  }
  const termDays =
    invoice.agreedTermDays === undefined ? DEFAULT_TERM_DAYS : Math.min(invoice.agreedTermDays, MAX_TERM_DAYS);
  const due: CalendarDate = addDays(invoice.acceptedOn, termDays);
  const result: CoveredDueDate = { applicable: true, dueDate: due, ruleIds: ["MSMED-15"] };
  return withCaveat(result, cov);
}
