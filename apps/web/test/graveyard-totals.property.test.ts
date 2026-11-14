// Feature: dashboard-ui, Property 4: Totals are sums over the views
// **Validates: Requirements 7.1, 7.2, 7.3, 7.4, 2.5**
import type { GraveyardInvoiceRecord, Supplier } from "@dues-banshee/db";
import {
  LADDER_STEPS,
  SUPPLIER_ACTIVITIES,
  SUPPLIER_CATEGORIES,
  type BankRate,
  type EscalationEvent,
  type Invoice,
} from "@dues-banshee/engine";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildGraveyard } from "../lib/graveyard/build-graveyard";

const MS_PER_DAY = 86_400_000;
const FIRST_TODAY = Date.UTC(2024, 0, 1) / MS_PER_DAY;
const LAST_TODAY = Date.UTC(2027, 11, 31) / MS_PER_DAY;

/** Epoch day to "YYYY-MM-DD". Every generated day lies in 2020..2031, so the year has four digits. */
function dayToDate(epochDay: number): string {
  return new Date(epochDay * MS_PER_DAY).toISOString().slice(0, 10);
}

const SUPPLIER: Supplier = {
  id: "supplier-1",
  name: "Lakshmi Precision Components",
  udyamNumber: "UDYAM-MH-00-0000001",
  supplierCategory: "micro",
  supplierActivity: "manufacturing",
};

interface RecordSpec {
  acceptedOffset: number;
  amountPaise: number;
  agreedTermDays: number | undefined;
  category: Invoice["supplierCategory"];
  activity: Invoice["supplierActivity"];
  registeredShift: number | undefined;
  paidAfter: number | undefined;
  invoiceNumber: string;
  buyerName: string;
  history: readonly (
    | { kind: "step"; step: (typeof LADDER_STEPS)[number]; offset: number }
    | { kind: "promise"; promisedOffset: number; recordedOffset: number; amountPaise: number }
  )[];
}

/** Principals: small values (ties and tiny sums) and large ones, capped so every total stays a safe integer. */
const arbAmountPaise: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: 1, max: 1_000 }),
  fc.integer({ min: 1, max: 10_000_000_000 }),
);

const arbHistoryEvent = fc.oneof(
  fc.record({
    kind: fc.constant("step" as const),
    step: fc.constantFrom(...LADDER_STEPS),
    offset: fc.integer({ min: -150, max: 30 }),
  }),
  fc.record({
    kind: fc.constant("promise" as const),
    promisedOffset: fc.integer({ min: -60, max: 90 }),
    recordedOffset: fc.integer({ min: -150, max: 30 }),
    amountPaise: fc.integer({ min: 1, max: 10_000_000_000 }),
  }),
);

const arbRecordSpec: fc.Arbitrary<RecordSpec> = fc.record({
  acceptedOffset: fc.integer({ min: -1200, max: 20 }),
  amountPaise: arbAmountPaise,
  agreedTermDays: fc.option(fc.integer({ min: 1, max: 120 }), { nil: undefined }),
  // Mostly covered suppliers so every state is reachable; the other categories still appear.
  category: fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom("micro", "small") },
    { weight: 1, arbitrary: fc.constantFrom(...SUPPLIER_CATEGORIES) },
  ),
  activity: fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom("manufacturing", "services") },
    { weight: 1, arbitrary: fc.constantFrom(...SUPPLIER_ACTIVITIES) },
  ),
  registeredShift: fc.option(fc.integer({ min: -400, max: 400 }), { nil: undefined }),
  paidAfter: fc.option(fc.integer({ min: 0, max: 1300 }), { nil: undefined }),
  invoiceNumber: fc.string({ minLength: 1, maxLength: 8 }),
  buyerName: fc.string({ minLength: 1, maxLength: 12 }),
  history: fc.array(arbHistoryEvent, { maxLength: 4 }),
});

interface Scenario {
  today: string;
  bankRate: BankRate | null;
  records: GraveyardInvoiceRecord[];
}

