import {
  BankRateNotFoundError,
  DEMO_INVOICES,
  DEMO_SUPPLIER,
  SupplierNotFoundError,
  toEngineInvoice,
  type Db,
  type GraveyardInvoiceRecord,
  type InvoiceRow,
  type Supplier,
  type SupplierRow,
} from "@dues-banshee/db";
import { formatINR, type BankRate } from "@dues-banshee/engine";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  redirect: vi.fn((url: string) => {
    // Next's redirect() never returns: it throws to navigate.
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  getDb: vi.fn(),
  close: vi.fn(),
  getSupplier: vi.fn(),
  getBankRate: vi.fn(),
  listGraveyardInvoices: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("@dues-banshee/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dues-banshee/db")>()),
  getSupplier: mocks.getSupplier,
  getBankRate: mocks.getBankRate,
  listGraveyardInvoices: mocks.listGraveyardInvoices,
}));

import GraveyardPage from "@/app/(app)/page";

const SUPPLIER_ID = "00000000-0000-4000-8000-000000000001";
const SUPPLIER: Supplier = { id: SUPPLIER_ID, ...DEMO_SUPPLIER };
const SUPPLIER_ROW: SupplierRow = {
  ...SUPPLIER,
  udyamRegisteredOn: DEMO_SUPPLIER.udyamRegisteredOn,
  createdAt: new Date(0),
};
const BANK_RATE: BankRate = { annualBps: 575, asOf: "2026-10-07" };
const DB = {} as Db;
const MISSING = "Bank rate not configured for 12 Nov 2026";
const LOAD_FAILED = "We couldn&#x27;t load your graveyard just now";

// 2026-11-12 11:30 IST, so Today is 2026-11-12 whenever a test gives no `today` query.
const NOW = Date.parse("2026-11-12T06:00:00Z");

