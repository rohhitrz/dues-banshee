import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { GraveyardInvoiceRecord, Supplier } from "@dues-banshee/db";
import {
  LADDER_STEPS,
  fromEpochDay,
  hasActivePromise,
  type BankRate,
  type EscalationEvent,
  type Invoice,
  type SupplierActivity,
  type SupplierCategory,
} from "@dues-banshee/engine";
import { buildGraveyard, type GraveyardView, type TombstoneView } from "@/lib/graveyard/build-graveyard";
import { tombstoneLook } from "@/lib/graveyard/look";

// Feature: dashboard-ui, Property 8: Tombstone look encodes the data monotonically
// **Validates: Requirements 5.11, 5.12**

const MS_PER_DAY = 86_400_000;

/** Days since 1970-01-01 for a valid YYYY-MM-DD string. Test-local, independent of the code under test. */
function dayNumber(date: string): number {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / MS_PER_DAY;
}

const FIRST_DAY = dayNumber("2024-01-01");
const LAST_DAY = dayNumber("2027-12-31");

const SUPPLIER: Supplier = {
  id: "supplier-1",
  name: "Test Supplier",
  supplierCategory: "micro",
  supplierActivity: "manufacturing",
  udyamNumber: "UDYAM-XX-00-0000000",
};

const BUYERS = ["Sharma Traders", "Gupta Steel", "Patel Industries", "Mehta Polymers"] as const;
const INVOICE_NUMBERS = ["INV-001", "INV-002", "LPC/26-27/0412", "A-17", "TX9"] as const;

/** Days overdue worth hitting exactly: not due, due today, and either side of the 45 and 60 day thresholds. */
const BOUNDARY_OVERDUE = [-1, 0, 1, 15, 16, 44, 45, 46, 59, 60, 61, 90, 91] as const;

const arbBankRate: fc.Arbitrary<BankRate | null> = fc.option(
  fc.record({
    annualBps: fc.integer({ min: 0, max: 5000 }),
    // The builder only echoes `asOf`; any valid date is fine.
    asOf: fc.integer({ min: FIRST_DAY - 400, max: LAST_DAY }).map(fromEpochDay),
  }),
  { nil: null },
);

/** Mostly covered suppliers so overdue days show up; the rest exercise the not-covered path (0 days). */
const arbCategory: fc.Arbitrary<SupplierCategory> = fc.oneof(
  { weight: 8, arbitrary: fc.constantFrom<SupplierCategory>("micro", "small") },
  { weight: 1, arbitrary: fc.constantFrom<SupplierCategory>("medium", "unregistered") },
);
const arbActivity: fc.Arbitrary<SupplierActivity> = fc.oneof(
  { weight: 8, arbitrary: fc.constantFrom<SupplierActivity>("manufacturing", "services") },
  { weight: 1, arbitrary: fc.constant<SupplierActivity>("trading") },
);

/** A small pool is drawn from often so that equal principals occur. */
const arbAmountPaise: fc.Arbitrary<number> = fc.oneof(
  { weight: 2, arbitrary: fc.constantFrom(100, 500_000, 41_200_000) },
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 1_000_000_000 }) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 1_00_000_00_00_000 }) },
);

const arbOverdue: fc.Arbitrary<number> = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...BOUNDARY_OVERDUE) },
  { weight: 2, arbitrary: fc.integer({ min: -20, max: 400 }) },
);

interface InvoiceDraft {
  amountPaise: number;
  term: number | undefined;
  overdue: number;
  category: SupplierCategory;
  activity: SupplierActivity;
  udyamOffset: number | undefined;
  /** undefined = unpaid; otherwise paid on today + offset (clamped to acceptedOn). */
  paidOffset: number | undefined;
  buyerName: string;
  invoiceNumber: string;
}

const arbDraft: fc.Arbitrary<InvoiceDraft> = fc.record({
  amountPaise: arbAmountPaise,
  term: fc.option(fc.integer({ min: 1, max: 60 }), { nil: undefined }),
  overdue: arbOverdue,
  category: arbCategory,
  activity: arbActivity,
  udyamOffset: fc.option(fc.integer({ min: -400, max: 400 }), { nil: undefined }),
  // Offsets -3..3 straddle "paid today" and "paid tomorrow".
  paidOffset: fc.option(
    fc.oneof(fc.integer({ min: -3, max: 3 }), fc.integer({ min: -60, max: 60 })),
    { nil: undefined },
  ),
  buyerName: fc.constantFrom(...BUYERS),
  invoiceNumber: fc.constantFrom(...INVOICE_NUMBERS),
});

