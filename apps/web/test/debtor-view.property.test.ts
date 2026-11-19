import type { DebtorData, DraftWithContext, GraveyardInvoiceRecord, Supplier } from "@dues-banshee/db";
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
import { buildGraveyard } from "@/lib/graveyard/build-graveyard";
import { buildDebtorView } from "@/lib/debtor/build-debtor-view";

// ---------------------------------------------------------------------------
// Shared generators (top of file so later properties in this file can reuse them).
// Dates use epoch-day arithmetic so every generated date is a real calendar day.
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;
const TODAY_MIN = Date.UTC(2024, 0, 1) / MS_PER_DAY;
const TODAY_MAX = Date.UTC(2027, 11, 31) / MS_PER_DAY;

function dateOf(epochDay: number): string {
  return new Date(epochDay * MS_PER_DAY).toISOString().slice(0, 10);
}

const SUPPLIER: Supplier = {
  id: "supplier-1",
  name: "Test Supplier",
  udyamNumber: "UDYAM-XX-00-0000000",
  supplierCategory: "micro",
  supplierActivity: "manufacturing",
};

const BUYERS: readonly { id: string; name: string }[] = [
  { id: "buyer-sharma", name: "Sharma Traders" },
  { id: "buyer-kumar", name: "Kumar Textiles" },
  { id: "buyer-gupta", name: "Gupta Works" },
];

/** Mixed case and punctuation, so code-unit order and locale order disagree. */
const INVOICE_NUMBERS: readonly string[] = ["INV-1", "inv-1", "INV-10", "INV-2", "a-1", "B-1", "LPC/26-27/0412"];

const ID_UNIT = fc.constantFrom("a", "A", "b", "B", "0", "1", "_", "-");
const arbIds = fc.uniqueArray(fc.string({ unit: ID_UNIT, minLength: 1, maxLength: 3 }), {
  minLength: 1,
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
      buyer: fc.constantFrom(...BUYERS),
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
        buyerName: r.buyer.name,
        invoiceNumber: r.invoiceNumber,
        history: r.history,
        buyerId: r.buyer.id,
        invoiceDate: invoice.acceptedOn,
      };
    });
}

interface Scenario {
  today: string;
  bankRate: BankRate | null;
  /** Records over several buyers. */
  records: GraveyardInvoiceRecord[];
  /** A buyer that owns at least one record. */
  buyer: { id: string; name: string };
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
      fc.constantFrom(...records).map((picked): Scenario => {
        const buyer = BUYERS.find((b) => b.id === picked.buyerId);
        if (buyer === undefined) throw new Error("record with unknown buyer");
        return {
          today: dateOf(today),
          bankRate: bankRateBps === null ? null : { annualBps: bankRateBps, asOf: dateOf(today + bankRateAsOfOffset) },
          records,
          buyer,
        };
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Property 4
// ---------------------------------------------------------------------------

describe("buildDebtorView panels", () => {
  // Feature: debtor-ui, Property 4: Panels equal the graveyard's tombstones for that buyer
  // **Validates: Requirements 4.1, 4.4**
  it("equal the graveyard's tombstones for that buyer, in order, ignoring look.heightPx", () => {
    fc.assert(
      fc.property(arbScenario, ({ today, bankRate, records, buyer }) => {
        const buyerRecords = records.filter((r) => r.buyerId === buyer.id);
        const data: DebtorData = { buyer, records: buyerRecords, events: [], promises: [] };

        const view = buildDebtorView({ supplier: SUPPLIER, data, bankRate, drafts: [], calls: [], today, override: null });

        const expected = buildGraveyard(SUPPLIER, records, bankRate, today).tombstones.filter(
          (t) => t.buyerId === buyer.id,
        );

        // Neutralise heightPx so only the remaining look fields are compared.
        const withoutHeight = (t: (typeof expected)[number]) => ({ ...t, look: { ...t.look, heightPx: 0 } });

        expect(view.panels.map((p) => withoutHeight(p.tombstone))).toEqual(expected.map(withoutHeight));
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 10
// ---------------------------------------------------------------------------

/**
 * `buildDebtorView` reads only `buyerId` and `invoice.id` from a Draft. The other fields are minimal
 * but well-formed, and `draft.id` is unique per list position so order can be asserted exactly.
 */
function makeDraft(index: number, buyerId: string, invoiceId: string): DraftWithContext {
  const buyer = BUYERS.find((b) => b.id === buyerId);
  return {
    draft: { id: `draft-${index}`, invoiceId, status: "pending" } as DraftWithContext["draft"],
    invoice: {
      id: invoiceId,
      amountPaise: 100_000,
      acceptedOn: "2026-01-01",
      supplierCategory: "micro",
      supplierActivity: "manufacturing",
    },
    invoiceDate: "2026-01-01",
    acceptanceDateDefaulted: false,
    buyerId,
    buyerName: buyer?.name ?? buyerId,
    invoiceNumber: `INV-${index}`,
  };
}

/**
 * Drafts over all buyers. Invoice ids come from every record in the scenario (the page buyer's own
 * invoices, including any that are not panels, and other buyers' invoices) plus ids that exist nowhere.
 */
function arbDrafts(scenario: Scenario): fc.Arbitrary<DraftWithContext[]> {
  const invoiceIds = [...scenario.records.map((r) => r.invoice.id), "ghost-1", "ghost-2"];
  return fc
    .array(
      fc.record({
        buyerId: fc.constantFrom(...BUYERS.map((b) => b.id)),
        invoiceId: fc.constantFrom(...invoiceIds),
      }),
      { maxLength: 20 },
    )
    .map((specs) => specs.map((s, i) => makeDraft(i, s.buyerId, s.invoiceId)));
}

describe("buildDebtorView drafts", () => {
  // Feature: debtor-ui, Property 10: Buyer's Drafts keep the queue order
  // **Validates: Requirements 7.1**
  it("are the order-preserving subsequence of the queue for this buyer's Debtor_Invoices", () => {
    fc.assert(
      fc.property(
        arbScenario.chain((scenario) => arbDrafts(scenario).map((drafts) => ({ scenario, drafts }))),
        ({ scenario: { today, bankRate, records, buyer }, drafts }) => {
          const buyerRecords = records.filter((r) => r.buyerId === buyer.id);
          const data: DebtorData = { buyer, records: buyerRecords, events: [], promises: [] };
          const before = drafts.map((d) => d.draft.id);

          const view = buildDebtorView({ supplier: SUPPLIER, data, bankRate, drafts, calls: [], today, override: null });

          const panelIds = new Set(view.panels.map((p) => p.tombstone.id));
          const expected = drafts.filter((d) => d.buyerId === buyer.id && panelIds.has(d.invoice.id));

          expect(view.drafts).toEqual(expected);
          // Same Draft objects, in the same relative order as the input list.
          const positions = view.drafts.map((d) => drafts.indexOf(d));
          expect(positions.every((p) => p >= 0)).toBe(true);
          expect(positions).toEqual([...positions].sort((a, b) => a - b));
          // The input list is not mutated.
          expect(drafts.map((d) => d.draft.id)).toEqual(before);
        },
      ),
      { numRuns: 200 },
    );
  });
});
