// Feature: dashboard-ui, Property 2: Views agree with the Engine
// **Validates: Requirements 3.2, 3.3, 3.4, 5.2, 5.3**
import type { GraveyardInvoiceRecord, Supplier } from "@dues-banshee/db";
import {
  LADDER_STEPS,
  SUPPLIER_ACTIVITIES,
  SUPPLIER_CATEGORIES,
  dueDate,
  formatINR,
  fromEpochDay,
  nextEscalationStep,
  statutoryInterest,
  taxBomb,
  type BankRate,
  type CalendarDate,
  type EscalationEvent,
  type Invoice,
  type NonCoverageReason,
} from "@dues-banshee/engine";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildGraveyard, type TombstoneState } from "../lib/graveyard/build-graveyard";
import { nextStepLabel } from "../lib/graveyard/labels";
import { formatDisplayDate } from "../lib/graveyard/today";

const NUM_RUNS = 100;

/** Days since 1970-01-01 of a calendar day, for building date ranges. */
function epochDay(year: number, month: number, day: number): number {
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
}

const arbDateBetween = (from: number, to: number): fc.Arbitrary<CalendarDate> =>
  fc.integer({ min: from, max: to }).map(fromEpochDay);

/** Today is in 2024..2027. */
const arbToday = arbDateBetween(epochDay(2024, 1, 1), epochDay(2027, 12, 31));

/** Bank rate: annualBps 0..5000, as-of date anywhere in 2024..2027. */
const arbBankRate: fc.Arbitrary<BankRate> = fc.record({
  annualBps: fc.integer({ min: 0, max: 5000 }),
  asOf: arbDateBetween(epochDay(2024, 1, 1), epochDay(2027, 12, 31)),
});

// Duplicated entries weight the covered (micro/small, manufacturing/services) cases.
const CATEGORIES = [
  "micro",
  "micro",
  "small",
  "small",
  "medium",
  "unregistered",
] as const satisfies readonly (typeof SUPPLIER_CATEGORIES)[number][];
const ACTIVITIES = [
  "manufacturing",
  "manufacturing",
  "services",
  "services",
  "trading",
] as const satisfies readonly (typeof SUPPLIER_ACTIVITIES)[number][];

/**
 * Amounts stay small enough that, with up to 8 records and up to 72 monthly rests at 5000 bps,
 * neither the Engine's interest nor the builder's totals leave the safe-integer range.
 */
const arbAmountPaise: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: 1, max: 100_000 }),
  fc.integer({ min: 1, max: 100_000_000_000 }),
);

const ACCEPTED_FROM = epochDay(2022, 1, 1);
const ACCEPTED_TO = epochDay(2027, 12, 31);

/** An Engine-valid invoice without its id. */
const arbInvoiceBody: fc.Arbitrary<Omit<Invoice, "id">> = fc
  .integer({ min: ACCEPTED_FROM, max: ACCEPTED_TO })
  .chain((acceptedDay) =>
    fc.record(
      {
        amountPaise: arbAmountPaise,
        acceptedOn: fc.constant(fromEpochDay(acceptedDay)),
        agreedTermDays: fc.integer({ min: 1, max: 120 }),
        supplierCategory: fc.constantFrom(...CATEGORIES),
        supplierActivity: fc.constantFrom(...ACTIVITIES),
        udyamRegisteredOn: arbDateBetween(epochDay(2018, 1, 1), epochDay(2027, 12, 31)),
        // paidOn is never before acceptedOn.
        paidOn: fc.integer({ min: 0, max: 900 }).map((offset) => fromEpochDay(acceptedDay + offset)),
      },
      { requiredKeys: ["amountPaise", "acceptedOn", "supplierCategory", "supplierActivity"] },
    ),
  );