type EventDraft =
  | { kind: "step"; stepIndex: number; onOffset: number }
  | { kind: "promise"; promisedOffset: number; amountPaise: number; recordedOffset: number };

const arbEventDraft: fc.Arbitrary<EventDraft> = fc.oneof(
  fc.record({
    kind: fc.constant("step" as const),
    stepIndex: fc.integer({ min: 0, max: LADDER_STEPS.length - 1 }),
    onOffset: fc.integer({ min: -60, max: 0 }),
  }),
  // Promised dates fall on both sides of today; -1, 0 and 1 are the boundary.
  fc.record({
    kind: fc.constant("promise" as const),
    promisedOffset: fc.oneof(fc.constantFrom(-1, 0, 1), fc.integer({ min: -30, max: 30 })),
    amountPaise: fc.integer({ min: 1, max: 100_000_000 }),
    recordedOffset: fc.integer({ min: -60, max: 0 }),
  }),
);

interface Scenario {
  today: string;
  bankRate: BankRate | null;
  records: GraveyardInvoiceRecord[];
}

function toRecord(draft: InvoiceDraft, events: EventDraft[], index: number, todayDay: number): GraveyardInvoiceRecord {
  const effectiveTerm = Math.min(draft.term ?? 15, 45);
  const acceptedDay = todayDay - draft.overdue - effectiveTerm;
  const acceptedOn = fromEpochDay(acceptedDay);

  const invoice: Invoice = {
    id: `inv-${index}`,
    amountPaise: draft.amountPaise,
    acceptedOn,
    supplierCategory: draft.category,
    supplierActivity: draft.activity,
    ...(draft.term === undefined ? {} : { agreedTermDays: draft.term }),
    ...(draft.udyamOffset === undefined ? {} : { udyamRegisteredOn: fromEpochDay(acceptedDay + draft.udyamOffset) }),
    ...(draft.paidOffset === undefined
      ? {}
      : { paidOn: fromEpochDay(Math.max(acceptedDay, todayDay + draft.paidOffset)) }),
  };

  const history: EscalationEvent[] = events.map((e) =>
    e.kind === "step"
      ? { kind: "step", step: LADDER_STEPS[e.stepIndex] ?? "whatsapp_nudge", on: fromEpochDay(todayDay + e.onOffset) }
      : {
          kind: "promise",
          promisedDate: fromEpochDay(todayDay + e.promisedOffset),
          amountPaise: e.amountPaise,
          recordedOn: fromEpochDay(todayDay + e.recordedOffset),
        },
  );

  return {
    invoice,
    buyerName: draft.buyerName,
    invoiceNumber: draft.invoiceNumber,
    history,
    buyerId: `buyer-${draft.buyerName}`,
    invoiceDate: invoice.acceptedOn,
  };
}

const arbScenario: fc.Arbitrary<Scenario> = fc
  .record({
    todayDay: fc.integer({ min: FIRST_DAY, max: LAST_DAY }),
    bankRate: arbBankRate,
    items: fc.array(fc.record({ draft: arbDraft, events: fc.array(arbEventDraft, { maxLength: 4 }) }), {
      minLength: 0,
      maxLength: 10,
    }),
  })
  .map(({ todayDay, bankRate, items }) => ({
    today: fromEpochDay(todayDay),
    bankRate,
    // Index in the id keeps ids unique, as the Engine and the sort tie-break require.
    records: items.map((item, i) => toRecord(item.draft, item.events, i, todayDay)),
  }));

function build({ today, bankRate, records }: Scenario): GraveyardView {
  return buildGraveyard(SUPPLIER, records, bankRate, today);
}

const RUNS = { numRuns: 100 };

