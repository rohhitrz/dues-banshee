import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { financialYearEnd } from "../src/calendar-date";
import { taxBomb } from "../src/index";
import type { CalendarDate, Invoice, TaxBombResult } from "../src/types";
import { arbCalendarDate, arbCoveredInvoice, arbCoveredInvoiceNearYearEnd, arbToday } from "./arbitraries";

// ---------------------------------------------------------------------------
// Independent oracles (no dependency on the engine's calendar helpers)
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/** Whole days from `a` to `b` using UTC midnights, so host time zone and DST cannot matter. */
function daysBetween(a: CalendarDate, b: CalendarDate): number {
  const utc = (d: CalendarDate): number => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Math.round((utc(b) - utc(a)) / MS_PER_DAY);
}

/** `d` shifted by `n` days, formatted back to YYYY-MM-DD. */
function shiftDays(d: CalendarDate, n: number): CalendarDate {
  const ms = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) + n * MS_PER_DAY;
  return new Date(ms).toISOString().slice(0, 10);
}

/** The Financial_Year runs 1 April to 31 March: from April on it ends next March, otherwise this March. */
function expectedTaxBombDate(acceptedOn: CalendarDate): CalendarDate {
  const year = Number(acceptedOn.slice(0, 4));
  const month = Number(acceptedOn.slice(5, 7));
  return `${month >= 4 ? year + 1 : year}-03-31`;
}

/** First day of the Financial_Year that contains `d`. */
function financialYearStart(d: CalendarDate): CalendarDate {
  const year = Number(d.slice(0, 4));
  const month = Number(d.slice(5, 7));
  return `${month >= 4 ? year : year - 1}-04-01`;
}

/** MSMED-15 Due_Date: agreed term capped at 45 days, 15 days when no term is given. */
function expectedDueDate(invoice: Invoice): CalendarDate {
  const term = invoice.agreedTermDays === undefined ? 15 : Math.min(invoice.agreedTermDays, 45);
  return shiftDays(invoice.acceptedOn, term);
}

/** The later of two YYYY-MM-DD dates (lexical order equals chronological order for this fixed-width format). */
const laterOf = (a: CalendarDate, b: CalendarDate): CalendarDate => (a >= b ? a : b);

// ---------------------------------------------------------------------------
// Property 10 check
// ---------------------------------------------------------------------------

/** Checks Property 10 for one covered invoice and one `today`. */
function checkTaxBombDates(invoice: Invoice, today: CalendarDate): void {
  const result: TaxBombResult = taxBomb(invoice, today);
  expect(result.applicable).toBe(true);
  if (!result.applicable) return;

  const { taxBombDate, deductionDeadline } = result;

  // 31 March, matching the oracle and the engine's own financialYearEnd.
  expect(taxBombDate.endsWith("-03-31")).toBe(true);
  expect(taxBombDate).toBe(expectedTaxBombDate(invoice.acceptedOn));
  expect(taxBombDate).toBe(financialYearEnd(invoice.acceptedOn));

  // 0..365 days after acceptance (365 only when the span includes 29 February).
  const span = daysBetween(invoice.acceptedOn, taxBombDate);
  expect(span).toBeGreaterThanOrEqual(0);
  expect(span).toBeLessThanOrEqual(365);

  // Same Financial_Year as acceptedOn: [1 April, 31 March] around acceptedOn.
  expect(financialYearStart(invoice.acceptedOn) <= invoice.acceptedOn).toBe(true);
  expect(invoice.acceptedOn <= taxBombDate).toBe(true);
  expect(daysBetween(financialYearStart(invoice.acceptedOn), taxBombDate)).toBeLessThanOrEqual(365);
  expect(financialYearStart(taxBombDate)).toBe(financialYearStart(invoice.acceptedOn));

  // Deduction_Deadline is the later of the Tax_Bomb_Date and the MSMED-15 Due_Date.
  const due = expectedDueDate(invoice);
  expect(deductionDeadline).toBe(laterOf(taxBombDate, due));
  expect(deductionDeadline >= taxBombDate).toBe(true);
  expect(deductionDeadline >= due).toBe(true);
  expect(deductionDeadline === taxBombDate || deductionDeadline === due).toBe(true);

  expect(result.ruleIds).toContain("IT-43BH");
}

/** Pairs a covered invoice with a `today` steered towards the interesting dates for it. */
const arbCoveredInvoiceAndToday: fc.Arbitrary<readonly [Invoice, CalendarDate]> = arbCoveredInvoice.chain((invoice) =>
  arbToday(invoice).map((today): readonly [Invoice, CalendarDate] => [invoice, today]),
);