function demoRecords(): GraveyardInvoiceRecord[] {
  return DEMO_INVOICES.map((demo, index): GraveyardInvoiceRecord => {
    const id = `inv-${index}`;
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

type SearchParams = { today?: string | string[] };

async function render(searchParams: SearchParams = {}): Promise<string> {
  const element = await GraveyardPage({ searchParams: Promise.resolve(searchParams) });
  return renderToStaticMarkup(element);
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let nowSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mocks.auth.mockReset().mockResolvedValue({ supplierId: SUPPLIER_ID });
  mocks.redirect.mockClear();
  mocks.close.mockReset().mockResolvedValue(undefined);
  mocks.getDb.mockReset().mockReturnValue({ db: DB, close: mocks.close });
  mocks.getSupplier.mockReset().mockResolvedValue(SUPPLIER);
  mocks.getBankRate.mockReset().mockResolvedValue(BANK_RATE);
  mocks.listGraveyardInvoices.mockReset().mockResolvedValue(demoRecords());
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  nowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  errorSpy.mockRestore();
  nowSpy.mockRestore();
});

describe("GraveyardPage session", () => {
  it('redirects to /signin when signed out, before reading any data', async () => {
    mocks.auth.mockResolvedValue(null);

    await expect(render()).rejects.toThrow("NEXT_REDIRECT /signin");
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith("/signin");
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("redirects to /signin when the session has no supplierId", async () => {
    mocks.auth.mockResolvedValue({});

    await expect(render()).rejects.toThrow("NEXT_REDIRECT /signin");
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith("/signin");
  });

  it("redirects once to /signin?error=SessionExpired and renders no markup when the supplier is gone", async () => {
    mocks.getSupplier.mockRejectedValue(new SupplierNotFoundError("gone"));

    await expect(render()).rejects.toThrow("NEXT_REDIRECT /signin?error=SessionExpired");
    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith("/signin?error=SessionExpired");
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("ignores a supplier id in the query and uses the session's supplier only", async () => {
    const html = await render({ supplierId: "other-supplier", supplier: "other-supplier" } as SearchParams);

    expect(html).toContain("LPC/26-27/0412");
    expect(mocks.getSupplier).toHaveBeenCalledExactlyOnceWith(DB, SUPPLIER_ID);
    expect(mocks.listGraveyardInvoices).toHaveBeenCalledExactlyOnceWith(DB, SUPPLIER_ID);
    expect(JSON.stringify(mocks.getSupplier.mock.calls)).not.toContain("other-supplier");
    expect(JSON.stringify(mocks.listGraveyardInvoices.mock.calls)).not.toContain("other-supplier");
  });
});

describe("GraveyardPage signed in", () => {
  it("renders the demo tombstones and Totals, and closes the database", async () => {
    const html = await render();

    expect(html).toContain("Sharma Traders");
    expect(html).toContain("LPC/26-27/0412");
    expect(count(html, "<article")).toBe(6);
    expect(html).toContain("Rules as of 7 Oct 2026");
    expect(html).not.toContain(MISSING);
    expect(html).not.toContain(LOAD_FAILED);
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("shows the legend line once, under the grid", async () => {
    const html = await render();
    const entries = [
      "Taller stone = more owed",
      "Moss = days overdue",
      "Cracks = over 60 days",
      "Ember = over 45 days",
      "Wisp = promise to pay pending",
    ];
    for (const entry of entries) expect(count(html, entry)).toBe(1);
    const text = html.replace(/<[^>]*>/g, "");
    expect(count(text, entries.join(" · "))).toBe(1);
    expect(html.indexOf(entries[0]!)).toBeGreaterThan(html.lastIndexOf("</article>"));
  });
  it("shows no legend when there are no tombstones", async () => {
    mocks.listGraveyardInvoices.mockResolvedValue([]);
    const html = await render();
    expect(html).not.toContain("Taller stone = more owed");
  });
  it("shows each totals card with its themed title and plain label", async () => {
    const html = await render();
    const text = html.replace(/<[^>]*>/g, "|").replace(/\|+/g, "|");
    expect(text).toContain("|Buried in dues|Outstanding|");
    expect(text).toContain("|Interest curse|Interest accrued|");
    expect(text).toContain("|The tax bomb|Deductions at risk|");
    expect(text).toContain("|The graveyard|Counts|");
  });
  it("shows the interest card as formatINR short with full beneath, and no missing-rate text", async () => {
    const html = await render();
    const interestCard = html.slice(html.indexOf("Interest curse"), html.indexOf("The tax bomb"));
    expect(interestCard).toContain(formatINR(6236681, "short"));
    expect(interestCard).toContain(formatINR(6236681, "full"));
    expect(formatINR(6236681, "short")).not.toBe(formatINR(6236681, "full"));
    expect(interestCard).toContain("MSMED-16");
    expect(interestCard).not.toContain(MISSING);
  });
  it("shows the Demo_Date_Chip for ?today=2027-03-10", async () => {
    const html = await render({ today: "2027-03-10" });

    expect(html).toContain("Demo date: 10 Mar 2027");
    expect(mocks.getBankRate).toHaveBeenCalledWith(DB, "2027-03-10");
  });

  it("shows no chip without a today query", async () => {
    const html = await render();

    expect(html).not.toContain("Demo date");
  });

  it("shows no chip for an invalid today query and uses the IST date", async () => {
    const html = await render({ today: "2026-02-30" });

    expect(html).not.toContain("Demo date");
    expect(mocks.getBankRate).toHaveBeenCalledWith(DB, "2026-11-12");
  });
});

describe("GraveyardPage without a Bank_Rate", () => {
  beforeEach(() => {
    mocks.getBankRate.mockRejectedValue(new BankRateNotFoundError("none"));
  });

  it("still renders tombstones and Totals, with the missing-rate text in every interest slot", async () => {
    const html = await render();

    expect(html).toContain("LPC/26-27/0412");
    expect(html).toContain('aria-label="Totals"');
    const tombstones = count(html, "<article");
    expect(tombstones).toBe(6);
    // One per tombstone interest slot, plus Interest_Accrued and the rules line.
    expect(count(html, MISSING)).toBe(tombstones + 2);
    expect(html).not.toContain("Rules as of");
    expect(html).not.toContain("MSMED-16</span>");
    expect(html).not.toContain(LOAD_FAILED);
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("GraveyardPage failures", () => {
  it("renders the LoadError for any other getBankRate error", async () => {
    mocks.getBankRate.mockRejectedValue(new Error("connection refused"));

    const html = await render();

    expect(html).toContain(LOAD_FAILED);
    expect(html).not.toContain("LPC/26-27/0412");
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("shows no message, stack or SQL from the failure and links retry to /", async () => {
    const failure = new Error("select * from invoices where supplier_id = $1 failed: password authentication failed");
    failure.stack = "Error: select * from invoices\n    at secretFunction (/srv/app/internal/secret-file.ts:12:3)";
    mocks.getBankRate.mockRejectedValue(failure);

    const html = await render();

    expect(html).toContain(LOAD_FAILED);
    expect(html).not.toContain("select * from invoices");
    expect(html).not.toContain("password authentication failed");
    expect(html).not.toContain("secretFunction");
    expect(html).not.toContain("secret-file.ts");
    expect(html).not.toContain(failure.message);
    expect(html).toMatch(/<a [^>]*href="\/"[^>]*>Try again<\/a>/);
  });

  it("keeps a given today query in the retry link", async () => {
    mocks.getBankRate.mockRejectedValue(new Error("boom"));

    const html = await render({ today: "2027-03-10" });

    expect(html).toMatch(/<a [^>]*href="\/\?today=2027-03-10"[^>]*>Try again<\/a>/);
  });

  it("renders the LoadError when the database cannot be opened", async () => {
    mocks.getDb.mockImplementation(() => {
      throw new Error("DATABASE_URL is not set");
    });

    const html = await render();

    expect(html).toContain(LOAD_FAILED);
    expect(html).not.toContain("DATABASE_URL");
  });
});

describe("GraveyardPage Today", () => {
  it("reads the clock per request, rolling over at 00:00 IST", async () => {
    nowSpy.mockReturnValue(Date.parse("2026-11-12T18:29:59Z"));
    await render();
    nowSpy.mockReturnValue(Date.parse("2026-11-12T19:00:00Z"));
    await render();

    expect(mocks.getBankRate.mock.calls.map((call) => call[1])).toEqual(["2026-11-12", "2026-11-13"]);
  });
});

describe("GraveyardPage with no invoices", () => {
  it("shows the quiet empty state, an import link and zero totals", async () => {
    mocks.listGraveyardInvoices.mockResolvedValue([]);

    const html = await render();

    expect(html).toContain("The graveyard is quiet");
    expect(html).toMatch(/<a [^>]*href="\/import"[^>]*>/);
    expect(count(html, "<article")).toBe(0);
    expect(html).toContain(formatINR(0, "full"));
    expect(html).toContain(`Exploded 0 · Resurrected 0`);
    expect(html).not.toContain(LOAD_FAILED);
  });
});
