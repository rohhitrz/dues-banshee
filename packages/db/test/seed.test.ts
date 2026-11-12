import { coverage, dueDate, nextEscalationStep, statutoryInterest, taxBomb } from "@dues-banshee/engine";
import type { CalendarDate, Invoice } from "@dues-banshee/engine";
import { count, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getBankRate } from "../src/bank-rate";
import type { Db } from "../src/client";
import { toEngineInvoice } from "../src/invoices";
import { DEMO_INVOICES, DEMO_SUPPLIER, seed } from "../src/seed";
import { buyers, config, invoices, suppliers } from "../src/schema";
import { cloneTestDb, createTestDb, type TestDb } from "../src/testing";

const TODAY: CalendarDate = "2026-11-12";

let template: TestDb;
const open: TestDb[] = [];

beforeAll(async () => {
  template = await createTestDb();
});

afterAll(async () => {
  await template.close();
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((t) => t.close()));
});

async function freshDb(): Promise<TestDb> {
  const t = await cloneTestDb(template);
  open.push(t);
  return t;
}

/** The natural columns of every seeded table: no generated ids, no `created_at`. */
async function naturalContents(db: Db) {
  const supplierRows = await db
    .select({
      name: suppliers.name,
      udyamNumber: suppliers.udyamNumber,
      supplierCategory: suppliers.supplierCategory,
      supplierActivity: suppliers.supplierActivity,
      udyamRegisteredOn: suppliers.udyamRegisteredOn,
    })
    .from(suppliers)
    .orderBy(suppliers.udyamNumber);
  const buyerRows = await db
    .select({ udyamNumber: suppliers.udyamNumber, name: buyers.name, nameKey: buyers.nameKey })
    .from(buyers)
    .innerJoin(suppliers, eq(suppliers.id, buyers.supplierId))
    .orderBy(buyers.nameKey);
  const invoiceRows = await db
    .select({
      udyamNumber: suppliers.udyamNumber,
      buyerNameKey: buyers.nameKey,
      invoiceNumber: invoices.invoiceNumber,
      invoiceNumberKey: invoices.invoiceNumberKey,
      invoiceDate: invoices.invoiceDate,
      acceptedOn: invoices.acceptedOn,
      acceptanceDateDefaulted: invoices.acceptanceDateDefaulted,
      agreedTermDays: invoices.agreedTermDays,
      amountPaise: invoices.amountPaise,
      paidOn: invoices.paidOn,
      supplierCategory: invoices.supplierCategory,
      supplierActivity: invoices.supplierActivity,
    })
    .from(invoices)
    .innerJoin(suppliers, eq(suppliers.id, invoices.supplierId))
    .innerJoin(buyers, eq(buyers.id, invoices.buyerId))
    .orderBy(invoices.invoiceNumberKey);
  const configRows = await db
    .select({ key: config.key, valueInt: config.valueInt, effectiveFrom: config.effectiveFrom })
    .from(config)
    .orderBy(config.key, config.effectiveFrom);
  return { supplierRows, buyerRows, invoiceRows, configRows };
}

async function rowCounts(db: Db) {
  const n = async (table: typeof suppliers | typeof buyers | typeof invoices | typeof config) => {
    const [row] = await db.select({ n: count() }).from(table);
    return row?.n ?? -1;
  };
  return {
    suppliers: await n(suppliers),
    buyers: await n(buyers),
    invoices: await n(invoices),
    config: await n(config),
  };
}

/** Engine invoice for each seeded invoice, keyed by buyer name. */
async function engineInvoicesByBuyer(db: Db): Promise<Map<string, Invoice>> {
  const rows = await db
    .select({ invoice: invoices, supplier: suppliers, buyerName: buyers.name })
    .from(invoices)
    .innerJoin(suppliers, eq(suppliers.id, invoices.supplierId))
    .innerJoin(buyers, eq(buyers.id, invoices.buyerId));
  return new Map(rows.map((r) => [r.buyerName, toEngineInvoice(r.invoice, r.supplier)]));
}

