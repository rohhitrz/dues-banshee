// Feature: dashboard-ui, Property 9: Aria-label shape
// **Validates: Requirements 10.3, 5.3**
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
import { buildGraveyard, type TombstoneView } from "../lib/graveyard/build-graveyard";

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

/** Small and large principals, so both short and long `formatINR` outputs are covered. */
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
  // Weighted toward covered suppliers so every state is reachable; all categories and activities still
  // appear, so `not_covered` (medium, unregistered, trading) is generated too.
  category: fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom("micro", "small") },
    { weight: 1, arbitrary: fc.constantFrom(...SUPPLIER_CATEGORIES) },
  ),
  activity: fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom("manufacturing", "services") },
    { weight: 1, arbitrary: fc.constantFrom(...SUPPLIER_ACTIVITIES) },
  ),
  registeredShift: fc.option(fc.integer({ min: -400, max: 400 }), { nil: undefined }),
  // paidAfter >= 0 keeps `paidOn >= acceptedOn`, as the Engine requires. Some invoices stay unpaid.
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
      return { invoice, buyerName: s.buyerName, invoiceNumber: s.invoiceNumber, history };
    }),
  }));

/** Requirement 5.3 state texts, written out as literals. The `armed` and `not_covered` forms are patterns. */
const FIXED_STATE_TEXT = {
  not_due: "Not due yet",
  overdue: "Overdue, interest accruing",
  exploded: "Tax bomb exploded",
  resurrected: "Resurrected (paid)",
} as const;

/** The reason text the Engine's non-coverage reason maps to, derived from the input invoice alone. */
function expectedOutsideText(invoice: Invoice): string {
  // Category is checked before activity (packages/engine/src/coverage.ts).
  const reason =
    invoice.supplierCategory === "medium" || invoice.supplierCategory === "unregistered"
      ? "Not a Udyam micro/small supplier"
      : "Trader, outside MSMED";
  return `Outside MSMED (${reason})`;
}

function expectedStateText(t: TombstoneView, invoice: Invoice): string {
  switch (t.state) {
    case "armed":
      return `Tax bomb armed: ${t.taxBomb?.daysLeft} days left to 31 March`;
    case "not_covered":
      return expectedOutsideText(invoice);
    default:
      return FIXED_STATE_TEXT[t.state];
  }
}

describe("Property 9: Aria-label shape", () => {
  it("ariaLabel is '<buyer>, <principal>, <days> days overdue, <state text>' with a Requirement 5.3 state text", () => {
    fc.assert(
      fc.property(arbScenario, ({ today, bankRate, records }) => {
        const view = buildGraveyard(SUPPLIER, records, bankRate, today);
        const byId = new Map(records.map((r) => [r.invoice.id, r]));

        for (const t of view.tombstones) {
          const record = byId.get(t.id);
          expect(record).toBeDefined();
          if (record === undefined) continue;
          const { invoice } = record;

          // Label shape, in the order of Requirement 10.3.
          expect(t.ariaLabel).toBe(`${t.buyerName}, ${t.principalText}, ${t.daysOverdue} days overdue, ${t.stateText}`);
          expect(t.buyerName).toBe(record.buyerName);

          // stateText is one of the Requirement 5.3 forms and matches the view's state.
          expect(t.stateText).toBe(expectedStateText(t, invoice));
          if (t.state === "armed") {
            expect(t.taxBomb).not.toBeNull();
            expect(Number.isInteger(t.taxBomb?.daysLeft)).toBe(true);
          }

          // The state agrees with facts readable from the input, not only with the text.
          const paid = invoice.paidOn !== undefined && invoice.paidOn <= today;
          const covered =
            invoice.supplierCategory !== "medium" &&
            invoice.supplierCategory !== "unregistered" &&
            invoice.supplierActivity !== "trading";
          expect(t.state === "resurrected").toBe(paid);
          expect(t.state === "not_covered").toBe(!paid && !covered);
          if (t.state === "not_due") expect(today <= (t.dueDate ?? "")).toBe(true);
          if (t.state === "overdue" || t.state === "armed" || t.state === "exploded") {
            expect(covered && !paid && today > (t.dueDate ?? "9999-12-31")).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
