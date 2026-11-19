import {
  BankRateNotFoundError,
  DEMO_SUPPLIER,
  SupplierNotFoundError,
  type DebtorData,
  type Db,
  type Supplier,
} from "@dues-banshee/db";
import type { BankRate } from "@dues-banshee/engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted above the imports, so the mock functions are hoisted with it.
const mocks = vi.hoisted(() => ({
  getSupplier: vi.fn(),
  getBankRate: vi.fn(),
  getDebtorData: vi.fn(),
  listPendingDrafts: vi.fn(),
  listSendState: vi.fn(),
}));

vi.mock("@dues-banshee/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dues-banshee/db")>()),
  getSupplier: mocks.getSupplier,
  getBankRate: mocks.getBankRate,
  getDebtorData: mocks.getDebtorData,
  listPendingDrafts: mocks.listPendingDrafts,
  listSendState: mocks.listSendState,
}));

import { loadDebtorData } from "@/lib/debtor/load";

const SUPPLIER_ID = "00000000-0000-4000-8000-000000000001";
const BUYER_ID = "11111111-1111-4111-8111-111111111111";
const INVOICE_ID = "22222222-2222-4222-8222-222222222222";
const DEMO: Supplier = { id: SUPPLIER_ID, ...DEMO_SUPPLIER };
const OTHER: Supplier = { ...DEMO, udyamNumber: "UDYAM-XX-00-0000000" };
const BANK_RATE: BankRate = { annualBps: 575, asOf: "2026-10-07" };
const DB = {} as Db;

// 2026-11-12T10:00:00Z = 15:30 IST on 2026-11-12.
const NOW_MS = Date.UTC(2026, 10, 12, 10, 0, 0);
// 2026-11-12T20:00:00Z = 01:30 IST on 2026-11-13, so the IST date differs from the UTC date.
const NOW_LATE_MS = Date.UTC(2026, 10, 12, 20, 0, 0);