describe("seed", () => {
  it("is idempotent: seeding twice leaves identical contents and row counts", async () => {
    const t = await freshDb();
    await seed(t.db);
    const contents = await naturalContents(t.db);
    const counts = await rowCounts(t.db);
    expect(counts).toEqual({ suppliers: 1, buyers: 6, invoices: 6, config: 1 });

    await seed(t.db);
    expect(await naturalContents(t.db)).toEqual(contents);
    expect(await rowCounts(t.db)).toEqual(counts);

    // A separate database seeded once has the same natural contents.
    const other = await freshDb();
    await seed(other.db);
    expect(await naturalContents(other.db)).toEqual(contents);
  });

  it("stores the demo supplier and the six demo invoices", async () => {
    const t = await freshDb();
    await seed(t.db);
    const { supplierRows, invoiceRows } = await naturalContents(t.db);
    expect(supplierRows).toEqual([
      {
        name: DEMO_SUPPLIER.name,
        udyamNumber: DEMO_SUPPLIER.udyamNumber,
        supplierCategory: "micro",
        supplierActivity: "manufacturing",
        udyamRegisteredOn: "2024-04-15",
      },
    ]);
    expect(invoiceRows).toHaveLength(DEMO_INVOICES.length);
    for (const row of invoiceRows) {
      expect(row.supplierCategory).toBe("micro");
      expect(row.supplierActivity).toBe("manufacturing");
      expect(row.invoiceDate).toBe(row.acceptedOn);
      expect(row.acceptanceDateDefaulted).toBe(false);
    }
  });

  it("seeds the bank rate: 5.75% from 2026-10-07", async () => {
    const t = await freshDb();
    await seed(t.db);
    await expect(getBankRate(t.db, "2026-10-07")).resolves.toEqual({ annualBps: 575, asOf: "2026-10-07" });
    await expect(getBankRate(t.db, "2026-11-12")).resolves.toEqual({ annualBps: 575, asOf: "2026-10-07" });
    await expect(getBankRate(t.db, "2026-10-06")).rejects.toThrow();
  });

  describe("Engine results at 2026-11-12", () => {
    it("puts each demo invoice in its intended legal state", async () => {
      const t = await freshDb();
      await seed(t.db);
      const bankRate = await getBankRate(t.db, TODAY);
      const byBuyer = await engineInvoicesByBuyer(t.db);
      const get = (buyer: string): Invoice => {
        const inv = byBuyer.get(buyer);
        if (inv === undefined) throw new Error(`no seeded invoice for ${buyer}`);
        return inv;
      };
      const run = (buyer: string) => {
        const inv = get(buyer);
        return {
          due: dueDate(inv),
          interest: statutoryInterest(inv, TODAY, bankRate),
          bomb: taxBomb(inv, TODAY),
          ladder: nextEscalationStep(inv, [], TODAY),
          coverage: coverage(inv),
        };
      };

      const sharma = run("Sharma Traders");
      expect(sharma.due).toMatchObject({ dueDate: "2026-10-17" });
      expect(sharma.interest).toMatchObject({ accrualDays: 26, interestPaise: 512794 });
      expect(sharma.bomb).toMatchObject({ status: "armed", daysLeft: 139 });
      expect(sharma.ladder).toMatchObject({ action: "advance", step: "whatsapp_nudge" });

      const gupta = run("Gupta Engineering Works");
      expect(gupta.due).toMatchObject({ dueDate: "2026-11-16" });
      expect(gupta.interest).toMatchObject({ interestPaise: 0 });
      expect(gupta.ladder).toMatchObject({ action: "wait", reason: "not_overdue" });

      const kumar = run("Kumar Textiles");
      expect(kumar.due).toMatchObject({ dueDate: "2026-08-16" });
      expect(kumar.interest).toMatchObject({ accrualDays: 88 });

      const verma = run("Verma Auto Parts");
      expect(verma.bomb).toMatchObject({ status: "defused" });
      expect(verma.ladder).toMatchObject({ action: "wait", reason: "paid" });

      const mehta = run("Mehta Polymers");
      expect(mehta.due).toMatchObject({ dueDate: "2026-05-04" });
      expect(mehta.bomb).toMatchObject({ status: "exploded", deductionDeadline: "2026-05-04" });

      const bansal = run("Bansal Hardware");
      expect(bansal.coverage).toEqual({
        applicable: true,
        caveat: "registered_after_supply",
        ruleIds: ["MSMED-SCOPE"],
      });
      expect(bansal.due).toMatchObject({ dueDate: "2024-03-31" });
      expect(bansal.interest).toMatchObject({ accrualDays: 956, interestPaise: 3167411 });
      expect(bansal.bomb).toMatchObject({ status: "exploded" });
    });
  });
});
