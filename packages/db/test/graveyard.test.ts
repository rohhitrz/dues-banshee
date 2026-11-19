import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getBankRate } from "../src/bank-rate";
import { BankRateNotFoundError, SupplierNotFoundError } from "../src/errors";
import { listGraveyardInvoices, type GraveyardInvoiceRecord } from "../src/graveyard";
import { seed } from "../src/seed";
import { buyers, escalationEvents, invoices, promises, suppliers } from "../src/schema";
import { getSupplier } from "../src/suppliers";
import { cloneTestDb, createTestDb, type TestDb } from "../src/testing";

const TODAY = "2026-11-12";

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

/** A fresh database holding only the demo seed, and the demo supplier's id. */
async function seeded(): Promise<{ t: TestDb; supplierId: string }> {
  const t = await freshDb();
  await seed(t.db);
  const [row] = await t.db.select({ id: suppliers.id }).from(suppliers);
  if (row === undefined) throw new Error("demo supplier missing after seed");
  return { t, supplierId: row.id };
}

/** Records sorted by invoice number, because the read orders by invoice id (a random uuid). */
function byInvoiceNumber(records: readonly GraveyardInvoiceRecord[]): GraveyardInvoiceRecord[] {
  return [...records].sort((a, b) => (a.invoiceNumber < b.invoiceNumber ? -1 : a.invoiceNumber > b.invoiceNumber ? 1 : 0));
}

function recordFor(records: readonly GraveyardInvoiceRecord[], invoiceNumber: string): GraveyardInvoiceRecord {
  const found = records.find((r) => r.invoiceNumber === invoiceNumber);
  if (found === undefined) throw new Error(`no record for ${invoiceNumber}`);
  return found;
}

/** Inserts a second supplier with one buyer, one invoice, one step and one promise. */
async function insertOtherSupplier(t: TestDb, buyerName: string) {
  const [supplier] = await t.db
    .insert(suppliers)
    .values({
      name: "Other Works",
      udyamNumber: "UDYAM-GJ-01-7654321",
      supplierCategory: "small",
      supplierActivity: "services",
      udyamRegisteredOn: "2023-01-10",
    })
    .returning();
  if (supplier === undefined) throw new Error("supplier not inserted");
  const [buyer] = await t.db
    .insert(buyers)
    .values({ supplierId: supplier.id, name: buyerName, nameKey: buyerName.toLowerCase() })
    .returning();
  if (buyer === undefined) throw new Error("buyer not inserted");
  const [invoice] = await t.db
    .insert(invoices)
    .values({
      supplierId: supplier.id,
      buyerId: buyer.id,
      invoiceNumber: "OTH/26-27/0001",
      invoiceNumberKey: "oth/26-27/0001",
      invoiceDate: "2026-08-01",
      acceptedOn: "2026-08-01",
      agreedTermDays: 30,
      amountPaise: 7_700_000,
      supplierCategory: "small",
      supplierActivity: "services",
    })
    .returning();
  if (invoice === undefined) throw new Error("invoice not inserted");
  await t.db.insert(escalationEvents).values({
    invoiceId: invoice.id,
    step: "voice_call",
    occurredOn: "2026-10-01",
    action: "approved",
  });
  await t.db
    .insert(promises)
    .values({ invoiceId: invoice.id, promisedDate: "2026-11-30", amountPaise: 7_700_000, recordedOn: "2026-10-02" });
  return { supplier, buyer, invoice };
}

