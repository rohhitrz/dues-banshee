import {
  BankRateNotFoundError,
  DEMO_SUPPLIER,
  SupplierNotFoundError,
  type Db,
  type GraveyardInvoiceRecord,
  type Supplier,
} from "@dues-banshee/db";
import type { BankRate } from "@dues-banshee/engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted above the imports, so the mock functions are hoisted with it.
const mocks = vi.hoisted(() => ({
  getSupplier: vi.fn(),
  getBankRate: vi.fn(),
  listGraveyardInvoices: vi.fn(),
}));

vi.mock("@dues-banshee/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dues-banshee/db")>()),
  getSupplier: mocks.getSupplier,
  getBankRate: mocks.getBankRate,
  listGraveyardInvoices: mocks.listGraveyardInvoices,
}));

import { loadGraveyardData } from "@/lib/graveyard/load";

const TODAY = "2026-11-12";
const SUPPLIER_ID = "00000000-0000-4000-8000-000000000001";
const SUPPLIER: Supplier = { id: SUPPLIER_ID, ...DEMO_SUPPLIER };
const BANK_RATE: BankRate = { annualBps: 575, asOf: "2026-10-07" };
const DB = {} as Db;

function record(overrides: Partial<GraveyardInvoiceRecord["invoice"]> = {}): GraveyardInvoiceRecord {
  return {
    invoice: {
      id: "inv-1",
      amountPaise: 512794,
      acceptedOn: "2026-09-02",
      supplierCategory: "small",
      supplierActivity: "manufacturing",
      ...overrides,
    },
    buyerName: "Sharma Traders",
    invoiceNumber: "LPC/26-27/0412",
    history: [],
    buyerId: "buyer-1",
    invoiceDate: "2026-09-02",
  };
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mocks.getSupplier.mockReset().mockResolvedValue(SUPPLIER);
  mocks.getBankRate.mockReset().mockResolvedValue(BANK_RATE);
  mocks.listGraveyardInvoices.mockReset().mockResolvedValue([record()]);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("loadGraveyardData", () => {
  it("returns ok with the supplier, bank rate, records and built view", async () => {
    const result = await loadGraveyardData(DB, SUPPLIER_ID, TODAY);
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    expect(result.supplier).toEqual(SUPPLIER);
    expect(result.bankRate).toEqual(BANK_RATE);
    expect(result.records).toHaveLength(1);
    expect(result.view.today).toBe(TODAY);
    expect(result.view.rulesAsOf).toBe("2026-10-07");
    expect(result.view.tombstones.map((t) => t.invoiceNumber)).toEqual(["LPC/26-27/0412"]);
    expect(mocks.getBankRate).toHaveBeenCalledWith(DB, TODAY);
    expect(mocks.listGraveyardInvoices).toHaveBeenCalledWith(DB, SUPPLIER_ID);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("maps BankRateNotFoundError to bankRate null and still returns ok", async () => {
    mocks.getBankRate.mockRejectedValue(new BankRateNotFoundError("none"));
    const result = await loadGraveyardData(DB, SUPPLIER_ID, TODAY);
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    expect(result.bankRate).toBeNull();
    expect(result.view.rulesAsOf).toBeNull();
    expect(result.view.totals.interestAccruedPaise).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("returns stale for SupplierNotFoundError without logging", async () => {
    mocks.getSupplier.mockRejectedValue(new SupplierNotFoundError("gone"));
    expect(await loadGraveyardData(DB, SUPPLIER_ID, TODAY)).toEqual({ kind: "stale" });
    expect(mocks.getBankRate).not.toHaveBeenCalled();
  });

  it("returns error with no details for any other getBankRate failure", async () => {
    mocks.getBankRate.mockRejectedValue(new Error("select * from config: connection refused"));
    const result = await loadGraveyardData(DB, SUPPLIER_ID, TODAY);
    expect(result).toEqual({ kind: "error" });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("returns error when listing invoices fails", async () => {
    mocks.listGraveyardInvoices.mockRejectedValue(new Error("boom"));
    expect(await loadGraveyardData(DB, SUPPLIER_ID, TODAY)).toEqual({ kind: "error" });
  });

  it("returns error when building throws an Engine ValidationError", async () => {
    mocks.listGraveyardInvoices.mockResolvedValue([record({ amountPaise: -1 })]);
    expect(await loadGraveyardData(DB, SUPPLIER_ID, TODAY)).toEqual({ kind: "error" });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
