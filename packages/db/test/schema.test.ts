import {
  APPROVAL_STEP_LIST,
  LADDER_STEPS,
  MAX_PAISE,
  SUPPLIER_ACTIVITIES,
  SUPPLIER_CATEGORIES,
} from "@dues-banshee/engine";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buyers, invoices, promises, suppliers } from "../src/schema";
import { cloneTestDb, createTestDb, type TestDb } from "../src/testing";

const UNIQUE_VIOLATION = "23505";
const FK_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";

interface PgFailure {
  code: string;
  constraint: string;
}

/**
 * Finds the Postgres error behind a failed query. Drizzle wraps the driver error and keeps it in
 * `cause`, so walk the chain until something carries a SQLSTATE `code`.
 */
function pgFailure(error: unknown): PgFailure {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const { code, constraint, cause } = current as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (typeof code === "string" && typeof constraint === "string") return { code, constraint };
    current = cause;
  }
  throw new Error(`no Postgres error with a constraint in the cause chain of: ${String(error)}`);
}

/** Runs `work`, expects it to reject, and returns the Postgres code and constraint name. */
async function failureOf(work: Promise<unknown>): Promise<PgFailure> {
  let caught: unknown;
  try {
    await work;
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) throw new Error("expected the statement to be rejected");
  return pgFailure(caught);
}

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

const supplierValues = (udyamNumber: string) => ({
  name: "Test Supplier",
  udyamNumber,
  supplierCategory: "micro" as const,
  supplierActivity: "manufacturing" as const,
});

/** Two suppliers, each with one buyer. */
async function seedTwoSuppliers(t: TestDb) {
  const [a, b] = await t.db
    .insert(suppliers)
    .values([supplierValues("UDYAM-MH-00-0000001"), supplierValues("UDYAM-MH-00-0000002")])
    .returning();
  if (a === undefined || b === undefined) throw new Error("suppliers not inserted");
  const [buyerA, buyerB] = await t.db
    .insert(buyers)
    .values([
      { supplierId: a.id, name: "Sharma Traders", nameKey: "sharma traders" },
      { supplierId: b.id, name: "Gupta Steel", nameKey: "gupta steel" },
    ])
    .returning();
  if (buyerA === undefined || buyerB === undefined) throw new Error("buyers not inserted");
  return { a, b, buyerA, buyerB };
}

const invoiceValues = (
  supplierId: string,
  buyerId: string,
  overrides: Partial<typeof invoices.$inferInsert> = {},
): typeof invoices.$inferInsert => ({
  supplierId,
  buyerId,
  invoiceNumber: "INV-001",
  invoiceNumberKey: "inv-001",
  invoiceDate: "2026-09-02",
  acceptedOn: "2026-09-02",
  amountPaise: 41_200_000,
  supplierCategory: "micro",
  supplierActivity: "manufacturing",
  ...overrides,
});

async function enumLabels(t: TestDb, typeName: string): Promise<string[]> {
  const result = await t.pglite.query<{ enumlabel: string }>(
    `select e.enumlabel
       from pg_enum e
       join pg_type ty on ty.oid = e.enumtypid
      where ty.typname = $1
      order by e.enumsortorder`,
    [typeName],
  );
  return result.rows.map((row) => row.enumlabel);
}

describe("enums", () => {
  it.each([
    ["ladder_step", LADDER_STEPS],
    ["approval_step", APPROVAL_STEP_LIST],
    ["supplier_category", SUPPLIER_CATEGORIES],
    ["supplier_activity", SUPPLIER_ACTIVITIES],
  ] as const)("%s holds the Engine's values in order", async (typeName, expected) => {
    expect(await enumLabels(template, typeName)).toEqual([...expected]);
  });
});

describe("suppliers_udyam_number_format", () => {
  it.each(["UDYAM-mh-00-0000000", "UDYAM-MH-0-0000000"])("rejects %s", async (udyamNumber) => {
    const t = await freshDb();
    const failure = await failureOf(t.db.insert(suppliers).values(supplierValues(udyamNumber)));
    expect(failure).toEqual({ code: CHECK_VIOLATION, constraint: "suppliers_udyam_number_format" });
  });

  it("accepts UDYAM-MH-00-0000000", async () => {
    const t = await freshDb();
    const rows = await t.db
      .insert(suppliers)
      .values(supplierValues("UDYAM-MH-00-0000000"))
      .returning({ udyamNumber: suppliers.udyamNumber });
    expect(rows).toEqual([{ udyamNumber: "UDYAM-MH-00-0000000" }]);
  });
});

