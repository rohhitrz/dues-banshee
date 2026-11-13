import { detectHeader, mapRow } from "@dues-banshee/ledger";
import type { OkRow, RawTable } from "@dues-banshee/ledger";
import { count, eq, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BANK_RATE_KEY } from "../src/bank-rate";
import type { Db } from "../src/client";
import { importInvoices } from "../src/invoices";
import { RESET_TABLES, resetDemo } from "../src/reset";
import * as schema from "../src/schema";
import { buyers, config, escalationEvents, invoices, suppliers } from "../src/schema";
import * as seedModule from "../src/seed";
import { DEMO_SUPPLIER, seed } from "../src/seed";
import { findSupplierIdByUdyam, getSupplier } from "../src/suppliers";
import { cloneTestDb, createTestDb, type TestDb } from "../src/testing";
import { main, REFUSAL_MESSAGE, type ResetDemoDeps } from "../scripts/reset-demo";

let template: TestDb;
const open: TestDb[] = [];

beforeAll(async () => {
  template = await createTestDb();
});

afterAll(async () => {
  await template.close();
});

afterEach(async () => {
  vi.restoreAllMocks();
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
  return { supplierRows, buyerRows, invoiceRows };
}

async function configContents(db: Db) {
  return db
    .select({ key: config.key, valueInt: config.valueInt, effectiveFrom: config.effectiveFrom })
    .from(config)
    .orderBy(config.key, config.effectiveFrom);
}

async function invoiceCount(db: Db): Promise<number> {
  const [row] = await db.select({ n: count() }).from(invoices);
  return row?.n ?? -1;
}

const HEADER = ["Invoice No", "Party Name", "Amount", "Invoice Date", "Credit Days"];
const EXTRA_ROWS = [
  ["X-001", "Extra Buyer One", "10000", "01/10/2026", "30"],
  ["X-002", "Extra Buyer Two", "20000", "02/10/2026", ""],
  ["X-003", "Extra Buyer Three", "30000.50", "03/10/2026", "45"],
] as const;

/** Imports the three extra rows for the demo supplier, mapped by the Ledger's `mapRow`. */
async function importExtraRows(db: Db): Promise<void> {
  const supplierId = await findSupplierIdByUdyam(db, DEMO_SUPPLIER.udyamNumber);
  if (supplierId === null) throw new Error("demo supplier missing");
  const supplier = await getSupplier(db, supplierId);
  const raw: RawTable = [HEADER, ...EXTRA_ROWS].map((cells, i) => ({ rowNumber: i + 1, cells }));
  const header = detectHeader(raw);
  if (!header.ok) throw new Error(`detectHeader failed: ${JSON.stringify(header.errors)}`);
  const rows: OkRow[] = raw.slice(1).map((row) => {
    const result = mapRow(row, header.mapping, supplier);
    if (!result.ok) throw new Error(`mapRow failed: ${JSON.stringify(result.errors)}`);
    return result;
  });
  expect(await importInvoices(db, supplierId, rows)).toEqual({ inserted: 3, skipped: 0 });
}

const EXTRA_CONFIG = { key: BANK_RATE_KEY, valueInt: 600, effectiveFrom: "2027-01-01" } as const;

describe("RESET_TABLES", () => {
  it("equals every table in schema.ts except config", () => {
    const schemaTables: string[] = [];
    for (const value of Object.values<unknown>(schema)) {
      if (is(value, PgTable)) schemaTables.push(getTableName(value));
    }
    expect(schemaTables).toContain("config");
    expect(new Set(RESET_TABLES)).toEqual(new Set(schemaTables.filter((name) => name !== "config")));
    expect(new Set(RESET_TABLES).size).toBe(RESET_TABLES.length);
  });
});

describe("resetDemo", () => {
  it("restores the freshly seeded contents and keeps the extra config row", async () => {
    const fresh = await freshDb();
    await seed(fresh.db);
    const expected = await naturalContents(fresh.db);
    const expectedConfig = await configContents(fresh.db);

    const t = await freshDb();
    await seed(t.db);
    await importExtraRows(t.db);
    await t.db.insert(config).values(EXTRA_CONFIG);
    const [extraInvoice] = await t.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.invoiceNumberKey, "x-001"));
    if (extraInvoice === undefined) throw new Error("extra invoice missing");
    await t.db.insert(escalationEvents).values({
      invoiceId: extraInvoice.id,
      step: "whatsapp_nudge",
      occurredOn: "2026-11-01",
      action: "approved",
    });
    expect(await invoiceCount(t.db)).toBe(9);

    await resetDemo(t.db);

    expect(await naturalContents(t.db)).toEqual(expected);
    expect(await configContents(t.db)).toEqual(
      [...expectedConfig, EXTRA_CONFIG].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)),
    );
    const [events] = await t.db.select({ n: count() }).from(escalationEvents);
    expect(events?.n).toBe(0);
  });

  it("rolls back and keeps the old data when the reseed throws", async () => {
    const t = await freshDb();
    await seed(t.db);
    await importExtraRows(t.db);
    const before = await naturalContents(t.db);
    expect(before.invoiceRows).toHaveLength(9);

    vi.spyOn(seedModule, "seed").mockRejectedValue(new Error("seed exploded"));

    await expect(resetDemo(t.db)).rejects.toThrow("seed exploded");
    expect(seedModule.seed).toHaveBeenCalledTimes(1);

    vi.restoreAllMocks();
    const after = await naturalContents(t.db);
    expect(after).toEqual(before);
    expect(after.invoiceRows.map((r) => r.invoiceNumber)).toEqual(
      expect.arrayContaining(EXTRA_ROWS.map((r) => r[0])),
    );
  });
});

describe("reset-demo main", () => {
  function stubDeps() {
    const close = vi.fn(async () => {});
    return {
      createDb: vi.fn<ResetDemoDeps["createDb"]>(() => ({ db: {} as Db, close })),
      resetDemo: vi.fn<ResetDemoDeps["resetDemo"]>(async () => {}),
      log: vi.fn<ResetDemoDeps["log"]>(),
      error: vi.fn<ResetDemoDeps["error"]>(),
    };
  }

  it("refuses without --yes: exit 1, refusal message, no client created", async () => {
    const deps = stubDeps();
    const env = { DATABASE_URL: "postgres://user:secret@db.example.com:5432/prod" };

    expect(await main([], env, deps)).toBe(1);

    expect(deps.error).toHaveBeenCalledWith(REFUSAL_MESSAGE);
    expect(deps.createDb).not.toHaveBeenCalled();
    expect(deps.resetDemo).not.toHaveBeenCalled();
  });

  it("exits 1 when DATABASE_URL is unset, without creating a client", async () => {
    const deps = stubDeps();

    expect(await main(["--yes"], {}, deps)).toBe(1);

    expect(deps.error).toHaveBeenCalledWith("DATABASE_URL is not set");
    expect(deps.createDb).not.toHaveBeenCalled();
  });
});
