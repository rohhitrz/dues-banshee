import { buildImport, detectHeader, mapRow, dedupeKey } from "@dues-banshee/ledger";
import type { OkRow, RawTable, SupplierFacts } from "@dues-banshee/ledger";
import { count, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BANK_RATE_KEY, getBankRate } from "../src/bank-rate";
import { findStoredInvoices, importInvoices, toEngineInvoice } from "../src/invoices";
import { buyers, config, invoices, suppliers, type SupplierRow } from "../src/schema";
import { getSupplier } from "../src/suppliers";
import { cloneTestDb, createTestDb, type TestDb } from "../src/testing";

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

/** A fresh, independent copy of the migrated template. */
async function freshDb(): Promise<TestDb> {
  const t = await cloneTestDb(template);
  open.push(t);
  return t;
}

async function insertSupplier(
  t: TestDb,
  overrides: Partial<typeof suppliers.$inferInsert> = {},
): Promise<SupplierRow> {
  const [row] = await t.db
    .insert(suppliers)
    .values({
      name: "Banshee Engineering Works",
      udyamNumber: "UDYAM-MH-26-0123456",
      supplierCategory: "small",
      supplierActivity: "services",
      udyamRegisteredOn: "2024-04-15",
      ...overrides,
    })
    .returning();
  if (row === undefined) throw new Error("supplier not inserted");
  return row;
}

const HEADER = ["Invoice No", "Party Name", "Amount", "Invoice Date", "Credit Days"];

function table(rows: readonly (readonly string[])[]): RawTable {
  return [HEADER, ...rows].map((cells, i) => ({ rowNumber: i + 1, cells }));
}

const THREE_ROWS = [
  ["INV-001", "Sharma Traders", "412000", "02/09/2026", "30"],
  ["INV-002", "Sharma Traders", "15000", "10/09/2026", ""],
  ["INV-003", "Gupta Steel", "99999.50", "15/09/2026", "45"],
] as const;

/** Runs the Ledger's `buildImport` and returns its ok rows, failing if any row is an error. */
function okRowsFromBuildImport(rows: readonly (readonly string[])[], supplier: SupplierFacts): OkRow[] {
  const parsed = buildImport(table(rows), supplier);
  if (!parsed.ok) throw new Error(`buildImport failed: ${JSON.stringify(parsed.fileErrors)}`);
  const ok = parsed.rows.filter((r): r is OkRow => r.ok);
  if (ok.length !== rows.length) throw new Error(`expected ${rows.length} ok rows, got ${JSON.stringify(parsed.rows)}`);
  return ok;
}

/** Runs the Ledger's `mapRow` on each row against the detected header mapping. */
function okRowsFromMapRow(rows: readonly (readonly string[])[], supplier: SupplierFacts): OkRow[] {
  const raw = table(rows);
  const header = detectHeader(raw);
  if (!header.ok) throw new Error(`detectHeader failed: ${JSON.stringify(header.errors)}`);
  return raw.slice(1).map((row) => {
    const result = mapRow(row, header.mapping, supplier);
    if (!result.ok) throw new Error(`mapRow failed: ${JSON.stringify(result.errors)}`);
    return result;
  });
}

/** Every message, constraint name and cause along an error's `cause` chain, joined. */
function causeChainText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const { message, constraint, cause } = current as { message?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof message === "string") parts.push(message);
    if (typeof constraint === "string") parts.push(constraint);
    current = cause;
  }
  return parts.join("\n");
}

async function tableCount(t: TestDb, target: typeof buyers | typeof invoices): Promise<number> {
  const [row] = await t.db.select({ n: count() }).from(target);
  return row?.n ?? -1;
}

