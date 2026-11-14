import type { EscalationDecision } from "@dues-banshee/engine";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getDebtorData, listGraveyardInvoices, type GraveyardInvoiceRecord } from "../src/graveyard";
import { listPendingDrafts } from "../src/ladder";
import { buyers, drafts, escalationEvents, invoices, promises, suppliers } from "../src/schema";
import { seed } from "../src/seed";
import { cloneTestDb, createTestDb, type TestDb } from "../src/testing";

const SHARMA = "LPC/26-27/0412";
const KUMAR = "LPC/26-27/0301";
const UNKNOWN_UUID = "00000000-0000-4000-8000-000000000000";

const DECISION: EscalationDecision = {
  action: "advance",
  applicable: true,
  step: "whatsapp_nudge",
  rank: 1,
  requiresApproval: false,
  ruleIds: ["MSMED-15"],
};

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

/** A fresh database with the demo seed, the demo supplier's id, and buyer and invoice ids by name and number. */
async function seeded(): Promise<{
  t: TestDb;
  supplierId: string;
  buyerIds: Map<string, string>;
  invoiceIds: Map<string, string>;
}> {
  const t = await freshDb();
  await seed(t.db);
  const [supplier] = await t.db.select({ id: suppliers.id }).from(suppliers);
  if (supplier === undefined) throw new Error("demo supplier missing after seed");
  const buyerRows = await t.db
    .select({ id: buyers.id, name: buyers.name })
    .from(buyers)
    .where(eq(buyers.supplierId, supplier.id));
  const invoiceRows = await t.db
    .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber })
    .from(invoices)
    .where(eq(invoices.supplierId, supplier.id));
  return {
    t,
    supplierId: supplier.id,
    buyerIds: new Map(buyerRows.map((r) => [r.name, r.id])),
    invoiceIds: new Map(invoiceRows.map((r) => [r.invoiceNumber, r.id])),
  };
}

function need(map: Map<string, string>, key: string): string {
  const found = map.get(key);
  if (found === undefined) throw new Error(`no id for ${key}`);
  return found;
}

function recordFor(records: readonly GraveyardInvoiceRecord[], invoiceNumber: string): GraveyardInvoiceRecord {
  const found = records.find((r) => r.invoiceNumber === invoiceNumber);
  if (found === undefined) throw new Error(`no record for ${invoiceNumber}`);
  return found;
}

/** A second supplier whose buyer has the same name as a demo buyer, with one invoice, event, promise and Draft. */
async function insertOtherSupplier(t: TestDb) {
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
    .values({ supplierId: supplier.id, name: "Sharma Traders", nameKey: "sharma traders" })
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
  await t.db.insert(escalationEvents).values([
    { id: "00000000-0000-4000-8000-0000000000a1", invoiceId: invoice.id, step: "voice_call", occurredOn: "2026-10-01", action: "approved" },
    { id: "00000000-0000-4000-8000-0000000000a2", invoiceId: invoice.id, step: "voice_call", occurredOn: "2026-10-02", action: "rejected" },
  ]);
  await t.db.insert(promises).values({
    id: "00000000-0000-4000-8000-0000000000b1",
    invoiceId: invoice.id,
    promisedDate: "2026-11-30",
    amountPaise: 7_700_000,
    recordedOn: "2026-10-02",
  });
  await t.db.insert(drafts).values({
    id: "00000000-0000-4000-8000-0000000000c1",
    invoiceId: invoice.id,
    step: "whatsapp_nudge",
    language: "english",
    bodyText: "Other supplier body",
    finalText: "Other supplier final",
    ruleIds: ["MSMED-15"],
    modelId: "mock-haiku",
    decision: DECISION,
    createdOn: "2026-10-01",
  });
  return { supplier, buyer, invoice };
}

/** Inserts every action on the demo Sharma Traders invoice, one per day, plus one promise. */
async function insertSharmaHistory(t: TestDb, invoiceId: string): Promise<void> {
  await t.db.insert(escalationEvents).values([
    { id: "00000000-0000-4000-8000-000000000e01", invoiceId, step: "whatsapp_nudge", occurredOn: "2026-10-20", action: "drafted" },
    { id: "00000000-0000-4000-8000-000000000e02", invoiceId, step: "whatsapp_nudge", occurredOn: "2026-10-21", action: "edited" },
    { id: "00000000-0000-4000-8000-000000000e03", invoiceId, step: "whatsapp_nudge", occurredOn: "2026-10-22", action: "rejected" },
    { id: "00000000-0000-4000-8000-000000000e04", invoiceId, step: "whatsapp_nudge", occurredOn: "2026-10-23", action: "expired" },
    { id: "00000000-0000-4000-8000-000000000e05", invoiceId, step: "whatsapp_nudge", occurredOn: "2026-10-25", action: "approved" },
  ]);
  await t.db.insert(promises).values({
    id: "00000000-0000-4000-8000-000000000f01",
    invoiceId,
    promisedDate: "2026-11-20",
    amountPaise: 20_000_000,
    recordedOn: "2026-10-28",
  });
}

