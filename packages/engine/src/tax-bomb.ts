import { compareDates, dayDifference, financialYearEnd } from "./calendar-date";
import { coverage, withCaveat } from "./coverage";
import { dueDate } from "./due-date";
import type { CalendarDate, Invoice, Paise, TaxBombResult, TaxBombStatus } from "./types";
import { assertCalendarDate, validateInvoice } from "./validate";

type CoveredTaxBomb = Extract<TaxBombResult, { applicable: true }>;

/**
 * The 31 March tax bomb under IT-43BH. The buyer keeps the deduction for the
 * year of purchase only if the invoice is paid on or before the Deduction_Deadline,
 * the later of 31 March and the MSMED-15 due date. Non-covered invoices get the
 * Non_Coverage_Result with status `not_applicable` and no date fields.
 */
export function taxBomb(invoice: Invoice, today: CalendarDate): TaxBombResult {
  validateInvoice(invoice);
  assertCalendarDate("today", today);

  const cov = coverage(invoice);
  if (!cov.applicable) {
    return { ...cov, status: "not_applicable", deductionAtRiskPaise: 0 };
  }
  const due = dueDate(invoice);
  if (!due.applicable) {
    // Unreachable: dueDate uses the same coverage check.
    return { ...due, status: "not_applicable", deductionAtRiskPaise: 0 };
  }

  const taxBombDate = financialYearEnd(invoice.acceptedOn);
  const deductionDeadline = compareDates(taxBombDate, due.dueDate) >= 0 ? taxBombDate : due.dueDate;

  // An invoice paid after `today` is still Unpaid on `today`.
  const { paidOn } = invoice;
  const paid = paidOn !== undefined && compareDates(paidOn, today) <= 0;

  let status: TaxBombStatus;
  let daysLeft: number;
  let deductionAtRiskPaise: Paise;
  if (paid && compareDates(paidOn, deductionDeadline) <= 0) {
    status = "defused";
    daysLeft = 0;
    deductionAtRiskPaise = 0;
  } else if (paid) {
    status = "exploded";
    daysLeft = 0;
    deductionAtRiskPaise = invoice.amountPaise;
  } else if (compareDates(today, deductionDeadline) <= 0) {
    status = "armed";
    daysLeft = dayDifference(today, deductionDeadline);
    deductionAtRiskPaise = invoice.amountPaise;
  } else {
    status = "exploded";
    daysLeft = 0;
    deductionAtRiskPaise = invoice.amountPaise;
  }

  const result: CoveredTaxBomb = {
    applicable: true,
    status,
    taxBombDate,
    deductionDeadline,
    daysLeft,
    deductionAtRiskPaise,
    ruleIds: ["IT-43BH"],
  };
  return withCaveat(result, cov);
}
