// Feature: crew-api, Property 1: The mapper is an exact projection of the view
// **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6**
import {
  DEMO_INVOICES,
  DEMO_SUPPLIER,
  toEngineInvoice,
  type GraveyardInvoiceRecord,
  type InvoiceRow,
  type Supplier,
  type SupplierRow,
} from "@dues-banshee/db";
import {
  formatINR,
  LADDER_STEPS,
  type BankRate,
  type CalendarDate,
  type Caveat,
  type TaxBombStatus,
  type WaitReason,
} from "@dues-banshee/engine";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CREW_DISCLAIMER, toCrewSummary } from "../lib/crew/summary";
import {
  buildGraveyard,
  type GraveyardTotals,
  type GraveyardView,
  type TombstoneState,
  type TombstoneView,
} from "../lib/graveyard/build-graveyard";

const MS_PER_DAY = 86_400_000;
const FIRST_DAY = Date.UTC(2024, 0, 1) / MS_PER_DAY;
const LAST_DAY = Date.UTC(2027, 11, 31) / MS_PER_DAY;

/** Epoch day to "YYYY-MM-DD". */
function dayToDate(epochDay: number): CalendarDate {
  return new Date(epochDay * MS_PER_DAY).toISOString().slice(0, 10);
}

const TOP_KEYS = ["disclaimer", "rulesAsOf", "supplierName", "today", "todayOverride", "totals", "tombstones"];
const TOTALS_KEYS = ["deductionsAtRisk", "explodedCount", "interestAccrued", "outstanding", "paidCount"];
const TOMBSTONE_KEYS = [
  "buyerId",
  "buyerName",
  "dueDate",
  "dueDateText",
  "daysOverdue",
  "id",
  "interest",
  "invoiceNumber",
  "nextLabel",
  "principal",
  "state",
  "stateRuleId",
  "stateText",
  "taxBomb",
];
const LEAKED_KEYS = ["look", "ariaLabel", "caveat", "next"];

const STATES: readonly TombstoneState[] = ["resurrected", "not_covered", "not_due", "exploded", "armed", "overdue"];
const BOMB_STATUSES: readonly TaxBombStatus[] = ["armed", "exploded", "defused"];
const CAVEATS: readonly Caveat[] = ["registered_after_supply"];
const WAIT_REASONS: readonly WaitReason[] = [
  "paid",
  "not_overdue",
  "promise_active",
  "ladder_complete",
  "cooldown",
  "medium_or_unregistered",
  "trader",
];

const arbPaise: fc.Arbitrary<number> = fc.integer({ min: 0, max: 1_000_000_000_000 });
const arbDate: fc.Arbitrary<CalendarDate> = fc.integer({ min: FIRST_DAY, max: LAST_DAY }).map(dayToDate);

const arbTombstone: fc.Arbitrary<TombstoneView> = fc.record({
  id: fc.string(),
  buyerId: fc.string(),
  buyerName: fc.string(),
  invoiceNumber: fc.string(),
  principalPaise: arbPaise,
  principalText: fc.string(),
  state: fc.constantFrom(...STATES),
  stateText: fc.string(),
  stateRuleId: fc.option(fc.constantFrom("IT-43BH" as const, "MSMED-SCOPE" as const), { nil: null }),
  dueDate: fc.option(arbDate, { nil: null }),
  dueDateText: fc.option(fc.string(), { nil: null }),
  daysOverdue: fc.integer({ min: 0, max: 5000 }),
  interest: fc.option(fc.record({ paise: arbPaise, text: fc.string() }), { nil: null }),
  taxBomb: fc.option(
    fc.record({
      status: fc.constantFrom(...BOMB_STATUSES),
      daysLeft: fc.integer({ min: -400, max: 400 }),
      deductionAtRiskPaise: arbPaise,
    }),
    { nil: null },
  ),
  // Fields the mapper must drop: arbitrary values so any leak shows.
  caveat: fc.option(fc.constantFrom(...CAVEATS), { nil: null }),
  next: fc.oneof(
    fc.record({ action: fc.constant("advance" as const), step: fc.constantFrom(...LADDER_STEPS) }),
    fc.record({ action: fc.constant("wait" as const), reason: fc.constantFrom(...WAIT_REASONS) }),
  ),
  nextLabel: fc.string(),
  look: fc.record({
    heightPx: fc.integer({ min: 130, max: 300 }),
    moss: fc.constantFrom(0 as const, 1 as const, 2 as const, 3 as const, 4 as const),
    cracked: fc.boolean(),
    ember: fc.boolean(),
    wisp: fc.boolean(),
  }),
  ariaLabel: fc.string(),
});

