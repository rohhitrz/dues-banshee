import type { GraveyardInvoiceRecord, Supplier } from "@dues-banshee/db";
import {
  LADDER_STEPS,
  MAX_PAISE,
  SUPPLIER_ACTIVITIES,
  SUPPLIER_CATEGORIES,
  fromEpochDay,
  type BankRate,
  type CalendarDate,
  type EscalationEvent,
  type Invoice,
} from "@dues-banshee/engine";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildGraveyard } from "../lib/graveyard/build-graveyard";

// Feature: dashboard-ui, Property 1: Builder is deterministic and non-mutating
// **Validates: Requirements 3.1, 3.6**

const MS_PER_DAY = 86_400_000;
const epochDayOf = (year: number, month: number, day: number): number =>
  Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY);

/** A real calendar day between two epoch days (inclusive). Built by the Engine, so always valid. */
const arbDateBetween = (minDay: number, maxDay: number): fc.Arbitrary<CalendarDate> =>
  fc.integer({ min: minDay, max: maxDay }).map(fromEpochDay);

const TODAY_MIN = epochDayOf(2024, 1, 1);
const TODAY_MAX = epochDayOf(2027, 12, 31);
/** Invoices span a wider window than `today`, so some are accepted after today and some long before. */
const DATA_MIN = epochDayOf(2022, 1, 1);
const DATA_MAX = epochDayOf(2028, 6, 30);

const arbToday = arbDateBetween(TODAY_MIN, TODAY_MAX);
const arbAnyDate = arbDateBetween(DATA_MIN, DATA_MAX);

const arbBankRate: fc.Arbitrary<BankRate | null> = fc.option(
  fc.record(
    {
      annualBps: fc.integer({ min: 0, max: 5000 }),
      asOf: arbDateBetween(TODAY_MIN, TODAY_MAX),
    },
    { noNullPrototype: true },
  ),
  { nil: null },
);

const arbSupplier: fc.Arbitrary<Supplier> = fc.record(
  {
    id: fc.constant("supplier-1"),
    name: fc.string({ minLength: 1, maxLength: 20 }),
    udyamNumber: fc.constant("UDYAM-MH-01-0000001"),
    supplierCategory: fc.constantFrom(...SUPPLIER_CATEGORIES),
    supplierActivity: fc.constantFrom(...SUPPLIER_ACTIVITIES),
    udyamRegisteredOn: arbAnyDate,
  },
  { requiredKeys: ["id", "name", "udyamNumber", "supplierCategory", "supplierActivity"], noNullPrototype: true },
);

const arbStepEvent: fc.Arbitrary<EscalationEvent> = fc.record(
  { kind: fc.constant("step" as const), step: fc.constantFrom(...LADDER_STEPS), on: arbAnyDate },
  { noNullPrototype: true },
);

const arbPromiseEvent: fc.Arbitrary<EscalationEvent> = fc.record(
  {
    kind: fc.constant("promise" as const),
    promisedDate: arbAnyDate,
    amountPaise: fc.integer({ min: 1, max: 1_000_000_000 }),
    recordedOn: arbAnyDate,
  },
  { noNullPrototype: true },
);

const arbHistory = fc.array(fc.oneof(arbStepEvent, arbPromiseEvent), { maxLength: 6 });

/** Amounts: small, mid-range, and up to the Engine's MAX_PAISE (₹1,000 crore). */
const arbAmountPaise = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 100_000_000 }) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: MAX_PAISE }) },
);

/** The fields of one record that do not depend on the supplier or the record's position. */
const arbRecordBody = fc.record(
  {
    amountPaise: arbAmountPaise,
    acceptedOn: arbAnyDate,
    agreedTermDays: fc.integer({ min: 1, max: 120 }),
    paidDays: fc.integer({ min: 0, max: 400 }),
    buyerName: fc.string({ minLength: 1, maxLength: 20 }),
    invoiceNumber: fc.constantFrom("A-1", "A-2", "B/26/7", "LPC/26-27/0301", "a-1"),
    history: arbHistory,
  },
  { requiredKeys: ["amountPaise", "acceptedOn", "buyerName", "invoiceNumber", "history"], noNullPrototype: true },
);

/**
 * 0–8 Engine-valid records for `supplier`. Ids are `inv-<index>` (unique, non-empty); invoice numbers repeat
 * on purpose so the sort tie-breaks are exercised. `paidOn` is `acceptedOn + paidDays`, so never earlier.
 */
const arbRecords = (supplier: Supplier): fc.Arbitrary<GraveyardInvoiceRecord[]> =>
  fc.array(arbRecordBody, { maxLength: 8 }).map((bodies) =>
    bodies.map((body, i): GraveyardInvoiceRecord => {
      const acceptedDay = epochDayOf(
        Number(body.acceptedOn.slice(0, 4)),
        Number(body.acceptedOn.slice(5, 7)),
        Number(body.acceptedOn.slice(8, 10)),
      );
      const invoice: Invoice = {
        id: `inv-${i}`,
        amountPaise: body.amountPaise,
        acceptedOn: body.acceptedOn,
        supplierCategory: supplier.supplierCategory,
        supplierActivity: supplier.supplierActivity,
        ...(body.agreedTermDays === undefined ? {} : { agreedTermDays: body.agreedTermDays }),
        ...(supplier.udyamRegisteredOn === undefined ? {} : { udyamRegisteredOn: supplier.udyamRegisteredOn }),
        ...(body.paidDays === undefined ? {} : { paidOn: fromEpochDay(acceptedDay + body.paidDays) }),
      };
      return {
        invoice,
        buyerName: body.buyerName,
        invoiceNumber: body.invoiceNumber,
        history: body.history,
      };
    }),
  );

const arbInputs = arbSupplier.chain((supplier) =>
  fc.record(
    { supplier: fc.constant(supplier), records: arbRecords(supplier), bankRate: arbBankRate, today: arbToday },
    { noNullPrototype: true },
  ),
);

describe("buildGraveyard determinism and purity (Property 1)", () => {
  it("returns deeply equal views for structurally equal arguments and never mutates them", () => {
    fc.assert(
      fc.property(arbInputs, ({ supplier, records, bankRate, today }) => {
        const before = structuredClone({ supplier, records, bankRate, today });
        const copy = structuredClone({ supplier, records, bankRate, today });

        const first = buildGraveyard(supplier, records, bankRate, today);

        // Non-mutating: the arguments are structurally what they were before the call.
        expect({ supplier, records, bankRate, today }).toStrictEqual(before);

        const second = buildGraveyard(copy.supplier, copy.records, copy.bankRate, copy.today);

        // Deterministic: equal arguments give equal views.
        expect(second).toStrictEqual(first);
        // The second call did not mutate its (cloned) arguments either.
        expect(copy).toStrictEqual(before);
      }),
      { numRuns: 100 },
    );
  });

  it("returns an equal view when called twice on the very same arguments", () => {
    fc.assert(
      fc.property(arbInputs, ({ supplier, records, bankRate, today }) => {
        const first = buildGraveyard(supplier, records, bankRate, today);
        const second = buildGraveyard(supplier, records, bankRate, today);
        expect(second).toStrictEqual(first);
      }),
      { numRuns: 100 },
    );
  });
});
