import {
  DEMO_INVOICES,
  DEMO_SUPPLIER,
  toEngineInvoice,
  type GraveyardInvoiceRecord,
  type InvoiceRow,
  type Supplier,
  type SupplierRow,
} from "@dues-banshee/db";
import type { BankRate } from "@dues-banshee/engine";
import { describe, expect, it } from "vitest";
import { buildGraveyard, type GraveyardView, type TombstoneView } from "@/lib/graveyard/build-graveyard";

const TODAY = "2026-11-12";
const BANK_RATE: BankRate = { annualBps: 575, asOf: "2026-10-07" };

const SUPPLIER_ID = "00000000-0000-4000-8000-000000000001";
const SUPPLIER: Supplier = { id: SUPPLIER_ID, ...DEMO_SUPPLIER };
const SUPPLIER_ROW: SupplierRow = {
  ...SUPPLIER,
  udyamRegisteredOn: DEMO_SUPPLIER.udyamRegisteredOn,
  createdAt: new Date(0),
};

// Fixed ids, written here so the expected values never depend on generated uuids.
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

/** A minimal covered record, for the acceptedOn boundary tests. */
function extraRecord(acceptedOn: string): GraveyardInvoiceRecord {
  return {
    invoice: {
      id: `inv-extra-${acceptedOn}`,
      amountPaise: 100000,
      acceptedOn,
      supplierCategory: "micro",
      supplierActivity: "manufacturing",
      udyamRegisteredOn: "2024-04-15",
    },
    buyerName: "Extra Buyer",
    invoiceNumber: "EXTRA/1",
    history: [],
    buyerId: "buyer-extra",
    invoiceDate: acceptedOn,
  };
}

// Hand calculation of the look at Today 2026-11-12 (see design.md "Look" and look.ts):
// - Height: rank of the principal among the six distinct principals, 130 + floor(170 * rank / 5) = 130 + 34 * rank.
//   Bansal 5.5M rank 0 -> 130, Verma 8.5M -> 164, Mehta 16M -> 198, Gupta 18.5M -> 232, Kumar 24M -> 266,
//   Sharma 41.2M rank 5 -> 300.
// - Moss: 0 days -> 0, 1-15 -> 1, 16-45 -> 2, 46-90 -> 3, >90 -> 4. Sharma 26 -> 2, Kumar 88 -> 3, Mehta 192 and
//   Bansal 956 -> 4. Gupta and Verma 0 -> 0.
// - Cracks above 60 days and ember above 45 days: Kumar (88), Mehta (192), Bansal (956) have both; Sharma (26) neither.
// - Wisp: no demo invoice has a promise, so none has one.
// - Tax bomb: Today to 31 Mar 2027 is 18 + 31 + 31 + 28 + 31 = 139 days. Gupta (due 16 Nov 2026) and Sharma and
//   Kumar are armed with the whole principal at risk (41,200,000 + 18,500,000 + 24,000,000 = 83,700,000).
const KUMAR: TombstoneView = {
  id: "inv-kumar",
  buyerName: "Kumar Textiles",
  invoiceNumber: "LPC/26-27/0301",
  principalPaise: 24000000,
  principalText: "₹2,40,000",
  state: "armed",
  stateText: "Tax bomb armed: 139 days left to 31 March",
  stateRuleId: "IT-43BH",
  dueDate: "2026-08-16",
  dueDateText: "16 Aug 2026",
  daysOverdue: 88,
  interest: { paise: 1026125, text: "₹10,261.25" },
  taxBomb: { status: "armed", daysLeft: 139, deductionAtRiskPaise: 24000000 },
  caveat: null,
  next: { action: "advance", step: "whatsapp_nudge" },
  nextLabel: "Next: WhatsApp nudge",
  look: { heightPx: 266, moss: 3, cracked: true, ember: true, wisp: false },
  ariaLabel: "Kumar Textiles, ₹2,40,000, 88 days overdue, Tax bomb armed: 139 days left to 31 March",
};