const arbTotals: fc.Arbitrary<GraveyardTotals> = fc.record({
  outstandingPaise: arbPaise,
  interestAccruedPaise: fc.option(arbPaise, { nil: null }),
  deductionsAtRiskPaise: arbPaise,
  explodedCount: fc.nat({ max: 5000 }),
  paidCount: fc.nat({ max: 5000 }),
});

const arbView: fc.Arbitrary<GraveyardView> = fc.record({
  supplierName: fc.string(),
  today: arbDate,
  rulesAsOf: fc.option(arbDate, { nil: null }),
  tombstones: fc.array(arbTombstone, { maxLength: 8 }),
  totals: arbTotals,
});

const sorted = (o: object): string[] => Object.keys(o).sort();
const full = (paise: number): string => formatINR(paise, "full");

describe("toCrewSummary (Property 1)", () => {
  it("is an exact projection of the Graveyard_View", () => {
    fc.assert(
      fc.property(arbView, fc.boolean(), (view, todayOverride) => {
        const out = toCrewSummary(view, todayOverride);

        // Top level (Requirements 4.1, 4.2).
        expect(sorted(out)).toEqual([...TOP_KEYS].sort());
        expect(out.supplierName).toBe(view.supplierName);
        expect(out.today).toBe(view.today);
        expect(out.rulesAsOf).toBe(view.rulesAsOf);
        expect(out.todayOverride).toBe(todayOverride);
        expect(out.disclaimer).toBe(CREW_DISCLAIMER);

        // Totals (Requirements 4.3, 4.4).
        const t = view.totals;
        expect(sorted(out.totals)).toEqual([...TOTALS_KEYS].sort());
        expect(out.totals.outstanding).toEqual({ paise: t.outstandingPaise, text: full(t.outstandingPaise) });
        expect(out.totals.deductionsAtRisk).toEqual({
          paise: t.deductionsAtRiskPaise,
          text: full(t.deductionsAtRiskPaise),
        });
        if (t.interestAccruedPaise === null) {
          expect(out.totals.interestAccrued).toBeNull();
        } else {
          expect(out.totals.interestAccrued).toEqual({
            paise: t.interestAccruedPaise,
            text: full(t.interestAccruedPaise),
          });
        }
        expect(out.totals.explodedCount).toBe(t.explodedCount);
        expect(out.totals.paidCount).toBe(t.paidCount);

        // Tombstones (Requirements 4.5, 4.6).
        expect(out.tombstones.map((x) => x.id)).toEqual(view.tombstones.map((x) => x.id));
        view.tombstones.forEach((v, i) => {
          const o = out.tombstones[i]!;
          expect(sorted(o)).toEqual([...TOMBSTONE_KEYS].sort());
          for (const leaked of LEAKED_KEYS) expect(o).not.toHaveProperty(leaked);

          expect(o.id).toBe(v.id);
          expect(o.buyerId).toBe(v.buyerId);
          expect(o.buyerName).toBe(v.buyerName);
          expect(o.invoiceNumber).toBe(v.invoiceNumber);
          expect(o.state).toBe(v.state);
          expect(o.stateText).toBe(v.stateText);
          expect(o.stateRuleId).toBe(v.stateRuleId);
          expect(o.principal).toEqual({ paise: v.principalPaise, text: v.principalText });
          expect(o.dueDate).toBe(v.dueDate);
          expect(o.dueDateText).toBe(v.dueDateText);
          expect(o.daysOverdue).toBe(v.daysOverdue);
          expect(o.nextLabel).toBe(v.nextLabel);

          if (v.interest === null) {
            expect(o.interest).toBeNull();
          } else {
            expect(o.interest).toEqual({ paise: v.interest.paise, text: v.interest.text });
          }

          if (v.taxBomb === null) {
            expect(o.taxBomb).toBeNull();
          } else {
            expect(o.taxBomb).toEqual({
              status: v.taxBomb.status,
              daysLeft: v.taxBomb.daysLeft,
              deductionAtRiskPaise: v.taxBomb.deductionAtRiskPaise,
              deductionAtRiskText: full(v.taxBomb.deductionAtRiskPaise),
            });
          }
        });
      }),
      { numRuns: 100 },
    );
  });
});

// --- Sharma Traders example (Requirements 4.3, 4.4, 4.8) -------------------------------------------------------

const DEMO_TODAY = "2026-11-12";
const BANK_RATE: BankRate = { annualBps: 575, asOf: "2026-10-07" };

