import {
  DEMO_INVOICES,
  DEMO_SUPPLIER,
  toEngineInvoice,
  type DebtorData,
  type GraveyardInvoiceRecord,
  type InvoiceRow,
  type Supplier,
  type SupplierRow,
} from "@dues-banshee/db";
import { formatINR, type BankRate, type EscalationHistory } from "@dues-banshee/engine";
import { describe, expect, it } from "vitest";
import { buildDebtorView, type BuildDebtorViewInput } from "@/lib/debtor/build-debtor-view";
import type { TombstoneView } from "@/lib/graveyard/build-graveyard";

const TODAY = "2026-11-12";
const BANK_RATE: BankRate = { annualBps: 575, asOf: "2026-10-07" };

const SUPPLIER_ID = "00000000-0000-4000-8000-000000000001";
const SUPPLIER: Supplier = { id: SUPPLIER_ID, ...DEMO_SUPPLIER };
const SUPPLIER_ROW: SupplierRow = {
  ...SUPPLIER,
  udyamRegisteredOn: DEMO_SUPPLIER.udyamRegisteredOn,
  createdAt: new Date(0),
};

const SHARMA_INVOICE_ID = "inv-sharma";
const VERMA_INVOICE_ID = "inv-verma";
const VERMA_BUYER_ID = "buyer-inv-verma";

const IDS: Record<string, string> = {
  "LPC/26-27/0412": SHARMA_INVOICE_ID,
  "LPC/26-27/0377": VERMA_INVOICE_ID,
};

/** One Demo_Seed invoice as a graveyard record, built through `toEngineInvoice`. */
function demoRecord(invoiceNumber: string, history: EscalationHistory = []): GraveyardInvoiceRecord {
  const demo = DEMO_INVOICES.find((d) => d.invoiceNumber === invoiceNumber);
  const id = IDS[invoiceNumber];
  if (demo === undefined || id === undefined) throw new Error(`no demo invoice ${invoiceNumber}`);
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
    history,
    buyerId: row.buyerId,
    invoiceDate: row.invoiceDate,
  };
}

function input(
  record: GraveyardInvoiceRecord,
  overrides: Partial<BuildDebtorViewInput> = {},
): BuildDebtorViewInput {
  const data: DebtorData = {
    buyer: { id: record.buyerId, name: record.buyerName },
    records: [record],
    events: [],
    promises: [],
  };
  return { supplier: SUPPLIER, data, bankRate: BANK_RATE, drafts: [], today: TODAY, override: null, ...overrides };
}

// A single-record view has one distinct principal, so heightsByRank gives rank 0 -> 130 px.
// Sharma at Today 2026-11-12: due 17 Oct 2026 (MSMED-15), 26 days overdue, interest 512794 paise (MSMED-16),
// tax bomb armed with 139 days left to 31 Mar 2027 (IT-43BH). Moss 2 (16-45 days), no cracks, no ember, no wisp.
const SHARMA: TombstoneView = {
  id: "inv-sharma",
  buyerId: "buyer-inv-sharma",
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
  look: { heightPx: 130, moss: 2, cracked: false, ember: false, wisp: false },
  ariaLabel: "Sharma Traders, ₹4,12,000, 26 days overdue, Tax bomb armed: 139 days left to 31 March",
};

