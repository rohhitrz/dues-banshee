import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays, compareDates, dayDifference } from "../src/calendar-date";
import { statutoryInterest } from "../src/index";
import type { BankRate, CalendarDate, Invoice } from "../src/types";
import { arbBankRate, arbCoveredInvoice, arbToday } from "./arbitraries";

/** Accrual is capped so the interest stays far below Number.MAX_SAFE_INTEGER. */
const MAX_ACCRUAL_DAYS = 3_650;

/** Independent MSMED-15 due date: agreed term capped at 45 days, or 15 days with no term. */
function oracleDueDate(invoice: Invoice): CalendarDate {
  const term = invoice.agreedTermDays === undefined ? 15 : Math.min(invoice.agreedTermDays, 45);
  return addDays(invoice.acceptedOn, term);
}

/** Accrual_Days = max(0, dayDifference(dueDate, min(today, paidOn))). */
function oracleAccrualDays(invoice: Invoice, today: CalendarDate): number {
  const end = invoice.paidOn !== undefined && compareDates(invoice.paidOn, today) < 0 ? invoice.paidOn : today;
  return Math.max(0, dayDifference(oracleDueDate(invoice), end));
}

/** Interest_Convention reference, unrounded: A·((1 + r)^(d/30) − 1) with r = 3·bps / 120000. */
function oracleInterest(amountPaise: number, annualBps: number, days: number): number {
  const r = (3 * annualBps) / 120_000;
  return amountPaise * (Math.pow(1 + r, days / 30) - 1);
}

/** Covered invoice, bank rate and a `today` whose accrual stays within the cap. */
const arbCase: fc.Arbitrary<{ invoice: Invoice; today: CalendarDate; bankRate: BankRate }> = arbCoveredInvoice
  .chain((invoice) => fc.record({ invoice: fc.constant(invoice), today: arbToday(invoice), bankRate: arbBankRate }))
  .filter(({ invoice, today }) => oracleAccrualDays(invoice, today) <= MAX_ACCRUAL_DAYS);

/**
 * Covered invoice, bank rate and a `today` where accrual ends on or before the Due_Date:
 * either `today` itself is on or before the Due_Date (biased to the exact Due_Date), or the
 * invoice was paid on or before the Due_Date and `today` is any date.
 */
const arbNoAccrualCase: fc.Arbitrary<{ invoice: Invoice; today: CalendarDate; bankRate: BankRate }> =
  arbCoveredInvoice.chain((base) => {
    const due = oracleDueDate(base);
    const todayOnOrBeforeDue = fc.record({
      invoice: fc.constant(base),
      today: fc.oneof(
        { weight: 2, arbitrary: fc.constant(due) },
        { weight: 3, arbitrary: fc.integer({ min: -30, max: dayDifference(base.acceptedOn, due) }).map((n) => addDays(base.acceptedOn, n)) },
      ),
      bankRate: arbBankRate,
    });
    const paidOnOrBeforeDue = fc
      .integer({ min: 0, max: dayDifference(base.acceptedOn, due) })
      .map((n): Invoice => ({ ...base, paidOn: addDays(base.acceptedOn, n) }))
      .chain((invoice) => fc.record({ invoice: fc.constant(invoice), today: arbToday(invoice), bankRate: arbBankRate }));
    return fc.oneof(todayOnOrBeforeDue, paidOnOrBeforeDue);
  });

/** Removes `paidOn` without leaving an `undefined` key (exactOptionalPropertyTypes). */
function withoutPaidOn(invoice: Invoice): Invoice {
  const { paidOn: _paidOn, ...rest } = invoice;
  void _paidOn;
  return rest;
}

/**
 * Covered invoice (half with `paidOn` stripped, half as generated, which may include it),
 * bank rate and two dates `today1 < today2`. The pair is either a random `today1` plus a
 * gap biased to 1 day, or a one-day step across a whole-month rest
 * (Accrual_Days 30m−1 → 30m, or 30m → 30m+1) where the float and BigInt paths switch.
 */
const arbMonotoneCase: fc.Arbitrary<{
  invoice: Invoice;
  today1: CalendarDate;
  today2: CalendarDate;
  bankRate: BankRate;
}> = fc
  .tuple(arbCoveredInvoice, fc.boolean())
  .map(([invoice, keepPaidOn]) => (keepPaidOn ? invoice : withoutPaidOn(invoice)))
  .chain((invoice) => {
    const due = oracleDueDate(invoice);
    const gap = fc.oneof(
      { weight: 3, arbitrary: fc.constant(1) },
      { weight: 2, arbitrary: fc.integer({ min: 2, max: 31 }) },
      { weight: 1, arbitrary: fc.integer({ min: 32, max: 400 }) },
    );
    const randomPair = fc
      .tuple(arbToday(invoice), gap)
      .map(([today1, n]): [CalendarDate, CalendarDate] => [today1, addDays(today1, n)]);
    const restStraddle = fc
      .tuple(fc.integer({ min: 1, max: 40 }), fc.constantFrom(-1, 0))
      .map(([m, k]): [CalendarDate, CalendarDate] => {
        const today1 = addDays(due, 30 * m + k);
        return [today1, addDays(today1, 1)];
      });
    return fc.record({
      invoice: fc.constant(invoice),
      pair: fc.oneof({ weight: 1, arbitrary: randomPair }, { weight: 1, arbitrary: restStraddle }),
      bankRate: arbBankRate,
    });
  })
  .map(({ invoice, pair: [today1, today2], bankRate }) => ({ invoice, today1, today2, bankRate }))
  .filter(({ invoice, today2 }) => oracleAccrualDays(invoice, today2) <= MAX_ACCRUAL_DAYS);