const SHARMA: TombstoneView = {
  id: "inv-sharma",
  buyerName: "Sharma Traders",
  invoiceNumber: "LPC/26-27/0412",
  principalPaise: 41200000,
  principalText: "₹4,12,000",
  state: "armed",
  stateText: "Tax bomb armed: 139 days left to 31 March",
  stateRuleId: "IT-43BH",
  dueDate: "2026-10-17",
  dueDateText: "17 Oct 2026",
  daysOverdue: 26,
  interest: { paise: 512794, text: "₹5,127.94" },
  taxBomb: { status: "armed", daysLeft: 139, deductionAtRiskPaise: 41200000 },
  caveat: null,
  next: { action: "advance", step: "whatsapp_nudge" },
  nextLabel: "Next: WhatsApp nudge",
  look: { heightPx: 300, moss: 2, cracked: false, ember: false, wisp: false },
  ariaLabel: "Sharma Traders, ₹4,12,000, 26 days overdue, Tax bomb armed: 139 days left to 31 March",
};

const BANSAL: TombstoneView = {
  id: "inv-bansal",
  buyerName: "Bansal Hardware",
  invoiceNumber: "LPC/23-24/0098",
  principalPaise: 5500000,
  principalText: "₹55,000",
  state: "exploded",
  stateText: "Tax bomb exploded",
  stateRuleId: "IT-43BH",
  dueDate: "2024-03-31",
  dueDateText: "31 Mar 2024",
  daysOverdue: 956,
  interest: { paise: 3167411, text: "₹31,674.11" },
  taxBomb: { status: "exploded", daysLeft: 0, deductionAtRiskPaise: 5500000 },
  caveat: "registered_after_supply",
  next: { action: "advance", step: "whatsapp_nudge" },
  nextLabel: "Next: WhatsApp nudge",
  look: { heightPx: 130, moss: 4, cracked: true, ember: true, wisp: false },
  ariaLabel: "Bansal Hardware, ₹55,000, 956 days overdue, Tax bomb exploded",
};

const MEHTA: TombstoneView = {
  id: "inv-mehta",
  buyerName: "Mehta Polymers",
  invoiceNumber: "LPC/25-26/0388",
  principalPaise: 16000000,
  principalText: "₹1,60,000",
  state: "exploded",
  stateText: "Tax bomb exploded",
  stateRuleId: "IT-43BH",
  dueDate: "2026-05-04",
  dueDateText: "4 May 2026",
  daysOverdue: 192,
  interest: { paise: 1530351, text: "₹15,303.51" },
  taxBomb: { status: "exploded", daysLeft: 0, deductionAtRiskPaise: 16000000 },
  caveat: null,
  next: { action: "advance", step: "whatsapp_nudge" },
  nextLabel: "Next: WhatsApp nudge",
  look: { heightPx: 198, moss: 4, cracked: true, ember: true, wisp: false },
  ariaLabel: "Mehta Polymers, ₹1,60,000, 192 days overdue, Tax bomb exploded",
};

const GUPTA: TombstoneView = {
  id: "inv-gupta",
  buyerName: "Gupta Engineering Works",
  invoiceNumber: "LPC/26-27/0466",
  principalPaise: 18500000,
  principalText: "₹1,85,000",
  state: "not_due",
  stateText: "Not due yet",
  stateRuleId: null,
  dueDate: "2026-11-16",
  dueDateText: "16 Nov 2026",
  daysOverdue: 0,
  interest: { paise: 0, text: "₹0" },
  taxBomb: { status: "armed", daysLeft: 139, deductionAtRiskPaise: 18500000 },
  caveat: null,
  next: { action: "wait", reason: "not_overdue" },
  nextLabel: "Waiting: Not due yet",
  look: { heightPx: 232, moss: 0, cracked: false, ember: false, wisp: false },
  ariaLabel: "Gupta Engineering Works, ₹1,85,000, 0 days overdue, Not due yet",
};

