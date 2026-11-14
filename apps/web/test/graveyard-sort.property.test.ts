import type { GraveyardInvoiceRecord, Supplier } from "@dues-banshee/db";
import type {
  BankRate,
  EscalationEvent,
  Invoice,
  LadderStep,
  SupplierActivity,
  SupplierCategory,
} from "@dues-banshee/engine";
import fc from "fast-check";
import { describe, it, expect } from "vitest";
import { buildGraveyard, type TombstoneView } from "@/lib/graveyard/build-graveyard";

// Feature: dashboard-ui, Property 3: Sort order is a function of the set, not the input order
// **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6**

// ---------------------------------------------------------------------------
// Dates. Epoch-day arithmetic keeps every generated date a real calendar day.
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;
const TODAY_MIN = Date.UTC(2024, 0, 1) / MS_PER_DAY;
const TODAY_MAX = Date.UTC(2027, 11, 31) / MS_PER_DAY;

function dateOf(epochDay: number): string {
  return new Date(epochDay * MS_PER_DAY).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Generators (inline, self-contained). Values come from small pools often, so records share days left,
// due dates, days overdue and invoice numbers; ids stay unique.
// ---------------------------------------------------------------------------

const SUPPLIER: Supplier = {
  id: "supplier-1",
  name: "Test Supplier",
  udyamNumber: "UDYAM-XX-00-0000000",
  supplierCategory: "micro",
  supplierActivity: "manufacturing",
};

/** Mixed case, digits and punctuation, so code-unit order and locale order disagree. */
const INVOICE_NUMBERS: readonly string[] = [
  "INV-1",
  "inv-1",
  "Inv-1",
  "INV-10",
  "INV-2",
  "a-1",
  "B-1",
  "Z-9",
  "_x",
  "LPC/26-27/0412",
];

const ID_UNIT = fc.constantFrom("a", "A", "b", "B", "0", "1", "_", "-");
const arbIds = fc.uniqueArray(fc.string({ unit: ID_UNIT, minLength: 1, maxLength: 3 }), {
  minLength: 0,
  maxLength: 12,
});

const arbCategory: fc.Arbitrary<SupplierCategory> = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom<SupplierCategory>("micro", "small") },
  { weight: 1, arbitrary: fc.constantFrom<SupplierCategory>("medium", "unregistered") },
);

const arbActivity: fc.Arbitrary<SupplierActivity> = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom<SupplierActivity>("manufacturing", "services") },
  { weight: 1, arbitrary: fc.constant<SupplierActivity>("trading") },
);

/** Offset in days, often from a small pool so values repeat across records. */
const pooledOffset = (pool: readonly number[], min: number, max: number): fc.Arbitrary<number> =>
  fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom(...pool) },
    { weight: 1, arbitrary: fc.integer({ min, max }) },
  );

function arbEvent(today: number): fc.Arbitrary<EscalationEvent> {
  const step = fc.record({
    kind: fc.constant("step" as const),
    step: fc.constantFrom<LadderStep>("whatsapp_nudge", "whatsapp_paylink", "voice_call", "legal_notice", "odr_pack"),
    on: fc.integer({ min: -60, max: 10 }).map((d) => dateOf(today + d)),
  });
  const promise = fc.record({
    kind: fc.constant("promise" as const),
    promisedDate: fc.integer({ min: -30, max: 60 }).map((d) => dateOf(today + d)),
    amountPaise: fc.integer({ min: 1, max: 1_000_000 }),
    recordedOn: fc.integer({ min: -60, max: 0 }).map((d) => dateOf(today + d)),
  });
  return fc.oneof(step, promise);
}

function arbRecord(id: string, today: number): fc.Arbitrary<GraveyardInvoiceRecord> {
  return fc
    .record({
      acceptedOffset: pooledOffset([-900, -400, -120, -60, -30, -10, 0], -1100, 20),
      agreedTermDays: fc.oneof(
        { weight: 3, arbitrary: fc.constantFrom<number | undefined>(undefined, 15, 30, 45) },
        { weight: 1, arbitrary: fc.integer({ min: 1, max: 90 }) },
      ),
      supplierCategory: arbCategory,
      supplierActivity: arbActivity,
      registeredOffset: fc.option(fc.constantFrom(-100, 0, 50), { nil: undefined }),
      paidAfter: fc.oneof(
        { weight: 3, arbitrary: fc.constant<number | undefined>(undefined) },
        { weight: 1, arbitrary: pooledOffset([0, 10, 30, 100], 0, 800) },
      ),
      amountPaise: fc.integer({ min: 1, max: 50_000_000 }),
      invoiceNumber: fc.constantFrom(...INVOICE_NUMBERS),
      buyerName: fc.constantFrom("Sharma Traders", "Kumar Textiles", "Gupta Works"),
      history: fc.array(arbEvent(today), { maxLength: 3 }),
    })
    .map((r): GraveyardInvoiceRecord => {
      const acceptedEpoch = today + r.acceptedOffset;
      const invoice: Invoice = {
        id,
        amountPaise: r.amountPaise,
        acceptedOn: dateOf(acceptedEpoch),
        supplierCategory: r.supplierCategory,
        supplierActivity: r.supplierActivity,
        ...(r.agreedTermDays === undefined ? {} : { agreedTermDays: r.agreedTermDays }),
        ...(r.registeredOffset === undefined ? {} : { udyamRegisteredOn: dateOf(acceptedEpoch + r.registeredOffset) }),
        ...(r.paidAfter === undefined ? {} : { paidOn: dateOf(acceptedEpoch + r.paidAfter) }),
      };
      return {
        invoice,
        buyerName: r.buyerName,
        invoiceNumber: r.invoiceNumber,
        history: r.history,
        buyerId: `buyer-${r.buyerName}`,
        invoiceDate: invoice.acceptedOn,
      };
    });
}