describe("buildDebtorView: Sharma Traders panel at 2026-11-12 (Req 4.1, 4.2, 4.4, 10.1)", () => {
  it("builds the exact panel from the Engine figures", () => {
    const view = buildDebtorView(input(demoRecord("LPC/26-27/0412")));
    expect(view.panels).toEqual([
      {
        tombstone: SHARMA,
        buyerId: "buyer-inv-sharma",
        panelId: "invoice-inv-sharma",
        overdueText: "Overdue 26 days, interest accruing",
        promiseUntilText: null,
        showPlaceholders: true,
      },
    ]);
  });

  it("carries the buyer, supplier, date and override through", () => {
    const view = buildDebtorView(input(demoRecord("LPC/26-27/0412")));
    expect(view.supplierName).toBe("Laxmi Precision Components (Demo)");
    expect(view.buyerId).toBe("buyer-inv-sharma");
    expect(view.buyerName).toBe("Sharma Traders");
    expect(view.today).toBe("2026-11-12");
    expect(view.override).toBeNull();
    expect(view.drafts).toEqual([]);
  });

  it("shows the legal figures as literals with their rule IDs", () => {
    const panel = buildDebtorView(input(demoRecord("LPC/26-27/0412"))).panels[0];
    expect(panel?.tombstone.invoiceNumber).toBe("LPC/26-27/0412");
    expect(panel?.tombstone.principalPaise).toBe(41200000);
    expect(panel?.tombstone.dueDate).toBe("2026-10-17");
    expect(panel?.tombstone.daysOverdue).toBe(26);
    expect(panel?.tombstone.interest?.paise).toBe(512794);
    expect(panel?.tombstone.state).toBe("armed");
    expect(panel?.tombstone.taxBomb?.daysLeft).toBe(139);
    expect(panel?.tombstone.stateRuleId).toBe("IT-43BH");
    expect(panel?.tombstone.nextLabel).toBe("Next: WhatsApp nudge");
  });

  it("displays amounts equal to formatINR(…, \"full\") of the paise literals", () => {
    const panel = buildDebtorView(input(demoRecord("LPC/26-27/0412"))).panels[0];
    expect(panel?.tombstone.principalText).toBe(formatINR(41200000, "full"));
    expect(panel?.tombstone.interest?.text).toBe(formatINR(512794, "full"));
    expect(panel?.tombstone.principalText).toBe("₹4,12,000");
    expect(panel?.tombstone.interest?.text).toBe("₹5,127.94");
  });

  it("does not mutate its inputs", () => {
    const args = input(demoRecord("LPC/26-27/0412"));
    const before = structuredClone(args);
    buildDebtorView(args);
    expect(args).toEqual(before);
  });
});

describe("buildDebtorView: promise to pay (Req 6.4)", () => {
  it("shows 'Promise to pay active until 20 Nov 2026' on an unpaid invoice with a promise to 2026-11-20", () => {
    const history: EscalationHistory = [
      { kind: "promise", promisedDate: "2026-11-20", amountPaise: 41200000, recordedOn: "2026-11-10" },
    ];
    const panel = buildDebtorView(input(demoRecord("LPC/26-27/0412", history))).panels[0];
    expect(panel?.promiseUntilText).toBe("Promise to pay active until 20 Nov 2026");
    expect(panel?.showPlaceholders).toBe(true);
    expect(panel?.tombstone.look.wisp).toBe(true);
  });

  it("shows no promise text when the promise date is before Today", () => {
    const history: EscalationHistory = [
      { kind: "promise", promisedDate: "2026-11-11", amountPaise: 41200000, recordedOn: "2026-11-01" },
    ];
    const panel = buildDebtorView(input(demoRecord("LPC/26-27/0412", history))).panels[0];
    expect(panel?.promiseUntilText).toBeNull();
  });
});

describe("buildDebtorView: paid invoice (Req 4.2, 8.1)", () => {
  it("has promiseUntilText null and showPlaceholders false, even with a future promise in its history", () => {
    const history: EscalationHistory = [
      { kind: "promise", promisedDate: "2026-11-20", amountPaise: 8500000, recordedOn: "2026-09-20" },
    ];
    const panel = buildDebtorView(input(demoRecord("LPC/26-27/0377", history))).panels[0];
    expect(panel?.tombstone.id).toBe(VERMA_INVOICE_ID);
    expect(panel?.buyerId).toBe(VERMA_BUYER_ID);
    expect(panel?.tombstone.state).toBe("resurrected");
    expect(panel?.promiseUntilText).toBeNull();
    expect(panel?.showPlaceholders).toBe(false);
    expect(panel?.overdueText).toBeNull();
  });
});

describe("buildDebtorView: no Bank_Rate (Req 4.6)", () => {
  it("nulls the interest and leaves every other figure unchanged", () => {
    const withRate = buildDebtorView(input(demoRecord("LPC/26-27/0412"))).panels[0];
    const withoutRate = buildDebtorView(input(demoRecord("LPC/26-27/0412"), { bankRate: null })).panels[0];
    expect(withoutRate?.tombstone.interest).toBeNull();
    expect(withoutRate).toEqual({ ...withRate, tombstone: { ...SHARMA, interest: null } });
    expect(withoutRate?.tombstone.daysOverdue).toBe(26);
    expect(withoutRate?.tombstone.dueDate).toBe("2026-10-17");
    expect(withoutRate?.tombstone.taxBomb?.daysLeft).toBe(139);
  });
});