const arbEvent: fc.Arbitrary<EscalationEvent> = fc.oneof(
  fc.record({
    kind: fc.constant("step" as const),
    step: fc.constantFrom(...LADDER_STEPS),
    on: arbDateBetween(ACCEPTED_FROM, epochDay(2028, 6, 30)),
  }),
  fc.record({
    kind: fc.constant("promise" as const),
    promisedDate: arbDateBetween(ACCEPTED_FROM, epochDay(2028, 6, 30)),
    amountPaise: fc.integer({ min: 1, max: 1_000_000_000 }),
    recordedOn: arbDateBetween(ACCEPTED_FROM, epochDay(2028, 6, 30)),
  }),
);

/** 0..8 records with unique ids (the Engine rejects empty ids; uniqueness keeps the sort total). */
const arbRecords: fc.Arbitrary<GraveyardInvoiceRecord[]> = fc
  .array(
    fc.record({
      body: arbInvoiceBody,
      buyerName: fc.string({ minLength: 1, maxLength: 12 }),
      invoiceNumber: fc.string({ minLength: 1, maxLength: 8 }),
      history: fc.array(arbEvent, { maxLength: 4 }),
    }),
    { maxLength: 8 },
  )
  .map((rows) =>
    rows.map((row, i) => ({
      invoice: { ...row.body, id: `inv-${i}` },
      buyerName: row.buyerName,
      invoiceNumber: row.invoiceNumber,
      history: row.history,
    })),
  );

const SUPPLIER: Supplier = {
  id: "supplier-1",
  name: "Test Supplier",
  udyamNumber: "UDYAM-XX-00-0000000",
  supplierCategory: "micro",
  supplierActivity: "manufacturing",
};

/** Same placeholder the builder documents for "no Bank_Rate": used only to read `accrualDays`. */
const ZERO_RATE: BankRate = { annualBps: 0, asOf: "2024-01-01" };

// Requirement 5.3 / 5.8 texts, written out here so the test does not reuse the builder's maps.
const NON_COVERAGE_TEXT: Record<NonCoverageReason, string> = {
  medium_or_unregistered: "Not a Udyam micro/small supplier",
  trader: "Trader, outside MSMED",
};