describe("invoices constraints", () => {
  it("rejects a second invoice with the same supplier, buyer and invoice_number_key", async () => {
    const t = await freshDb();
    const { a, buyerA } = await seedTwoSuppliers(t);
    await t.db.insert(invoices).values(invoiceValues(a.id, buyerA.id));
    const failure = await failureOf(
      t.db.insert(invoices).values(invoiceValues(a.id, buyerA.id, { invoiceNumber: "inv-001" })),
    );
    expect(failure).toEqual({ code: UNIQUE_VIOLATION, constraint: "invoices_dedupe_key" });
  });

  it("rejects an invoice that points at another supplier's buyer", async () => {
    const t = await freshDb();
    const { a, buyerB } = await seedTwoSuppliers(t);
    const failure = await failureOf(t.db.insert(invoices).values(invoiceValues(a.id, buyerB.id)));
    expect(failure).toEqual({ code: FK_VIOLATION, constraint: "invoices_buyer_supplier_fkey" });
  });

  it.each([
    ["0", 0],
    ["MAX_PAISE + 1", MAX_PAISE + 1],
  ])("rejects amount_paise %s", async (_label, amountPaise) => {
    const t = await freshDb();
    const { a, buyerA } = await seedTwoSuppliers(t);
    const failure = await failureOf(
      t.db.insert(invoices).values(invoiceValues(a.id, buyerA.id, { amountPaise })),
    );
    expect(failure).toEqual({ code: CHECK_VIOLATION, constraint: "invoices_amount_range" });
  });

  it.each([1, MAX_PAISE])("accepts amount_paise %i at the edge of the range", async (amountPaise) => {
    const t = await freshDb();
    const { a, buyerA } = await seedTwoSuppliers(t);
    const rows = await t.db
      .insert(invoices)
      .values(invoiceValues(a.id, buyerA.id, { amountPaise }))
      .returning({ amountPaise: invoices.amountPaise });
    expect(rows).toEqual([{ amountPaise }]);
  });

  it("rejects agreed_term_days 0", async () => {
    const t = await freshDb();
    const { a, buyerA } = await seedTwoSuppliers(t);
    const failure = await failureOf(
      t.db.insert(invoices).values(invoiceValues(a.id, buyerA.id, { agreedTermDays: 0 })),
    );
    expect(failure).toEqual({ code: CHECK_VIOLATION, constraint: "invoices_term_positive" });
  });
});

describe("column round-trips through Drizzle", () => {
  it("returns a date column as the string 2026-09-02", async () => {
    const t = await freshDb();
    const { a, buyerA } = await seedTwoSuppliers(t);
    await t.db.insert(invoices).values(invoiceValues(a.id, buyerA.id, { invoiceDate: "2026-09-02" }));
    const [row] = await t.db
      .select({ invoiceDate: invoices.invoiceDate })
      .from(invoices)
      .where(eq(invoices.supplierId, a.id));
    expect(row?.invoiceDate).toBe("2026-09-02");
  });

  it("returns a bigint amount of 10^13 as the number 10000000000000", async () => {
    // 10^13 is above MAX_PAISE, so invoices would reject it. promises.amount_paise is the same
    // bigint number-mode column type without the range check.
    const t = await freshDb();
    const { a, buyerA } = await seedTwoSuppliers(t);
    const [invoice] = await t.db
      .insert(invoices)
      .values(invoiceValues(a.id, buyerA.id))
      .returning({ id: invoices.id });
    if (invoice === undefined) throw new Error("invoice not inserted");
    await t.db.insert(promises).values({
      invoiceId: invoice.id,
      promisedDate: "2026-10-01",
      amountPaise: 10_000_000_000_000,
      recordedOn: "2026-09-20",
    });
    const [row] = await t.db.select({ amountPaise: promises.amountPaise }).from(promises);
    expect(row?.amountPaise).toBe(10_000_000_000_000);
    expect(typeof row?.amountPaise).toBe("number");

    // The column really is a 64-bit integer, not a 32-bit one that would have rejected the insert.
    const type = await t.pglite.query<{ data_type: string }>(
      `select data_type from information_schema.columns
        where table_name = 'promises' and column_name = 'amount_paise'`,
    );
    expect(type.rows).toEqual([{ data_type: "bigint" }]);
  });
});