describe("Property 8: Tombstone look encodes the data monotonically", () => {
  it("height never shrinks as principal grows, equal principals share a height, heights are integers in [130, 300]", () => {
    fc.assert(
      fc.property(arbScenario, (scenario) => {
        const { tombstones } = build(scenario);
        for (const a of tombstones) {
          expect(Number.isInteger(a.look.heightPx)).toBe(true);
          expect(a.look.heightPx).toBeGreaterThanOrEqual(130);
          expect(a.look.heightPx).toBeLessThanOrEqual(300);
          for (const b of tombstones) {
            if (a.principalPaise > b.principalPaise) expect(a.look.heightPx).toBeGreaterThanOrEqual(b.look.heightPx);
            if (a.principalPaise === b.principalPaise) expect(a.look.heightPx).toBe(b.look.heightPx);
          }
        }
      }),
      RUNS,
    );
  });

  it("moss is 0 iff Days_Overdue is 0 and never decreases as Days_Overdue grows", () => {
    fc.assert(
      fc.property(arbScenario, (scenario) => {
        const { tombstones } = build(scenario);
        for (const a of tombstones) {
          expect(a.look.moss === 0).toBe(a.daysOverdue === 0);
          for (const b of tombstones) {
            if (a.daysOverdue >= b.daysOverdue) expect(a.look.moss).toBeGreaterThanOrEqual(b.look.moss);
          }
        }
      }),
      RUNS,
    );
  });

  it("cracked iff Days_Overdue > 60, and ember iff Days_Overdue > 45", () => {
    fc.assert(
      fc.property(arbScenario, (scenario) => {
        for (const t of build(scenario).tombstones) {
          expect(t.look.cracked).toBe(t.daysOverdue > 60);
          expect(t.look.ember).toBe(t.daysOverdue > 45);
        }
      }),
      RUNS,
    );
  });

  it("wisp iff the record is unpaid on today and its history holds a promise dated today or later", () => {
    fc.assert(
      fc.property(arbScenario, (scenario) => {
        const byId = new Map(scenario.records.map((r) => [r.invoice.id, r]));
        for (const t of build(scenario).tombstones) {
          const record = byId.get(t.id);
          expect(record).toBeDefined();
          if (record === undefined) continue;
          const { paidOn } = record.invoice;
          const unpaidOnToday = paidOn === undefined || paidOn > scenario.today;
          const promisedOnOrAfterToday = record.history.some(
            (e) => e.kind === "promise" && e.promisedDate >= scenario.today,
          );
          expect(t.look.wisp).toBe(unpaidOnToday && promisedOnOrAfterToday);
        }
      }),
      RUNS,
    );
  });

  it("the generator reaches the boundaries the properties depend on", () => {
    const tombstones: TombstoneView[] = fc
      .sample(arbScenario, { numRuns: 300, seed: 8 })
      .flatMap((scenario) => [...build(scenario).tombstones]);
    const days = new Set(tombstones.map((t) => t.daysOverdue));
    for (const d of [0, 45, 46, 60, 61]) expect(days.has(d)).toBe(true);
    expect(tombstones.some((t) => t.look.wisp)).toBe(true);
    expect(tombstones.some((t) => !t.look.wisp)).toBe(true);
    expect(tombstones.some((t) => t.state === "resurrected")).toBe(true);
    expect(tombstones.some((t) => t.look.cracked && t.look.ember)).toBe(true);
  });
});

// Feature: debtor-ui, Property 3: Wisp is "unpaid and active promise"
// **Validates: Requirements 6.2**
describe("Property 3: Wisp is \"unpaid and active promise\"", () => {
  const arbDay = fc.integer({ min: FIRST_DAY, max: LAST_DAY }).map(fromEpochDay);
  const arbEvent: fc.Arbitrary<EscalationEvent> = fc.oneof(
    fc.record({
      kind: fc.constant("step" as const),
      step: fc.constantFrom(...LADDER_STEPS),
      on: arbDay,
    }),
    fc.record({
      kind: fc.constant("promise" as const),
      promisedDate: arbDay,
      amountPaise: fc.integer({ min: 1, max: 100_000_000 }),
      recordedOn: arbDay,
    }),
  );

  it("equals !paid && hasActivePromise(history, today) for any look input", () => {
    fc.assert(
      fc.property(
        fc.record({
          heightPx: fc.integer({ min: 130, max: 300 }),
          daysOverdue: fc.integer({ min: 0, max: 1000 }),
          paid: fc.boolean(),
          history: fc.array(arbEvent, { maxLength: 6 }),
          today: arbDay,
        }),
        (input) => {
          expect(tombstoneLook(input).wisp).toBe(!input.paid && hasActivePromise(input.history, input.today));
        },
      ),
      { numRuns: 100 },
    );
  });
});