describe("getDebtorData", () => {
  it("returns Sharma Traders' name, invoice record and every event action", async () => {
    const { t, supplierId, buyerIds, invoiceIds } = await seeded();
    const sharmaBuyerId = need(buyerIds, "Sharma Traders");
    const sharmaInvoiceId = need(invoiceIds, SHARMA);
    await insertSharmaHistory(t, sharmaInvoiceId);

    const data = await getDebtorData(t.db, supplierId, sharmaBuyerId);

    expect(data).toEqual({
      buyer: { id: sharmaBuyerId, name: "Sharma Traders" },
      records: [
        {
          invoice: {
            id: sharmaInvoiceId,
            amountPaise: 41_200_000,
            acceptedOn: "2026-09-02",
            agreedTermDays: 45,
            supplierCategory: "micro",
            supplierActivity: "manufacturing",
            udyamRegisteredOn: "2024-04-15",
          },
          buyerName: "Sharma Traders",
          invoiceNumber: SHARMA,
          // Only the approved event is a ladder step; the promise is merged by date.
          history: [
            { kind: "step", step: "whatsapp_nudge", on: "2026-10-25" },
            { kind: "promise", promisedDate: "2026-11-20", amountPaise: 20_000_000, recordedOn: "2026-10-28" },
          ],
          buyerId: sharmaBuyerId,
          invoiceDate: "2026-09-02",
        },
      ],
      events: [
        { id: "00000000-0000-4000-8000-000000000e01", invoiceId: sharmaInvoiceId, step: "whatsapp_nudge", action: "drafted", occurredOn: "2026-10-20" },
        { id: "00000000-0000-4000-8000-000000000e02", invoiceId: sharmaInvoiceId, step: "whatsapp_nudge", action: "edited", occurredOn: "2026-10-21" },
        { id: "00000000-0000-4000-8000-000000000e03", invoiceId: sharmaInvoiceId, step: "whatsapp_nudge", action: "rejected", occurredOn: "2026-10-22" },
        { id: "00000000-0000-4000-8000-000000000e04", invoiceId: sharmaInvoiceId, step: "whatsapp_nudge", action: "expired", occurredOn: "2026-10-23" },
        { id: "00000000-0000-4000-8000-000000000e05", invoiceId: sharmaInvoiceId, step: "whatsapp_nudge", action: "approved", occurredOn: "2026-10-25" },
      ],
      promises: [
        {
          id: "00000000-0000-4000-8000-000000000f01",
          invoiceId: sharmaInvoiceId,
          promisedDate: "2026-11-20",
          amountPaise: 20_000_000,
          recordedOn: "2026-10-28",
        },
      ],
    });
  });

  it("returns an empty history, events and promises for a buyer with none", async () => {
    const { t, supplierId, buyerIds, invoiceIds } = await seeded();
    const kumarBuyerId = need(buyerIds, "Kumar Textiles");

    const data = await getDebtorData(t.db, supplierId, kumarBuyerId);

    expect(data).toEqual({
      buyer: { id: kumarBuyerId, name: "Kumar Textiles" },
      records: [
        {
          invoice: {
            id: need(invoiceIds, KUMAR),
            amountPaise: 24_000_000,
            acceptedOn: "2026-07-02",
            agreedTermDays: 45,
            supplierCategory: "micro",
            supplierActivity: "manufacturing",
            udyamRegisteredOn: "2024-04-15",
          },
          buyerName: "Kumar Textiles",
          invoiceNumber: KUMAR,
          history: [],
          buyerId: kumarBuyerId,
          invoiceDate: "2026-07-02",
        },
      ],
      events: [],
      promises: [],
    });
  });

  it("returns null for a second supplier's buyer and for an unknown uuid", async () => {
    const { t, supplierId } = await seeded();
    const other = await insertOtherSupplier(t);

    expect(await getDebtorData(t.db, supplierId, other.buyer.id)).toBeNull();
    expect(await getDebtorData(t.db, supplierId, UNKNOWN_UUID)).toBeNull();
    expect(await getDebtorData(t.db, other.supplier.id, UNKNOWN_UUID)).toBeNull();
  });

  it("returns none of a second supplier's rows, even for a buyer with the same name", async () => {
    const { t, supplierId, buyerIds, invoiceIds } = await seeded();
    const sharmaBuyerId = need(buyerIds, "Sharma Traders");
    const sharmaInvoiceId = need(invoiceIds, SHARMA);
    await insertSharmaHistory(t, sharmaInvoiceId);
    const other = await insertOtherSupplier(t);

    const demo = await getDebtorData(t.db, supplierId, sharmaBuyerId);
    const second = await getDebtorData(t.db, other.supplier.id, other.buyer.id);
    // The demo supplier's own buyer id is not visible to the second supplier either.
    const crossed = await getDebtorData(t.db, other.supplier.id, sharmaBuyerId);

    expect(other.buyer.id).not.toBe(sharmaBuyerId);
    expect(crossed).toBeNull();

    expect(demo?.records.map((r) => r.invoice.id)).toEqual([sharmaInvoiceId]);
    expect(demo?.events.map((e) => e.invoiceId)).toEqual([
      sharmaInvoiceId,
      sharmaInvoiceId,
      sharmaInvoiceId,
      sharmaInvoiceId,
      sharmaInvoiceId,
    ]);
    expect(demo?.promises.map((p) => p.id)).toEqual(["00000000-0000-4000-8000-000000000f01"]);
    const demoText = JSON.stringify(demo);
    expect(demoText).not.toContain("OTH/26-27/0001");
    expect(demoText).not.toContain(other.invoice.id);
    expect(demoText).not.toContain("voice_call");
    expect(demoText).not.toContain("2026-11-30");

    expect(second).toEqual({
      buyer: { id: other.buyer.id, name: "Sharma Traders" },
      records: [
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
      ],
      events: [
        { id: "00000000-0000-4000-8000-0000000000a1", invoiceId: other.invoice.id, step: "voice_call", action: "approved", occurredOn: "2026-10-01" },
        { id: "00000000-0000-4000-8000-0000000000a2", invoiceId: other.invoice.id, step: "voice_call", action: "rejected", occurredOn: "2026-10-02" },
      ],
      promises: [
        {
          id: "00000000-0000-4000-8000-0000000000b1",
          invoiceId: other.invoice.id,
          promisedDate: "2026-11-30",
          amountPaise: 7_700_000,
          recordedOn: "2026-10-02",
        },
      ],
    });
  });
});