describe("tax-bomb properties", () => {
  // Feature: legal-engine, Property 10: Tax_Bomb_Date and Deduction_Deadline
  it("Property 10: Tax_Bomb_Date and Deduction_Deadline", () => {
    // **Validates: Requirements 5.1, 5.9**
    fc.assert(fc.property(arbCoveredInvoiceAndToday, ([invoice, today]) => checkTaxBombDates(invoice, today)));
  });

  // Feature: legal-engine, Property 10: Tax_Bomb_Date and Deduction_Deadline
  it("Property 10: dates do not depend on today", () => {
    // **Validates: Requirements 5.1, 5.9**
    fc.assert(
      fc.property(arbCoveredInvoice, arbCalendarDate(), arbCalendarDate(), (invoice, todayA, todayB) => {
        const a = taxBomb(invoice, todayA);
        const b = taxBomb(invoice, todayB);
        if (a.applicable && b.applicable) {
          expect(a.taxBombDate).toBe(b.taxBombDate);
          expect(a.deductionDeadline).toBe(b.deductionDeadline);
        } else {
          expect.unreachable("covered invoice must yield an applicable result");
        }
      }),
    );
  });

  // Feature: legal-engine, Property 10: Tax_Bomb_Date and Deduction_Deadline
  it("Property 10: acceptance on 1 April is 365 days before 31 March in a leap year, 364 otherwise", () => {
    // **Validates: Requirements 5.1, 5.9**
    const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    fc.assert(
      fc.property(fc.integer({ min: 2020, max: 2034 }), (year) => {
        const invoice: Invoice = {
          id: "boundary",
          amountPaise: 100_000,
          acceptedOn: `${year}-04-01`,
          supplierCategory: "micro",
          supplierActivity: "manufacturing",
        };
        const result = taxBomb(invoice, `${year}-04-01`);
        expect(result.applicable).toBe(true);
        if (!result.applicable) return;
        expect(result.taxBombDate).toBe(`${year + 1}-03-31`);
        // The year ending 31 March of year+1 contains 29 February only if year+1 is a leap year.
        expect(daysBetween(invoice.acceptedOn, result.taxBombDate)).toBe(isLeap(year + 1) ? 365 : 364);
      }),
    );
    // The leap-year maximum named in the design: 2027-04-01 to 2028-03-31 is 365 days.
    expect(daysBetween("2027-04-01", "2028-03-31")).toBe(365);
  });
});

// ---------------------------------------------------------------------------
// Property 11: status oracle
// ---------------------------------------------------------------------------

type OracleCase =
  | "defused"
  | "exploded_paid_late"
  | "armed_unpaid"
  | "exploded_unpaid";

interface OracleOutcome {
  status: "armed" | "exploded" | "defused";
  daysLeft: number;
  deductionAtRiskPaise: number;
  deadline: CalendarDate;
  taxBombDate: CalendarDate;
  dueDate: CalendarDate;
  /** Which row of the status table applied. */
  row: OracleCase;
}

/** The status table of Requirement 5, written out independently of src/tax-bomb.ts. */
function oracle(invoice: Invoice, today: CalendarDate): OracleOutcome {
  const taxBombDate = expectedTaxBombDate(invoice.acceptedOn);
  const due = expectedDueDate(invoice);
  const deadline = laterOf(taxBombDate, due);
  const amount = invoice.amountPaise;
  const base = { deadline, taxBombDate, dueDate: due };
  const paid = invoice.paidOn !== undefined && invoice.paidOn <= today;

  if (paid && invoice.paidOn !== undefined && invoice.paidOn <= deadline) {
    return { ...base, status: "defused", daysLeft: 0, deductionAtRiskPaise: 0, row: "defused" };
  }
  if (paid) {
    return { ...base, status: "exploded", daysLeft: 0, deductionAtRiskPaise: amount, row: "exploded_paid_late" };
  }
  if (today <= deadline) {
    return {
      ...base,
      status: "armed",
      daysLeft: daysBetween(today, deadline),
      deductionAtRiskPaise: amount,
      row: "armed_unpaid",
    };
  }
  return { ...base, status: "exploded", daysLeft: 0, deductionAtRiskPaise: amount, row: "exploded_unpaid" };
}

/** Same invoice with `paidOn` replaced (or removed), without ever setting the key to undefined. */
function withPaidOn(invoice: Invoice, paidOn: CalendarDate | undefined): Invoice {
  const { paidOn: _ignored, ...rest } = invoice;
  void _ignored;
  const copy: Invoice = { ...rest };
  if (paidOn !== undefined) copy.paidOn = paidOn;
  return copy;
}

/**
 * Covered invoice + `today` + a `paidOn` placed deliberately around the deadline, `today`,
 * the Due_Date and `acceptedOn` (offsets -3..+3, and wider), so every row of the status table
 * is reached: unpaid, paid before/after the deadline, paid before/after `today`. The
 * invoice's own generated `paidOn` is kept in one branch. Extra weight goes to the
 * 15 Feb to 31 Mar acceptance window where the Due_Date is after the Tax_Bomb_Date.
 */