const VERMA: TombstoneView = {
  id: "inv-verma",
  buyerName: "Verma Auto Parts",
  invoiceNumber: "LPC/26-27/0377",
  principalPaise: 8500000,
  principalText: "₹85,000",
  state: "resurrected",
  stateText: "Resurrected (paid)",
  stateRuleId: null,
  dueDate: "2026-09-09",
  dueDateText: "9 Sep 2026",
  daysOverdue: 0,
  interest: { paise: 0, text: "₹0" },
  taxBomb: { status: "defused", daysLeft: 0, deductionAtRiskPaise: 0 },
  caveat: null,
  next: { action: "wait", reason: "paid" },
  nextLabel: "Waiting: Paid",
  look: { heightPx: 164, moss: 0, cracked: false, ember: false, wisp: false },
  ariaLabel: "Verma Auto Parts, ₹85,000, 0 days overdue, Resurrected (paid)",
};

const EXPECTED_VIEW: GraveyardView = {
  supplierName: "Laxmi Precision Components (Demo)",
  today: TODAY,
  rulesAsOf: "2026-10-07",
  tombstones: [KUMAR, SHARMA, BANSAL, MEHTA, GUPTA, VERMA],
  totals: {
    outstandingPaise: 105200000,
    interestAccruedPaise: 6236681,
    deductionsAtRiskPaise: 83700000,
    explodedCount: 2,
    paidCount: 1,
  },
};

describe("buildGraveyard on the demo data at 2026-11-12", () => {
  it("builds the full Graveyard_View with exact literals (Req 12.1)", () => {
    expect(buildGraveyard(SUPPLIER, demoRecords(), BANK_RATE, TODAY)).toEqual(EXPECTED_VIEW);
  });

  it("returns the Totals as exact integer literals (Req 12.2)", () => {
    expect(buildGraveyard(SUPPLIER, demoRecords(), BANK_RATE, TODAY).totals).toEqual({
      outstandingPaise: 105200000,
      interestAccruedPaise: 6236681,
      deductionsAtRiskPaise: 83700000,
      explodedCount: 2,
      paidCount: 1,
    });
  });

  it("orders the tombstones by invoice number as armed, exploded, not due, resurrected (Req 12.3)", () => {
    const view = buildGraveyard(SUPPLIER, demoRecords(), BANK_RATE, TODAY);
    expect(view.tombstones.map((t) => t.invoiceNumber)).toEqual([
      "LPC/26-27/0301",
      "LPC/26-27/0412",
      "LPC/23-24/0098",
      "LPC/25-26/0388",
      "LPC/26-27/0466",
      "LPC/26-27/0377",
    ]);
  });

  it("shows Sharma's next step as 'Next: WhatsApp nudge' (Req 12.12)", () => {
    const view = buildGraveyard(SUPPLIER, demoRecords(), BANK_RATE, TODAY);
    expect(view.tombstones.find((t) => t.invoiceNumber === "LPC/26-27/0412")?.nextLabel).toBe(
      "Next: WhatsApp nudge",
    );
  });

  it("gives the same view regardless of input order", () => {
    const reversed = demoRecords().reverse();
    expect(buildGraveyard(SUPPLIER, reversed, BANK_RATE, TODAY)).toEqual(EXPECTED_VIEW);
  });

  it("does not mutate its inputs", () => {
    const records = demoRecords();
    const recordsBefore = structuredClone(records);
    const supplierBefore = structuredClone(SUPPLIER);
    const bankRateBefore = structuredClone(BANK_RATE);
    buildGraveyard(SUPPLIER, records, BANK_RATE, TODAY);
    expect(records).toEqual(recordsBefore);
    expect(SUPPLIER).toEqual(supplierBefore);
    expect(BANK_RATE).toEqual(bankRateBefore);
  });

  it("shows a rising wisp only on the tombstone with a promise dated today or later", () => {
    const records = demoRecords();
    const sharma = records.find((r) => r.invoiceNumber === "LPC/26-27/0412");
    if (sharma === undefined) throw new Error("Sharma record missing");
    sharma.history = [{ kind: "promise", promisedDate: "2026-11-20", amountPaise: 41200000, recordedOn: "2026-11-10" }];
    const view = buildGraveyard(SUPPLIER, records, BANK_RATE, TODAY);
    expect(view.tombstones.filter((t) => t.look.wisp).map((t) => t.invoiceNumber)).toEqual(["LPC/26-27/0412"]);
  });
});