/**
 * Independent exact reference for whole-month rests:
 * A·((1 + 3·bps/120000)^m − 1) = A·(N^m − D^m) / D^m with N = 120000 + 3·bps, D = 120000,
 * rounded half-up by comparing twice the remainder with the denominator.
 */
function exactWholeMonthInterest(amountPaise: number, annualBps: number, months: number): bigint {
  const base = 120_000n;
  const grown = base + 3n * BigInt(annualBps);
  let numPow = 1n;
  let denPow = 1n;
  for (let i = 0; i < months; i++) {
    numPow *= grown;
    denPow *= base;
  }
  const numerator = BigInt(amountPaise) * (numPow - denPow);
  const quotient = numerator / denPow;
  const remainder = numerator % denPow;
  return 2n * remainder >= denPow ? quotient + 1n : quotient;
}

/** Covered invoice with no `paidOn`, bank rate and m with 30·m ≤ MAX_ACCRUAL_DAYS. */
const arbWholeMonthCase: fc.Arbitrary<{ invoice: Invoice; bankRate: BankRate; months: number }> = fc.record({
  invoice: arbCoveredInvoice.map(withoutPaidOn),
  bankRate: arbBankRate,
  months: fc.oneof(
    { weight: 2, arbitrary: fc.integer({ min: 1, max: 12 }) },
    { weight: 1, arbitrary: fc.integer({ min: 1, max: Math.floor(MAX_ACCRUAL_DAYS / 30) }) },
  ),
});

describe("statutory-interest properties", () => {
  // Feature: legal-engine, Property 9: Whole-month rests are exact
  it("Property 9: Whole-month rests are exact", () => {
    // **Validates: Requirements 4.11**
    fc.assert(
      fc.property(arbWholeMonthCase, ({ invoice, bankRate, months }) => {
        const today = addDays(oracleDueDate(invoice), 30 * months);
        const result = statutoryInterest(invoice, today, bankRate);
        expect(result.applicable).toBe(true);
        if (!result.applicable) return;
        expect(result.accrualDays).toBe(30 * months);
        const expected = exactWholeMonthInterest(invoice.amountPaise, bankRate.annualBps, months);
        expect(BigInt(result.interestPaise)).toBe(expected);
      }),
    );
  });

  // Feature: legal-engine, Property 8: Interest never decreases as time passes
  it("Property 8: Interest never decreases as time passes", () => {
    // **Validates: Requirements 4.9**
    fc.assert(
      fc.property(arbMonotoneCase, ({ invoice, today1, today2, bankRate }) => {
        expect(compareDates(today1, today2)).toBe(-1);
        const earlier = statutoryInterest(invoice, today1, bankRate);
        const later = statutoryInterest(invoice, today2, bankRate);
        expect(earlier.applicable && later.applicable).toBe(true);
        expect(later.interestPaise).toBeGreaterThanOrEqual(earlier.interestPaise);
      }),
    );
  });

  // Feature: legal-engine, Property 7: No interest on or before the due date
  it("Property 7: No interest on or before the due date", () => {
    // **Validates: Requirements 4.3, 4.10**
    fc.assert(
      fc.property(arbNoAccrualCase, ({ invoice, today, bankRate }) => {
        const result = statutoryInterest(invoice, today, bankRate);
        expect(result.applicable).toBe(true);
        if (!result.applicable) return;
        expect(result.interestPaise).toBe(0);
        expect(result.accrualDays).toBe(0);
      }),
    );
  });

  // Feature: legal-engine, Property 6: Interest matches the Interest_Convention
  it("Property 6: Interest matches the Interest_Convention", () => {
    // **Validates: Requirements 4.1, 4.2, 4.5, 4.8, 8.2**
    fc.assert(
      fc.property(arbCase, ({ invoice, today, bankRate }) => {
        const result = statutoryInterest(invoice, today, bankRate);
        expect(result.applicable).toBe(true);
        if (!result.applicable) return;

        const days = oracleAccrualDays(invoice, today);
        expect(result.accrualDays).toBe(days);

        expect(Number.isSafeInteger(result.interestPaise)).toBe(true);
        expect(result.interestPaise).toBeGreaterThanOrEqual(0);

        const reference = oracleInterest(invoice.amountPaise, bankRate.annualBps, days);
        expect(Math.abs(result.interestPaise - reference)).toBeLessThanOrEqual(0.5 + 1e-9 * result.interestPaise);

        expect(result.statutoryRateBps).toBe(3 * bankRate.annualBps);
        expect(result.rateAsOf).toBe(bankRate.asOf);
        expect(result.ruleIds).toContain("MSMED-16");
      }),
    );
  });
});