const SUPPLIER_ID = "00000000-0000-4000-8000-000000000001";
const SUPPLIER: Supplier = { id: SUPPLIER_ID, ...DEMO_SUPPLIER };
const SUPPLIER_ROW: SupplierRow = {
  ...SUPPLIER,
  udyamRegisteredOn: DEMO_SUPPLIER.udyamRegisteredOn,
  createdAt: new Date(0),
};

// Fixed ids, so the expected values never depend on generated uuids.
const IDS: Record<string, string> = {
  "LPC/26-27/0412": "inv-sharma",
  "LPC/26-27/0466": "inv-gupta",
  "LPC/26-27/0301": "inv-kumar",
  "LPC/26-27/0377": "inv-verma",
  "LPC/25-26/0388": "inv-mehta",
  "LPC/23-24/0098": "inv-bansal",
};

function demoRecords(): GraveyardInvoiceRecord[] {
  return DEMO_INVOICES.map((demo): GraveyardInvoiceRecord => {
    const id = IDS[demo.invoiceNumber];
    if (id === undefined) throw new Error(`no fixed id for ${demo.invoiceNumber}`);
    const row: InvoiceRow = {
      id,
      supplierId: SUPPLIER_ID,
      buyerId: `buyer-${id}`,
      invoiceNumber: demo.invoiceNumber,
      invoiceNumberKey: demo.invoiceNumber.toLowerCase(),
      invoiceDate: demo.acceptedOn,
      acceptedOn: demo.acceptedOn,
      acceptanceDateDefaulted: false,
      agreedTermDays: demo.agreedTermDays ?? null,
      amountPaise: demo.amountPaise,
      paidOn: demo.paidOn ?? null,
      supplierCategory: SUPPLIER_ROW.supplierCategory,
      supplierActivity: SUPPLIER_ROW.supplierActivity,
      createdAt: new Date(0),
    };
    return {
      invoice: toEngineInvoice(row, SUPPLIER_ROW),
      buyerName: demo.buyerName,
      invoiceNumber: demo.invoiceNumber,
      history: [],
      buyerId: row.buyerId,
      invoiceDate: row.invoiceDate,
    };
  });
}

describe("toCrewSummary on the demo seed at 2026-11-12", () => {
  const view = buildGraveyard(SUPPLIER, demoRecords(), BANK_RATE, DEMO_TODAY);
  const summary = toCrewSummary(view, true);

  it("returns the exact Sharma Traders tombstone (Requirement 4.8)", () => {
    const sharma = summary.tombstones.find((t) => t.invoiceNumber === "LPC/26-27/0412");
    expect(sharma).toMatchObject({
      id: "inv-sharma",
      buyerName: "Sharma Traders",
      invoiceNumber: "LPC/26-27/0412",
      state: "armed",
      stateRuleId: "IT-43BH",
      principal: { paise: 41200000, text: "₹4,12,000" },
      dueDate: "2026-10-17",
      dueDateText: "17 Oct 2026",
      daysOverdue: 26,
      interest: { paise: 512794, text: "₹5,127.94" },
      taxBomb: { status: "armed", daysLeft: 139, deductionAtRiskPaise: 41200000, deductionAtRiskText: "₹4,12,000" },
      nextLabel: "Next: WhatsApp nudge",
    });
  });

  it("copies rulesAsOf, today and the disclaimer, and flags the override", () => {
    expect(summary.rulesAsOf).toBe("2026-10-07");
    expect(summary.today).toBe(DEMO_TODAY);
    expect(summary.todayOverride).toBe(true);
    expect(summary.disclaimer).toBe("Reminders a supplier sends to its own buyers. Not legal advice.");
  });

  it("turns the view's totals into paise and text (Requirement 4.3)", () => {
    expect(summary.totals.outstanding).toEqual({ paise: 105200000, text: formatINR(105200000, "full") });
    expect(summary.totals.interestAccrued).toEqual({ paise: 6236681, text: formatINR(6236681, "full") });
  });

  it("sets totals.interestAccrued to null when the view has no Bank_Rate (Requirement 4.4)", () => {
    const noRate = buildGraveyard(SUPPLIER, demoRecords(), null, DEMO_TODAY);
    expect(noRate.totals.interestAccruedPaise).toBeNull();
    const out = toCrewSummary(noRate, false);
    expect(out.totals.interestAccrued).toBeNull();
    expect(out.rulesAsOf).toBeNull();
    expect(out.todayOverride).toBe(false);
  });
});