describe("listGraveyardInvoices", () => {
  it("returns the six demo records with buyer names, invoice numbers and empty history", async () => {
    const { t, supplierId } = await seeded();

    const records = byInvoiceNumber(await listGraveyardInvoices(t.db, supplierId, TODAY));

    expect(records.map((r) => [r.invoiceNumber, r.buyerName])).toEqual([
      ["LPC/23-24/0098", "Bansal Hardware"],
      ["LPC/25-26/0388", "Mehta Polymers"],
      ["LPC/26-27/0301", "Kumar Textiles"],
      ["LPC/26-27/0377", "Verma Auto Parts"],
      ["LPC/26-27/0412", "Sharma Traders"],
      ["LPC/26-27/0466", "Gupta Engineering Works"],
    ]);
    // The seed holds no escalation steps and no promises.
    for (const r of records) expect(r.history).toEqual([]);
  });

  it("carries the Engine invoice for each demo record", async () => {
    const { t, supplierId } = await seeded();
    const records = await listGraveyardInvoices(t.db, supplierId, TODAY);

    const sharma = recordFor(records, "LPC/26-27/0412");
    expect(sharma.invoice).toStrictEqual({
      id: sharma.invoice.id,
      amountPaise: 41_200_000,
      acceptedOn: "2026-09-02",
      agreedTermDays: 45,
      supplierCategory: "micro",
      supplierActivity: "manufacturing",
      udyamRegisteredOn: "2024-04-15",
    });

    const verma = recordFor(records, "LPC/26-27/0377");
    expect(verma.invoice).toStrictEqual({
      id: verma.invoice.id,
      amountPaise: 8_500_000,
      acceptedOn: "2026-08-10",
      agreedTermDays: 30,
      supplierCategory: "micro",
      supplierActivity: "manufacturing",
      udyamRegisteredOn: "2024-04-15",
      paidOn: "2026-09-05",
    });

    expect(new Set(records.map((r) => r.invoice.id)).size).toBe(6);
  });

  it("returns step and promise history merged and ordered by date, whatever the insert order", async () => {
    const { t, supplierId } = await seeded();
    const sharma = recordFor(await listGraveyardInvoices(t.db, supplierId, TODAY), "LPC/26-27/0412");
    const invoiceId = sharma.invoice.id;

    await t.db.insert(escalationEvents).values([
      { invoiceId, step: "whatsapp_paylink", occurredOn: "2026-11-02", action: "approved" },
      { invoiceId, step: "whatsapp_nudge", occurredOn: "2026-10-20", action: "approved" },
    ]);
    await t.db
      .insert(promises)
      .values({ invoiceId, promisedDate: "2026-11-20", amountPaise: 20_000_000, recordedOn: "2026-10-28" });

    const records = await listGraveyardInvoices(t.db, supplierId, TODAY);

    expect(recordFor(records, "LPC/26-27/0412").history).toEqual([
      { kind: "step", step: "whatsapp_nudge", on: "2026-10-20" },
      { kind: "promise", promisedDate: "2026-11-20", amountPaise: 20_000_000, recordedOn: "2026-10-28" },
      { kind: "step", step: "whatsapp_paylink", on: "2026-11-02" },
    ]);
    // The other five invoices are untouched.
    for (const r of records.filter((x) => x.invoiceNumber !== "LPC/26-27/0412")) expect(r.history).toEqual([]);
  });

  it("returns none of a second supplier's invoices, buyers, steps or promises, and vice versa", async () => {
    const { t, supplierId } = await seeded();
    // Same buyer name as a demo buyer: scoping must be by supplier, not by name.
    const other = await insertOtherSupplier(t, "Sharma Traders");
    const demoSharmaId = recordFor(await listGraveyardInvoices(t.db, supplierId, TODAY), "LPC/26-27/0412").invoice.id;
    await t.db
      .insert(escalationEvents)
      .values({ invoiceId: demoSharmaId, step: "whatsapp_nudge", occurredOn: "2026-10-20", action: "approved" });
    await t.db
      .insert(promises)
      .values({ invoiceId: demoSharmaId, promisedDate: "2026-11-20", amountPaise: 1_000_000, recordedOn: "2026-10-28" });

    const demo = await listGraveyardInvoices(t.db, supplierId, TODAY);
    const second = await listGraveyardInvoices(t.db, other.supplier.id, TODAY);

    expect(demo).toHaveLength(6);
    expect(demo.map((r) => r.invoiceNumber)).not.toContain("OTH/26-27/0001");
    expect(demo.map((r) => r.invoice.id)).not.toContain(other.invoice.id);
    expect(JSON.stringify(demo)).not.toContain("2026-11-30");
    expect(JSON.stringify(demo)).not.toContain("voice_call");

    expect(second).toHaveLength(1);
    expect(second).toEqual([
      {
        invoice: {
          id: other.invoice.id,
          amountPaise: 7_700_000,
          acceptedOn: "2026-08-01",
          agreedTermDays: 30,
          supplierCategory: "small",
          supplierActivity: "services",
          udyamRegisteredOn: "2023-01-10",
        },
        buyerName: "Sharma Traders",
        invoiceNumber: "OTH/26-27/0001",
        history: [
          { kind: "step", step: "voice_call", on: "2026-10-01" },
          { kind: "promise", promisedDate: "2026-11-30", amountPaise: 7_700_000, recordedOn: "2026-10-02" },
        ],
        buyerId: other.buyer.id,
        invoiceDate: "2026-08-01",
      },
    ]);

    // The demo Sharma history holds only its own two events.
    expect(recordFor(demo, "LPC/26-27/0412").history).toEqual([
      { kind: "step", step: "whatsapp_nudge", on: "2026-10-20" },
      { kind: "promise", promisedDate: "2026-11-20", amountPaise: 1_000_000, recordedOn: "2026-10-28" },
    ]);

    // Sanity: the second supplier's buyer row exists next to the demo's same-named buyer.
    const sameName = await t.db.select({ id: buyers.id }).from(buyers).where(eq(buyers.name, "Sharma Traders"));
    expect(sameName).toHaveLength(2);
  });

  it("returns [] for an unknown supplier id", async () => {
    const { t } = await seeded();
    expect(await listGraveyardInvoices(t.db, "00000000-0000-4000-8000-000000000000", TODAY)).toEqual([]);
  });

  it("returns [] for a supplier with no invoices", async () => {
    const t = await freshDb();
    const [supplier] = await t.db
      .insert(suppliers)
      .values({
        name: "Empty Works",
        udyamNumber: "UDYAM-MH-26-0123456",
        supplierCategory: "micro",
        supplierActivity: "manufacturing",
      })
      .returning();
    if (supplier === undefined) throw new Error("supplier not inserted");
    expect(await listGraveyardInvoices(t.db, supplier.id, TODAY)).toEqual([]);
  });
});