describe("getBankRate", () => {
  async function withRates(): Promise<TestDb> {
    const t = await freshDb();
    await t.db.insert(config).values([
      { key: BANK_RATE_KEY, valueInt: 675, effectiveFrom: "2025-02-07" },
      { key: BANK_RATE_KEY, valueInt: 575, effectiveFrom: "2026-10-07" },
      { key: BANK_RATE_KEY, valueInt: 625, effectiveFrom: "2025-06-06" },
      // Another key with a later date must not be picked.
      { key: "some_other_key", valueInt: 1, effectiveFrom: "2026-01-01" },
    ]);
    return t;
  }

  it.each([
    ["2025-02-07", 675, "2025-02-07"],
    ["2025-06-05", 675, "2025-02-07"],
    ["2025-06-06", 625, "2025-06-06"],
    ["2026-10-06", 625, "2025-06-06"],
    ["2026-10-07", 575, "2026-10-07"],
    ["2026-11-12", 575, "2026-10-07"],
  ])("on %s returns %i bps as of %s", async (today, annualBps, asOf) => {
    const t = await withRates();
    expect(await getBankRate(t.db, today)).toEqual({ annualBps, asOf });
  });

  it("throws before the first row, naming the key and today", async () => {
    const t = await withRates();
    await expect(getBankRate(t.db, "2025-02-06")).rejects.toThrow(
      'config "rbi_bank_rate_bps": no row effective on or before 2025-02-06',
    );
  });

  it("throws when no row exists at all", async () => {
    const t = await freshDb();
    await expect(getBankRate(t.db, "2026-10-07")).rejects.toThrow(/rbi_bank_rate_bps.*2026-10-07/);
  });

  it.each(["2026-02-30", "07/10/2026", ""])("throws on the invalid today %j", async (today) => {
    const t = await withRates();
    await expect(getBankRate(t.db, today)).rejects.toThrow(/today must be a valid YYYY-MM-DD date/);
  });
});