const arbPaymentScenario: fc.Arbitrary<readonly [Invoice, CalendarDate]> = fc
  .oneof(
    { weight: 3, arbitrary: arbCoveredInvoice },
    { weight: 2, arbitrary: arbCoveredInvoiceNearYearEnd },
  )
  .chain((base) =>
    arbToday(base).chain((today) => {
      const { deadline, dueDate: due } = oracle(base, today);
      const anchors: readonly CalendarDate[] = [deadline, today, due, base.acceptedOn];
      const anchored = fc
        .tuple(
          fc.constantFrom(...anchors),
          fc.oneof(fc.integer({ min: -3, max: 3 }), fc.integer({ min: -400, max: 400 })),
        )
        .map(([anchor, offset]) => laterOf(shiftDays(anchor, offset), base.acceptedOn));

      return fc
        .oneof(
          { weight: 2, arbitrary: fc.constant<Invoice>(withPaidOn(base, undefined)) },
          { weight: 1, arbitrary: fc.constant<Invoice>(base) },
          { weight: 6, arbitrary: anchored.map((paidOn) => withPaidOn(base, paidOn)) },
        )
        .map((invoice): readonly [Invoice, CalendarDate] => [invoice, today]);
    }),
  );

/** Checks Property 11 for one covered invoice and one `today`. */
function checkTaxBombStatus(invoice: Invoice, today: CalendarDate): void {
  const expected = oracle(invoice, today);
  const result = taxBomb(invoice, today);

  expect(result.applicable).toBe(true);
  if (!result.applicable) return;

  expect(result.status).toBe(expected.status);
  expect(result.daysLeft).toBe(expected.daysLeft);
  expect(result.deductionAtRiskPaise).toBe(expected.deductionAtRiskPaise);
  expect(result.taxBombDate).toBe(expected.taxBombDate);
  expect(result.deductionDeadline).toBe(expected.deadline);
  expect(result.ruleIds).toContain("IT-43BH");

  if (result.status === "armed" && today >= invoice.acceptedOn) {
    expect(result.daysLeft).toBeGreaterThanOrEqual(0);
    expect(result.daysLeft).toBeLessThanOrEqual(365);
  }
}

describe("tax-bomb status oracle", () => {
  // Feature: legal-engine, Property 11: Tax bomb status oracle
  it("Property 11: Tax bomb status oracle", () => {
    // **Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.7, 5.10, 5.11, 8.2**
    fc.assert(fc.property(arbPaymentScenario, ([invoice, today]) => checkTaxBombStatus(invoice, today)));
  });

  // Feature: legal-engine, Property 11: Tax bomb status oracle
  it("Property 11: generated scenarios reach every row of the status table", () => {
    // **Validates: Requirements 5.2, 5.3, 5.4, 5.11**
    const samples = fc.sample(arbPaymentScenario, { numRuns: 3000 });
    const seen = new Set<string>();
    for (const [invoice, today] of samples) {
      const o = oracle(invoice, today);
      seen.add(o.row);
      if (invoice.paidOn !== undefined) {
        seen.add(invoice.paidOn <= today ? "paidOn<=today" : "paidOn>today");
        seen.add(invoice.paidOn <= o.deadline ? "paidOn<=deadline" : "paidOn>deadline");
      }
      if (o.row === "armed_unpaid" && o.dueDate > o.taxBombDate) seen.add("armed_due_after_tax_bomb");
    }
    for (const key of [
      "defused",
      "exploded_paid_late",
      "armed_unpaid",
      "exploded_unpaid",
      "paidOn<=today",
      "paidOn>today",
      "paidOn<=deadline",
      "paidOn>deadline",
      "armed_due_after_tax_bomb",
    ]) {
      expect(seen.has(key), `scenario ${key} never generated`).toBe(true);
    }
  });

  // Feature: legal-engine, Property 11: Tax bomb status oracle
  it("Property 11: 15 Feb to 31 Mar acceptance, Due_Date after 31 March, armed until the Due_Date (Req 5.5)", () => {
    // **Validates: Requirements 5.5, 5.10**
    const arbUnpaidInWindow = arbCoveredInvoiceNearYearEnd.chain((invoice) => {
      const unpaid = withPaidOn(invoice, undefined);
      const due = expectedDueDate(unpaid);
      const span = daysBetween(unpaid.acceptedOn, due);
      return fc
        .oneof(
          { weight: 3, arbitrary: fc.integer({ min: 0, max: span }) },
          { weight: 1, arbitrary: fc.constantFrom(0, span - 1, span) },
        )
        .map((offset): readonly [Invoice, CalendarDate] => [unpaid, shiftDays(unpaid.acceptedOn, Math.max(0, offset))]);
    });

    fc.assert(
      fc.property(arbUnpaidInWindow, ([invoice, today]) => {
        const acceptedMonthDay = invoice.acceptedOn.slice(5);
        expect(acceptedMonthDay >= "02-15" && acceptedMonthDay <= "03-31").toBe(true);

        const due = expectedDueDate(invoice);
        const taxBombDate = expectedTaxBombDate(invoice.acceptedOn);
        expect(due > taxBombDate).toBe(true);
        expect(today <= due).toBe(true);

        const result = taxBomb(invoice, today);
        expect(result.applicable).toBe(true);
        if (!result.applicable) return;
        expect(result.taxBombDate).toBe(taxBombDate);
        expect(result.deductionDeadline).toBe(due);
        expect(result.status).toBe("armed");
        expect(result.daysLeft).toBe(daysBetween(today, due));
        expect(result.deductionAtRiskPaise).toBe(invoice.amountPaise);
        expect(result.ruleIds).toContain("IT-43BH");
      }),
    );
  });
});