describe("Property 2: Views agree with the Engine", () => {
  it("every tombstone equals the Engine output for the same record", () => {
    fc.assert(
      fc.property(arbRecords, fc.option(arbBankRate, { nil: null }), arbToday, (records, bankRate, today) => {
        const view = buildGraveyard(SUPPLIER, records, bankRate, today);

        // Exactly the records accepted on or before Today appear, once each.
        const visible = records.filter((r) => r.invoice.acceptedOn <= today);
        expect(view.tombstones.map((t) => t.id).sort()).toEqual(visible.map((r) => r.invoice.id).sort());

        const byId = new Map(records.map((r) => [r.invoice.id, r]));
        for (const t of view.tombstones) {
          const record = byId.get(t.id);
          if (record === undefined) throw new Error(`tombstone ${t.id} matches no record`);
          const { invoice, history } = record;

          const due = dueDate(invoice);
          const bomb = taxBomb(invoice, today);
          const next = nextEscalationStep(invoice, history, today);
          const interest = statutoryInterest(invoice, today, bankRate ?? ZERO_RATE);

          // Display fields come straight from the record.
          expect(t.buyerName).toBe(record.buyerName);
          expect(t.invoiceNumber).toBe(record.invoiceNumber);

          // Due date.
          expect(t.dueDate).toBe(due.applicable ? due.dueDate : null);
          expect(t.dueDateText).toBe(due.applicable ? formatDisplayDate(due.dueDate) : null);

          // Caveat.
          expect(t.caveat).toBe(due.applicable ? (due.caveat ?? null) : null);

          // Tax bomb: status, days left, deduction at risk.
          expect(t.taxBomb).toEqual(
            bomb.applicable
              ? { status: bomb.status, daysLeft: bomb.daysLeft, deductionAtRiskPaise: bomb.deductionAtRiskPaise }
              : null,
          );

          // Interest: null without a Bank_Rate or without coverage, else the Engine figure.
          if (bankRate === null || !interest.applicable) {
            expect(t.interest).toBeNull();
          } else {
            expect(t.interest).toEqual({
              paise: interest.interestPaise,
              text: formatINR(interest.interestPaise, "full"),
            });
          }

          // Days_Overdue is the Engine accrualDays, or 0 when paid or not covered.
          const paid = invoice.paidOn !== undefined && invoice.paidOn <= today;
          expect(t.daysOverdue).toBe(paid || !interest.applicable ? 0 : interest.accrualDays);

          // Next decision.
          expect(t.next).toEqual(
            next.action === "advance"
              ? { action: "advance", step: next.step }
              : { action: "wait", reason: next.reason },
          );
          expect(t.nextLabel).toBe(nextStepLabel(next));

          // Money: text is formatINR of the paise value, and paise are safe integers.
          expect(t.principalPaise).toBe(invoice.amountPaise);
          expect(t.principalText).toBe(formatINR(invoice.amountPaise, "full"));
          expect(Number.isSafeInteger(t.principalPaise)).toBe(true);
          if (t.interest !== null) expect(Number.isSafeInteger(t.interest.paise)).toBe(true);
          if (t.taxBomb !== null) expect(Number.isSafeInteger(t.taxBomb.deductionAtRiskPaise)).toBe(true);

          // State: first match in the precedence list.
          let expectedState: TombstoneState;
          if (paid) expectedState = "resurrected";
          else if (!due.applicable) expectedState = "not_covered";
          else if (today <= due.dueDate) expectedState = "not_due";
          else if (bomb.status === "exploded") expectedState = "exploded";
          else if (bomb.status === "armed") expectedState = "armed";
          else expectedState = "overdue";
          expect(t.state).toBe(expectedState);

          // State text (Requirement 5.3) and the rule id beside it.
          let expectedText: string;
          switch (expectedState) {
            case "not_due":
              expectedText = "Not due yet";
              break;
            case "overdue":
              expectedText = "Overdue, interest accruing";
              break;
            case "armed":
              expectedText = `Tax bomb armed: ${bomb.applicable ? bomb.daysLeft : 0} days left to 31 March`;
              break;
            case "exploded":
              expectedText = "Tax bomb exploded";
              break;
            case "resurrected":
              expectedText = "Resurrected (paid)";
              break;
            case "not_covered":
              expectedText = `Outside MSMED (${due.applicable ? "" : NON_COVERAGE_TEXT[due.reason]})`;
              break;
          }
          expect(t.stateText).toBe(expectedText);
          expect(t.stateRuleId).toBe(
            expectedState === "armed" || expectedState === "exploded"
              ? "IT-43BH"
              : expectedState === "not_covered"
                ? "MSMED-SCOPE"
                : null,
          );
          expect(t.ariaLabel).toBe(`${record.buyerName}, ${t.principalText}, ${t.daysOverdue} days overdue, ${t.stateText}`);
        }

        // Totals are safe integers.
        expect(Number.isSafeInteger(view.totals.outstandingPaise)).toBe(true);
        expect(Number.isSafeInteger(view.totals.deductionsAtRiskPaise)).toBe(true);
        if (view.totals.interestAccruedPaise !== null) {
          expect(Number.isSafeInteger(view.totals.interestAccruedPaise)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("exercises covered, not-covered, paid and unpaid cases across the generator", () => {
    const seen = new Set<TombstoneState>();
    fc.assert(
      fc.property(arbRecords, fc.option(arbBankRate, { nil: null }), arbToday, (records, bankRate, today) => {
        for (const t of buildGraveyard(SUPPLIER, records, bankRate, today).tombstones) seen.add(t.state);
      }),
      { numRuns: 300 },
    );
    expect(seen.has("resurrected")).toBe(true);
    expect(seen.has("not_covered")).toBe(true);
    expect(seen.has("not_due")).toBe(true);
    expect(seen.has("armed") || seen.has("exploded")).toBe(true);
  });
});
