import { compareDates, dayDifference } from "./calendar-date";
import { coverage, withCaveat } from "./coverage";
import { dueDate } from "./due-date";
import type { BankRate, CalendarDate, InterestResult, Invoice, Paise } from "./types";
import { assertCalendarDate, validateBankRate, validateInvoice } from "./validate";
import { ValidationError } from "./validation-error";

// Single definition lives in validate.ts; re-exported here as the design lists it.
export { MAX_PAISE } from "./validate";

/** A month rest is 30 days (Interest_Convention). */
const DAYS_PER_REST = 30;
/** Monthly_Rate = 3 × bps / 10,000 / 12 = 3 × bps / 120,000. */
const MONTHLY_RATE_DENOMINATOR = 120_000;

type CoveredInterest = Extract<InterestResult, { applicable: true }>;

/**
 * `amountPaise × ((1 + r)^(days / 30) − 1)` rounded half-up, with r = 3·bps / 120000.
 * Whole-month rests use exact BigInt arithmetic; other day counts use expm1/log1p.
 */
function compoundInterestPaise(amountPaise: Paise, annualBps: number, days: number): Paise {
  if (days === 0 || annualBps === 0) {
    return 0;
  }
  if (days % DAYS_PER_REST === 0) {
    const months = BigInt(days / DAYS_PER_REST);
    const d = BigInt(MONTHLY_RATE_DENOMINATOR);
    const n = d + 3n * BigInt(annualBps);
    const den = d ** months;
    const num = BigInt(amountPaise) * (n ** months - den);
    const interest = (2n * num + den) / (2n * den);
    if (interest > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ValidationError("today", "interest exceeds the safe integer range");
    }
    return Number(interest);
  }
  const monthlyRate = (3 * annualBps) / MONTHLY_RATE_DENOMINATOR;
  const exact = amountPaise * Math.expm1((days / DAYS_PER_REST) * Math.log1p(monthlyRate));
  const interest = Math.floor(exact + 0.5);
  if (!Number.isSafeInteger(interest)) {
    throw new ValidationError("today", "interest exceeds the safe integer range");
  }
  return interest;
}

/**
 * Statutory interest under MSMED-16: compound interest with monthly rests at
 * three times the bank rate, from the day after the due date until the earlier
 * of `paidOn` and `today`. Non-covered invoices get the Non_Coverage_Result
 * with `interestPaise: 0`.
 */
export function statutoryInterest(invoice: Invoice, today: CalendarDate, bankRate: BankRate): InterestResult {
  validateInvoice(invoice);
  assertCalendarDate("today", today);
  validateBankRate(bankRate);

  const cov = coverage(invoice);
  if (!cov.applicable) {
    return { ...cov, interestPaise: 0 };
  }
  const due = dueDate(invoice);
  if (!due.applicable) {
    // Unreachable: dueDate uses the same coverage check.
    return { ...due, interestPaise: 0 };
  }

  const accrualEnd =
    invoice.paidOn !== undefined && compareDates(invoice.paidOn, today) < 0 ? invoice.paidOn : today;
  const accrualDays = Math.max(0, dayDifference(due.dueDate, accrualEnd));
  const interestPaise = compoundInterestPaise(invoice.amountPaise, bankRate.annualBps, accrualDays);

  const result: CoveredInterest = {
    applicable: true,
    interestPaise,
    accrualDays,
    statutoryRateBps: 3 * bankRate.annualBps,
    rateAsOf: bankRate.asOf,
    ruleIds: ["MSMED-16"],
  };
  return withCaveat(result, cov);
}