const DEBTOR_DATA: DebtorData = {
  buyer: { id: BUYER_ID, name: "Sharma Traders" },
  records: [
    {
      invoice: {
        id: INVOICE_ID,
        amountPaise: 41200000,
        acceptedOn: "2026-09-02",
        agreedTermDays: 45,
        supplierCategory: "small",
        supplierActivity: "manufacturing",
      },
      buyerName: "Sharma Traders",
      invoiceNumber: "LPC/26-27/0412",
      history: [],
      buyerId: BUYER_ID,
      invoiceDate: "2026-09-02",
    },
  ],
  events: [],
  promises: [],
};

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mocks.getSupplier.mockReset().mockResolvedValue(DEMO);
  mocks.getBankRate.mockReset().mockResolvedValue(BANK_RATE);
  mocks.getDebtorData.mockReset().mockResolvedValue(DEBTOR_DATA);
  mocks.listPendingDrafts.mockReset().mockResolvedValue([]);
  mocks.listSendState.mockReset().mockResolvedValue({ buyerHasNumber: false, invoices: [] });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("loadDebtorData", () => {
  it.each([BUYER_ID, "not-a-uuid", "", "../../etc/passwd"])(
    "returns stale for id %j before any id check or buyer query",
    async (id) => {
      mocks.getSupplier.mockRejectedValue(new SupplierNotFoundError("gone"));
      expect(await loadDebtorData(DB, SUPPLIER_ID, id, NOW_MS, undefined)).toEqual({ kind: "stale" });
      expect(mocks.getBankRate).not.toHaveBeenCalled();
      expect(mocks.getDebtorData).not.toHaveBeenCalled();
      expect(mocks.listPendingDrafts).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    },
  );

  it.each(["not-a-uuid", "", "1234", `${BUYER_ID}x`, `${BUYER_ID}/extra`, "'; drop table buyers;--"])(
    "returns not_found for non-uuid id %j without calling getDebtorData",
    async (id) => {
      expect(await loadDebtorData(DB, SUPPLIER_ID, id, NOW_MS, undefined)).toEqual({ kind: "not_found" });
      expect(mocks.getDebtorData).not.toHaveBeenCalled();
      expect(mocks.listPendingDrafts).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    },
  );

  it("returns not_found when getDebtorData returns null (unknown or another supplier's buyer)", async () => {
    mocks.getDebtorData.mockResolvedValue(null);
    expect(await loadDebtorData(DB, SUPPLIER_ID, BUYER_ID, NOW_MS, undefined)).toEqual({ kind: "not_found" });
    expect(mocks.getDebtorData).toHaveBeenCalledWith(DB, SUPPLIER_ID, BUYER_ID, "2026-11-12");
    expect(mocks.listPendingDrafts).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("returns error carrying the override when a read throws after Today was resolved", async () => {
    mocks.getDebtorData.mockRejectedValue(new Error("select * from buyers: connection refused"));
    const result = await loadDebtorData(DB, SUPPLIER_ID, BUYER_ID, NOW_MS, "2027-03-10");
    expect(result).toEqual({ kind: "error", override: "2027-03-10" });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("returns error with override null when the first read throws before Today is resolved", async () => {
    mocks.getSupplier.mockRejectedValue(new Error("connection refused"));
    const result = await loadDebtorData(DB, SUPPLIER_ID, BUYER_ID, NOW_MS, "2027-03-10");
    expect(result).toEqual({ kind: "error", override: null });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("returns error when getBankRate fails with anything but BankRateNotFoundError", async () => {
    mocks.getBankRate.mockRejectedValue(new Error("boom"));
    expect(await loadDebtorData(DB, SUPPLIER_ID, BUYER_ID, NOW_MS, undefined)).toEqual({
      kind: "error",
      override: null,
    });
    expect(mocks.getDebtorData).not.toHaveBeenCalled();
  });

  it("returns ok with no Bank_Rate when BankRateNotFoundError is thrown", async () => {
    mocks.getBankRate.mockRejectedValue(new BankRateNotFoundError("none"));
    const result = await loadDebtorData(DB, SUPPLIER_ID, BUYER_ID, NOW_MS, "2026-11-12");
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    expect(result.view.buyerId).toBe(BUYER_ID);
    expect(result.view.buyerName).toBe("Sharma Traders");
    expect(result.view.panels).toHaveLength(1);
    expect(result.view.panels[0]?.tombstone.interest).toBeNull();
    expect(result.view.panels[0]?.tombstone.principalPaise).toBe(41200000);
    expect(result.view.panels[0]?.tombstone.daysOverdue).toBe(26);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("returns ok with the demo date override for the demo supplier", async () => {
    const result = await loadDebtorData(DB, SUPPLIER_ID, BUYER_ID, NOW_MS, "2027-03-10");
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    expect(result.view.today).toBe("2027-03-10");
    expect(result.view.override).toBe("2027-03-10");
    expect(result.view.supplierName).toBe(DEMO.name);
    expect(mocks.getBankRate).toHaveBeenCalledWith(DB, "2027-03-10");
    expect(mocks.getDebtorData).toHaveBeenCalledWith(DB, SUPPLIER_ID, BUYER_ID, "2027-03-10");
    expect(mocks.listPendingDrafts).toHaveBeenCalledWith(DB, SUPPLIER_ID);
  });

  it("ignores the same ?today= for another supplier and uses the real IST date", async () => {
    mocks.getSupplier.mockResolvedValue(OTHER);
    const result = await loadDebtorData(DB, SUPPLIER_ID, BUYER_ID, NOW_LATE_MS, "2027-03-10");
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    expect(result.view.today).toBe("2026-11-13");
    expect(result.view.override).toBeNull();
    expect(mocks.getBankRate).toHaveBeenCalledWith(DB, "2026-11-13");
  });

  it("uses the real IST date for the demo supplier when there is no valid override", async () => {
    const result = await loadDebtorData(DB, SUPPLIER_ID, BUYER_ID, NOW_LATE_MS, "2099-01-01");
    if (result.kind !== "ok") throw new Error(`expected ok, got ${result.kind}`);
    expect(result.view.today).toBe("2026-11-13");
    expect(result.view.override).toBeNull();
  });
});