/** Engine-valid records with unique ids, a Today in 2024..2027 and an optional bank rate of 0..5000 bps. */
const arbScenario: fc.Arbitrary<Scenario> = fc
  .record({
    todayDay: fc.integer({ min: FIRST_TODAY, max: LAST_TODAY }),
    bankRate: fc.option(
      fc.record({ annualBps: fc.integer({ min: 0, max: 5000 }), asOfOffset: fc.integer({ min: -200, max: 0 }) }),
      { nil: null },
    ),
    specs: fc.array(arbRecordSpec, { maxLength: 8 }),
  })
  .map(({ todayDay, bankRate, specs }) => ({
    today: dayToDate(todayDay),
    bankRate: bankRate === null ? null : { annualBps: bankRate.annualBps, asOf: dayToDate(todayDay + bankRate.asOfOffset) },
    records: specs.map((s, i): GraveyardInvoiceRecord => {
      const acceptedDay = todayDay + s.acceptedOffset;
      const invoice: Invoice = {
        id: `inv-${i}`,
        amountPaise: s.amountPaise,
        acceptedOn: dayToDate(acceptedDay),
        supplierCategory: s.category,
        supplierActivity: s.activity,
        ...(s.agreedTermDays === undefined ? {} : { agreedTermDays: s.agreedTermDays }),
        ...(s.registeredShift === undefined ? {} : { udyamRegisteredOn: dayToDate(acceptedDay + s.registeredShift) }),
        ...(s.paidAfter === undefined ? {} : { paidOn: dayToDate(acceptedDay + s.paidAfter) }),
      };
      const history: EscalationEvent[] = s.history.map((e) =>
        e.kind === "step"
          ? { kind: "step", step: e.step, on: dayToDate(todayDay + e.offset) }
          : {
              kind: "promise",
              promisedDate: dayToDate(todayDay + e.promisedOffset),
              recordedOn: dayToDate(todayDay + e.recordedOffset),
              amountPaise: e.amountPaise,
            },
      );
      return {
        invoice,
        buyerName: s.buyerName,
        invoiceNumber: s.invoiceNumber,
        history,
        buyerId: `buyer-${s.buyerName}`,
        invoiceDate: invoice.acceptedOn,
      };
    }),
  }));

describe("Property 4: Totals are sums over the views", () => {
  it("every total equals the sum or count taken over the returned views", () => {
    fc.assert(
      fc.property(arbScenario, ({ today, bankRate, records }) => {
        const view = buildGraveyard(SUPPLIER, records, bankRate, today);
        const { totals, tombstones } = view;

        // Oracle: integer addition over the returned views only.
        let outstanding = 0;
        let interest = 0;
        let deductions = 0;
        let exploded = 0;
        let paid = 0;
        for (const t of tombstones) {
          if (t.state !== "resurrected") outstanding += t.principalPaise;
          if (t.state === "overdue" || t.state === "armed" || t.state === "exploded") {
            interest += t.interest?.paise ?? 0;
          }
          if (t.state !== "resurrected" && t.taxBomb?.status === "armed") {
            deductions += t.taxBomb.deductionAtRiskPaise;
          }
          if (t.state === "exploded") exploded += 1;
          if (t.state === "resurrected") paid += 1;
        }

        expect(totals.outstandingPaise).toBe(outstanding);
        // Null exactly when no bank rate is given (Req 2.5), otherwise the sum.
        expect(totals.interestAccruedPaise).toBe(bankRate === null ? null : interest);
        expect(totals.deductionsAtRiskPaise).toBe(deductions);
        expect(totals.explodedCount).toBe(exploded);
        expect(totals.paidCount).toBe(paid);

        // Totals stay safe integers.
        expect(Number.isSafeInteger(totals.outstandingPaise)).toBe(true);
        expect(Number.isSafeInteger(totals.deductionsAtRiskPaise)).toBe(true);
        if (totals.interestAccruedPaise !== null) {
          expect(Number.isSafeInteger(totals.interestAccruedPaise)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});