describe("typed not-found errors", () => {
  it("getSupplier rejects with SupplierNotFoundError and the unchanged message", async () => {
    const t = await freshDb();
    const id = "00000000-0000-4000-8000-000000000000";

    const error: unknown = await getSupplier(t.db, id).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SupplierNotFoundError);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("SupplierNotFoundError");
    expect((error as Error).message).toBe(`supplier ${id} not found`);
  });

  it("getBankRate rejects with BankRateNotFoundError and the unchanged message", async () => {
    const t = await freshDb();

    const error: unknown = await getBankRate(t.db, "2026-11-12").then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(BankRateNotFoundError);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("BankRateNotFoundError");
    expect((error as Error).message).toBe('config "rbi_bank_rate_bps": no row effective on or before 2026-11-12');
  });

  it("getBankRate before the first seeded rate rejects with BankRateNotFoundError", async () => {
    const { t } = await seeded();
    await expect(getBankRate(t.db, "2026-10-06")).rejects.toBeInstanceOf(BankRateNotFoundError);
  });

  it("getBankRate with an invalid date stays a plain Error, not BankRateNotFoundError", async () => {
    const t = await freshDb();
    const error: unknown = await getBankRate(t.db, "2026-02-30").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(BankRateNotFoundError);
  });

  it("the two error classes are distinct", () => {
    expect(new SupplierNotFoundError("x")).not.toBeInstanceOf(BankRateNotFoundError);
    expect(new BankRateNotFoundError("x")).not.toBeInstanceOf(SupplierNotFoundError);
  });
});