describe("importInvoices", () => {
  it("imports 3 rows, then skips all 3 on the second import", async () => {
    const t = await freshDb();
    const supplier = await getSupplier(t.db, (await insertSupplier(t)).id);
    const rows = okRowsFromBuildImport(THREE_ROWS, supplier);

    expect(await importInvoices(t.db, supplier.id, rows)).toEqual({ inserted: 3, skipped: 0 });
    const again = okRowsFromBuildImport(THREE_ROWS, supplier);
    expect(await importInvoices(t.db, supplier.id, again)).toEqual({ inserted: 0, skipped: 3 });

    expect(await tableCount(t, invoices)).toBe(3);
    expect(await tableCount(t, buyers)).toBe(2);
  });

  it("never updates a stored invoice when a re-import carries a different amount", async () => {
    const t = await freshDb();
    const supplier = await getSupplier(t.db, (await insertSupplier(t)).id);
    await importInvoices(t.db, supplier.id, okRowsFromBuildImport(THREE_ROWS, supplier));

    const changed = okRowsFromBuildImport([["INV-001", "  SHARMA   traders ", "415000", "03/09/2026", "15"]], supplier);
    expect(await importInvoices(t.db, supplier.id, changed)).toEqual({ inserted: 0, skipped: 1 });

    const stored = await t.db
      .select({ amountPaise: invoices.amountPaise, invoiceDate: invoices.invoiceDate, agreedTermDays: invoices.agreedTermDays })
      .from(invoices)
      .where(eq(invoices.invoiceNumberKey, "inv-001"));
    expect(stored).toEqual([{ amountPaise: 41_200_000, invoiceDate: "2026-09-02", agreedTermDays: 30 }]);
  });

  it("rolls back buyers and invoices when an invoice insert fails after buyers were written", async () => {
    const t = await freshDb();
    const supplier = await getSupplier(t.db, (await insertSupplier(t)).id);
    const valid = okRowsFromMapRow(
      [
        ["R-1", "Verma Polymers", "1000", "01/09/2026", ""],
        ["R-2", "Iyer Castings", "2000", "02/09/2026", "20"],
        ["R-3", "Khan Fabricators", "3000", "03/09/2026", ""],
      ],
      supplier,
    );
    const template = valid[0];
    if (template === undefined) throw new Error("no valid row");
    // mapRow rejects a zero amount, so the bad row is built by hand.
    const bad: OkRow = {
      ...template,
      rowNumber: 5,
      buyerName: "Bad Row Buyer",
      invoiceNumber: "R-4",
      dedupeKey: dedupeKey(supplier.id, "Bad Row Buyer", "R-4"),
      invoice: { ...template.invoice, amountPaise: 0 },
    };

    let caught: unknown;
    try {
      await importInvoices(t.db, supplier.id, [...valid, bad]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(causeChainText(caught)).toContain("invoices_amount_range");

    expect(await tableCount(t, buyers)).toBe(0);
    expect(await tableCount(t, invoices)).toBe(0);
  });

  it("copies the supplier's category and activity onto every imported invoice", async () => {
    const t = await freshDb();
    const small = await insertSupplier(t);
    const micro = await insertSupplier(t, {
      name: "Other Supplier",
      udyamNumber: "UDYAM-DL-01-7654321",
      supplierCategory: "micro",
      supplierActivity: "manufacturing",
      udyamRegisteredOn: null,
    });
    for (const s of [small, micro]) {
      const facts = await getSupplier(t.db, s.id);
      await importInvoices(t.db, s.id, okRowsFromBuildImport(THREE_ROWS, facts));
    }

    const rows = await t.db
      .select({
        invoiceCategory: invoices.supplierCategory,
        invoiceActivity: invoices.supplierActivity,
        supplierCategory: suppliers.supplierCategory,
        supplierActivity: suppliers.supplierActivity,
      })
      .from(invoices)
      .innerJoin(suppliers, eq(suppliers.id, invoices.supplierId));
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(r.invoiceCategory).toBe(r.supplierCategory);
      expect(r.invoiceActivity).toBe(r.supplierActivity);
    }
  });
});

describe("findStoredInvoices", () => {
  it("returns the stored amount and dates for existing keys only", async () => {
    const t = await freshDb();
    const supplier = await getSupplier(t.db, (await insertSupplier(t)).id);
    const rows = okRowsFromBuildImport(THREE_ROWS, supplier);
    await importInvoices(t.db, supplier.id, rows.slice(0, 2));

    const keys = [
      ...rows.map((r) => r.dedupeKey),
      dedupeKey(supplier.id, "Sharma Traders", "INV-999"),
      dedupeKey(supplier.id, "Nobody", "INV-001"),
    ];
    const found = await findStoredInvoices(t.db, supplier.id, keys);

    expect(found).toEqual(
      new Map([
        [rows[0]?.dedupeKey.value, { amountPaise: 41_200_000, invoiceDate: "2026-09-02", acceptedOn: "2026-09-02" }],
        [rows[1]?.dedupeKey.value, { amountPaise: 1_500_000, invoiceDate: "2026-09-10", acceptedOn: "2026-09-10" }],
      ]),
    );
  });

  it("returns an empty map for no keys", async () => {
    const t = await freshDb();
    const supplier = await insertSupplier(t);
    expect(await findStoredInvoices(t.db, supplier.id, [])).toEqual(new Map());
  });
});

describe("toEngineInvoice", () => {
  async function storedInvoice(t: TestDb, supplier: SupplierRow, extra: Partial<typeof invoices.$inferInsert>) {
    const [buyer] = await t.db
      .insert(buyers)
      .values({ supplierId: supplier.id, name: "Sharma Traders", nameKey: "sharma traders" })
      .returning();
    if (buyer === undefined) throw new Error("buyer not inserted");
    const [row] = await t.db
      .insert(invoices)
      .values({
        supplierId: supplier.id,
        buyerId: buyer.id,
        invoiceNumber: "INV-001",
        invoiceNumberKey: "inv-001",
        invoiceDate: "2026-09-02",
        acceptedOn: "2026-09-05",
        amountPaise: 41_200_000,
        // Deliberately different from the supplier, to show the snapshot is what's used.
        supplierCategory: "micro",
        supplierActivity: "manufacturing",
        ...extra,
      })
      .returning();
    if (row === undefined) throw new Error("invoice not inserted");
    return row;
  }

  it("omits agreedTermDays, paidOn and udyamRegisteredOn when they are null", async () => {
    const t = await freshDb();
    const supplier = await insertSupplier(t, { udyamRegisteredOn: null });
    const row = await storedInvoice(t, supplier, {});

    const result = toEngineInvoice(row, supplier);

    expect(result).toEqual({
      id: row.id,
      amountPaise: 41_200_000,
      acceptedOn: "2026-09-05",
      supplierCategory: "micro",
      supplierActivity: "manufacturing",
    });
    expect(Object.hasOwn(result, "agreedTermDays")).toBe(false);
    expect(Object.hasOwn(result, "paidOn")).toBe(false);
    expect(Object.hasOwn(result, "udyamRegisteredOn")).toBe(false);
  });

  it("includes agreedTermDays, paidOn and udyamRegisteredOn when they are set", async () => {
    const t = await freshDb();
    const supplier = await insertSupplier(t, { udyamRegisteredOn: "2024-04-15" });
    const row = await storedInvoice(t, supplier, { agreedTermDays: 30, paidOn: "2026-10-20" });

    expect(toEngineInvoice(row, supplier)).toStrictEqual({
      id: row.id,
      amountPaise: 41_200_000,
      acceptedOn: "2026-09-05",
      agreedTermDays: 30,
      supplierCategory: "micro",
      supplierActivity: "manufacturing",
      udyamRegisteredOn: "2024-04-15",
      paidOn: "2026-10-20",
    });
  });
});
