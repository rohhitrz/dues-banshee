// Feature: dashboard-ui, Property 5: Future-accepted invoices are invisible
// **Validates: Requirements 3.7, 8.1, 12.9**
import type { GraveyardInvoiceRecord, Supplier } from "@dues-banshee/db";
import {
  LADDER_STEPS,
  MAX_PAISE,
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

/** Epoch day to "YYYY-MM-DD". Every generated day lies in 2020..2030, so the year has four digits. */
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

type HistorySpec =
  | { kind: "step"; step: (typeof LADDER_STEPS)[number]; offset: number }
  | { kind: "promise"; promisedOffset: number; recordedOffset: number; amountPaise: number };

interface RecordSpec {
  /** Days from Today to acceptedOn. */
  acceptedOffset: number;
  amountPaise: number;
  agreedTermDays: number | undefined;
  category: Invoice["supplierCategory"];
  activity: Invoice["supplierActivity"];
  registeredShift: number | undefined;
  paidAfter: number | undefined;
  invoiceNumber: string;
  buyerName: string;
  history: readonly HistorySpec[];
}

const arbHistoryEvent: fc.Arbitrary<HistorySpec> = fc.oneof(
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

/** Everything about a record except its principal and accepted date, which each caller constrains. */
const arbRecordRest = fc.record({
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

/** Base principals: small values (ties) and large ones, capped so every total stays a safe integer. */
const arbBaseAmountPaise: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: 1, max: 1_000 }),
  fc.integer({ min: 1, max: 10_000_000_000 }),
);

/**
 * The extra record may carry any Engine-valid principal, including the extremes that would reshuffle the
 * height ranking and the sums if it leaked into the view.
 */
const arbExtraAmountPaise: fc.Arbitrary<number> = fc.oneof(
  fc.constant(1),
  fc.constant(MAX_PAISE),
  arbBaseAmountPaise,
  fc.integer({ min: 1, max: MAX_PAISE }),
);

const arbBaseSpec: fc.Arbitrary<RecordSpec> = fc
  .tuple(fc.integer({ min: -1200, max: 20 }), arbBaseAmountPaise, arbRecordRest)
  .map(([acceptedOffset, amountPaise, rest]) => ({ acceptedOffset, amountPaise, ...rest }));

/** Builds an Engine-valid record with the given id; `paidOn` and `udyamRegisteredOn` follow acceptedOn. */
function toRecord(id: string, todayDay: number, s: RecordSpec): GraveyardInvoiceRecord {
  const acceptedDay = todayDay + s.acceptedOffset;
  const invoice: Invoice = {
    id,
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
}

interface Scenario {
  today: string;
  bankRate: BankRate | null;
  records: GraveyardInvoiceRecord[];
  /** Where in the record list the extra record is inserted (0..records.length). */
  insertAt: number;
  futureExtra: GraveyardInvoiceRecord;
  todayExtra: GraveyardInvoiceRecord;
}

/**
 * Base records are `inv-<i>`; the extras use ids that cannot collide with them. `futureExtra` is accepted
 * 1..400 days after Today (at most 2029-02, inside the Engine's calendar range); `todayExtra` is accepted
 * exactly on Today.
 */
const arbScenario: fc.Arbitrary<Scenario> = fc
  .record({
    todayDay: fc.integer({ min: FIRST_TODAY, max: LAST_TODAY }),
    bankRate: fc.option(
      fc.record({ annualBps: fc.integer({ min: 0, max: 5000 }), asOfOffset: fc.integer({ min: -200, max: 0 }) }),
      { nil: null },
    ),
    specs: fc.array(arbBaseSpec, { maxLength: 8 }),
    insertSeed: fc.nat(),
    futureOffset: fc.integer({ min: 1, max: 400 }),
    futureAmount: arbExtraAmountPaise,
    futureRest: arbRecordRest,
    todayAmount: arbExtraAmountPaise,
    todayRest: arbRecordRest,
  })
  .map((r) => ({
    today: dayToDate(r.todayDay),
    bankRate:
      r.bankRate === null
        ? null
        : { annualBps: r.bankRate.annualBps, asOf: dayToDate(r.todayDay + r.bankRate.asOfOffset) },
    records: r.specs.map((s, i) => toRecord(`inv-${i}`, r.todayDay, s)),
    insertAt: r.insertSeed % (r.specs.length + 1),
    futureExtra: toRecord("extra-future", r.todayDay, {
      acceptedOffset: r.futureOffset,
      amountPaise: r.futureAmount,
      ...r.futureRest,
    }),
    todayExtra: toRecord("extra-today", r.todayDay, {
      acceptedOffset: 0,
      amountPaise: r.todayAmount,
      ...r.todayRest,
    }),
  }));

function insertAt<T>(items: readonly T[], index: number, item: T): T[] {
  return [...items.slice(0, index), item, ...items.slice(index)];
}

describe("Property 5: Future-accepted invoices are invisible", () => {
  it("adding a record accepted after Today leaves the whole view unchanged", () => {
    fc.assert(
      fc.property(arbScenario, ({ today, bankRate, records, insertAt: at, futureExtra }) => {
        // Sanity: the generator really produced a future record with an Engine-valid, unique id.
        expect(futureExtra.invoice.acceptedOn > today).toBe(true);
        expect(records.some((r) => r.invoice.id === futureExtra.invoice.id)).toBe(false);

        const without = buildGraveyard(SUPPLIER, records, bankRate, today);
        const withExtra = buildGraveyard(SUPPLIER, insertAt(records, at, futureExtra), bankRate, today);

        // Tombstones (including heights and look ranks), totals, rulesAsOf, supplierName and today.
        expect(withExtra).toStrictEqual(without);
        expect(withExtra.tombstones.some((t) => t.id === futureExtra.invoice.id)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it("a record accepted exactly on Today appears in the tombstones", () => {
    fc.assert(
      fc.property(arbScenario, ({ today, bankRate, records, insertAt: at, todayExtra }) => {
        expect(todayExtra.invoice.acceptedOn).toBe(today);

        const view = buildGraveyard(SUPPLIER, insertAt(records, at, todayExtra), bankRate, today);

        expect(view.tombstones.filter((t) => t.id === todayExtra.invoice.id)).toHaveLength(1);
      }),
      { numRuns: 100 },
    );
  });
});