describe("buildGraveyard with no Bank_Rate (Req 2.5, 3.9, 7.2)", () => {
  it("does not throw, nulls every interest figure and Rules_As_Of, and keeps everything else", () => {
    const view = buildGraveyard(SUPPLIER, demoRecords(), null, TODAY);
    expect(view).toEqual({
      ...EXPECTED_VIEW,
      rulesAsOf: null,
      tombstones: EXPECTED_VIEW.tombstones.map((t) => ({ ...t, interest: null })),
      totals: { ...EXPECTED_VIEW.totals, interestAccruedPaise: null },
    });
  });

  it("still reports Days_Overdue and states from the Engine", () => {
    const view = buildGraveyard(SUPPLIER, demoRecords(), null, TODAY);
    expect(view.tombstones.map((t) => [t.invoiceNumber, t.daysOverdue, t.state])).toEqual([
      ["LPC/26-27/0301", 88, "armed"],
      ["LPC/26-27/0412", 26, "armed"],
      ["LPC/23-24/0098", 956, "exploded"],
      ["LPC/25-26/0388", 192, "exploded"],
      ["LPC/26-27/0466", 0, "not_due"],
      ["LPC/26-27/0377", 0, "resurrected"],
    ]);
  });
});

describe("buildGraveyard acceptedOn against Today (Req 3.7, 12.9)", () => {
  it("excludes a record accepted after Today and leaves every Total unchanged", () => {
    const withFuture = [...demoRecords(), extraRecord("2026-11-13")];
    expect(buildGraveyard(SUPPLIER, withFuture, BANK_RATE, TODAY)).toEqual(EXPECTED_VIEW);
  });

  it("includes a record accepted on Today", () => {
    const withToday = [...demoRecords(), extraRecord(TODAY)];
    const view = buildGraveyard(SUPPLIER, withToday, BANK_RATE, TODAY);
    const extra = view.tombstones.find((t) => t.id === "inv-extra-2026-11-12");
    expect(extra?.state).toBe("not_due");
    expect(extra?.dueDate).toBe("2026-11-27");
    expect(view.tombstones).toHaveLength(7);
    expect(view.totals.outstandingPaise).toBe(105300000);
  });
});

describe("buildGraveyard with no records (Req 8.1, 8.2)", () => {
  it("returns no tombstones and zero Totals with a Bank_Rate", () => {
    expect(buildGraveyard(SUPPLIER, [], BANK_RATE, TODAY)).toEqual({
      supplierName: "Laxmi Precision Components (Demo)",
      today: TODAY,
      rulesAsOf: "2026-10-07",
      tombstones: [],
      totals: {
        outstandingPaise: 0,
        interestAccruedPaise: 0,
        deductionsAtRiskPaise: 0,
        explodedCount: 0,
        paidCount: 0,
      },
    });
  });

  it("keeps Interest_Accrued null with no records and no Bank_Rate", () => {
    expect(buildGraveyard(SUPPLIER, [], null, TODAY).totals).toEqual({
      outstandingPaise: 0,
      interestAccruedPaise: null,
      deductionsAtRiskPaise: 0,
      explodedCount: 0,
      paidCount: 0,
    });
  });

  it("returns no tombstones when every record is accepted after Today", () => {
    const view = buildGraveyard(SUPPLIER, [extraRecord("2026-11-13")], BANK_RATE, TODAY);
    expect(view.tombstones).toEqual([]);
    expect(view.totals.outstandingPaise).toBe(0);
  });
});