describe("listGraveyardInvoices buyer fields", () => {
  it("returns buyerId and invoiceDate for each of the six demo records", async () => {
    const { t, supplierId, buyerIds } = await seeded();

    const records = await listGraveyardInvoices(t.db, supplierId);

    const view = records
      .map((r) => ({ invoiceNumber: r.invoiceNumber, buyerId: r.buyerId, invoiceDate: r.invoiceDate }))
      .sort((a, b) => (a.invoiceNumber < b.invoiceNumber ? -1 : 1));
    expect(view).toEqual([
      { invoiceNumber: "LPC/23-24/0098", buyerId: need(buyerIds, "Bansal Hardware"), invoiceDate: "2024-03-01" },
      { invoiceNumber: "LPC/25-26/0388", buyerId: need(buyerIds, "Mehta Polymers"), invoiceDate: "2026-03-20" },
      { invoiceNumber: "LPC/26-27/0301", buyerId: need(buyerIds, "Kumar Textiles"), invoiceDate: "2026-07-02" },
      { invoiceNumber: "LPC/26-27/0377", buyerId: need(buyerIds, "Verma Auto Parts"), invoiceDate: "2026-08-10" },
      { invoiceNumber: "LPC/26-27/0412", buyerId: need(buyerIds, "Sharma Traders"), invoiceDate: "2026-09-02" },
      { invoiceNumber: "LPC/26-27/0466", buyerId: need(buyerIds, "Gupta Engineering Works"), invoiceDate: "2026-11-01" },
    ]);
    expect(recordFor(records, SHARMA).buyerId).toBe(need(buyerIds, "Sharma Traders"));
  });
});

describe("listPendingDrafts buyer ids", () => {
  it("carries the buyer id of each pending Draft's invoice, and none of another supplier's", async () => {
    const { t, supplierId, buyerIds, invoiceIds } = await seeded();
    const other = await insertOtherSupplier(t);
    const base: Omit<typeof drafts.$inferInsert, "invoiceId"> = {
      step: "whatsapp_nudge",
      language: "hinglish",
      bodyText: "body",
      finalText: "final",
      ruleIds: ["MSMED-15"],
      modelId: "mock-haiku",
      decision: DECISION,
      createdOn: "2026-11-12",
    };
    await t.db.insert(drafts).values([
      {
        ...base,
        id: "00000000-0000-4000-8000-000000000d01",
        invoiceId: need(invoiceIds, SHARMA),
        createdAt: new Date("2026-11-01T00:00:00Z"),
      },
      {
        ...base,
        id: "00000000-0000-4000-8000-000000000d02",
        invoiceId: need(invoiceIds, KUMAR),
        createdAt: new Date("2026-11-02T00:00:00Z"),
      },
    ]);

    const demo = await listPendingDrafts(t.db, supplierId);
    const second = await listPendingDrafts(t.db, other.supplier.id);

    expect(demo.map((d) => [d.draft.id, d.buyerId, d.buyerName, d.invoiceNumber])).toEqual([
      ["00000000-0000-4000-8000-000000000d01", need(buyerIds, "Sharma Traders"), "Sharma Traders", SHARMA],
      ["00000000-0000-4000-8000-000000000d02", need(buyerIds, "Kumar Textiles"), "Kumar Textiles", KUMAR],
    ]);
    expect(second.map((d) => [d.draft.id, d.buyerId, d.buyerName, d.invoiceNumber])).toEqual([
      ["00000000-0000-4000-8000-0000000000c1", other.buyer.id, "Sharma Traders", "OTH/26-27/0001"],
    ]);
  });
});