interface Scenario {
  today: string;
  bankRate: BankRate | null;
  records: GraveyardInvoiceRecord[];
  permuted: GraveyardInvoiceRecord[];
}

const arbScenario: fc.Arbitrary<Scenario> = fc
  .record({
    today: fc.integer({ min: TODAY_MIN, max: TODAY_MAX }),
    bankRateBps: fc.option(fc.integer({ min: 0, max: 5000 }), { nil: null }),
    bankRateAsOfOffset: fc.integer({ min: -400, max: 0 }),
    ids: arbIds,
  })
  .chain(({ today, bankRateBps, bankRateAsOfOffset, ids }) =>
    fc.tuple(...ids.map((id) => arbRecord(id, today))).chain((records) =>
      fc.shuffledSubarray(records, { minLength: records.length, maxLength: records.length }).map(
        (permuted): Scenario => ({
          today: dateOf(today),
          bankRate: bankRateBps === null ? null : { annualBps: bankRateBps, asOf: dateOf(today + bankRateAsOfOffset) },
          records,
          permuted,
        }),
      ),
    ),
  );

// ---------------------------------------------------------------------------
// Oracle: Requirement 6 written out independently of the builder's comparator.
// ---------------------------------------------------------------------------

/** Requirement 6.1 groups. */
function groupOf(state: TombstoneView["state"]): number {
  switch (state) {
    case "armed":
      return 0;
    case "exploded":
    case "overdue":
      return 1;
    case "not_due":
      return 2;
    case "not_covered":
      return 3;
    case "resurrected":
      return 4;
  }
}

/** Ascending by code unit for strings and by value for numbers. Never localeCompare. */
function ascending(x: string | number, y: string | number): number {
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
}

/** Negative when `a` must come before `b` under Requirement 6, positive when after, 0 when tied on every key. */
function oracleOrder(a: TombstoneView, b: TombstoneView): number {
  const groupA = groupOf(a.state);
  const groupB = groupOf(b.state);
  if (groupA !== groupB) return ascending(groupA, groupB);

  let primary = 0;
  if (groupA === 0) {
    // 6.2: armed by days left, fewest first.
    if (a.taxBomb === null || b.taxBomb === null) throw new Error("armed tombstone without tax bomb figures");
    primary = ascending(a.taxBomb.daysLeft, b.taxBomb.daysLeft);
  } else if (groupA === 1) {
    // 6.3: exploded and overdue by days overdue, most first.
    primary = ascending(b.daysOverdue, a.daysOverdue);
  } else if (groupA === 2) {
    // 6.4: not_due by due date, earliest first.
    if (a.dueDate === null || b.dueDate === null) throw new Error("not_due tombstone without a due date");
    primary = ascending(a.dueDate, b.dueDate);
  }
  if (primary !== 0) return primary;

  // 6.5: days overdue (most first), then invoice number, then id, both ascending by character code.
  return (
    ascending(b.daysOverdue, a.daysOverdue) ||
    ascending(a.invoiceNumber, b.invoiceNumber) ||
    ascending(a.id, b.id)
  );
}

describe("buildGraveyard sort order", () => {
  it("is independent of input order and follows Requirement 6 for every adjacent pair", () => {
    fc.assert(
      fc.property(arbScenario, ({ today, bankRate, records, permuted }) => {
        const original = buildGraveyard(SUPPLIER, records, bankRate, today).tombstones;
        const shuffled = buildGraveyard(SUPPLIER, permuted, bankRate, today).tombstones;

        // 6.6: same id sequence for any permutation of the same records.
        expect(shuffled.map((t) => t.id)).toEqual(original.map((t) => t.id));

        // Only records accepted on or before today are shown, each exactly once.
        const visibleIds = records.filter((r) => r.invoice.acceptedOn <= today).map((r) => r.invoice.id);
        expect([...original.map((t) => t.id)].sort()).toEqual([...visibleIds].sort());

        // 6.1–6.5: every adjacent pair is strictly ordered (ids are unique, so there are no full ties).
        for (let i = 0; i + 1 < original.length; i += 1) {
          const a = original[i];
          const b = original[i + 1];
          if (a === undefined || b === undefined) throw new Error("index out of range");
          expect(oracleOrder(a, b), `${a.id} (${a.state}) before ${b.id} (${b.state})`).toBeLessThan(0);
        }
      }),
      { numRuns: 300 },
    );
  });
});
