import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RESET_TABLES } from "../src/reset";
import * as schema from "../src/schema";
import { buyers, suppliers, webhookEvents } from "../src/schema";
import { seed } from "../src/seed";
import { cloneTestDb, createTestDb, type TestDb } from "../src/testing";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

/** Fictional numbers only (Requirement 8.3). */
const VALID_NUMBER = "+919000000001";
const INVALID_NUMBERS = ["+91 9000000001", "919000000001", "whatsapp:+919000000001"] as const;

const WARNING = "DEMO_BUYER_WHATSAPP is unset or not E.164; demo buyer has no WhatsApp number";

interface PgFailure {
  code: string;
  constraint: string;
}

/** Walks the Drizzle `cause` chain to the Postgres error that carries a SQLSTATE and a constraint. */
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

async function failureOf(work: PromiseLike<unknown>): Promise<PgFailure> {
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
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((t) => t.close()));
});

async function freshDb(): Promise<TestDb> {
  const t = await cloneTestDb(template);
  open.push(t);
  return t;
}

/** Inserts a supplier and returns its id. */
async function insertSupplier(t: TestDb): Promise<string> {
  const [row] = await t.db
    .insert(suppliers)
    .values({
      name: "Test Supplier",
      udyamNumber: "UDYAM-MH-00-0000001",
      supplierCategory: "micro",
      supplierActivity: "manufacturing",
    })
    .returning({ id: suppliers.id });
  if (row === undefined) throw new Error("supplier not inserted");
  return row.id;
}

async function insertBuyer(t: TestDb, supplierId: string): Promise<string> {
  const [row] = await t.db
    .insert(buyers)
    .values({ supplierId, name: "Sharma Traders", nameKey: "sharma traders" })
    .returning({ id: buyers.id });
  if (row === undefined) throw new Error("buyer not inserted");
  return row.id;
}

describe("existing data across migration 0003", () => {
  let folder: string;

  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), "whatsapp-migration-"));
  });

  afterAll(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it("keeps buyers with a null whatsapp_number and old escalation_events rows intact", async () => {
    // A migrations folder that stops at 0002, built from the committed files.
    const upTo0002 = join(folder, "up-to-0002");
    cpSync(MIGRATIONS_FOLDER, upTo0002, { recursive: true });
    const journalPath = join(upTo0002, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: { tag: string }[];
    };
    journal.entries = journal.entries.filter((entry) => entry.tag !== "0003_whatsapp_channel");
    expect(journal.entries.map((entry) => entry.tag)).toEqual([
      "0000_opposite_piledriver",
      "0001_loud_praxagora",
      "0002_greedy_bug",
    ]);
    writeFileSync(journalPath, JSON.stringify(journal));

    const pglite = new PGlite();
    try {
      const db = drizzle(pglite, { schema });
      await migrate(db, { migrationsFolder: upTo0002 });

      // Raw SQL: the Drizzle schema already knows the 0003 columns, which don't exist yet.
      const columnBefore = await pglite.query(
        `select 1 from information_schema.columns where table_name = 'buyers' and column_name = 'whatsapp_number'`,
      );
      expect(columnBefore.rows).toEqual([]);
      await pglite.exec(`
        insert into suppliers (id, name, udyam_number, supplier_category, supplier_activity)
          values ('00000000-0000-0000-0000-000000000001', 'Test Supplier', 'UDYAM-MH-00-0000001', 'micro', 'manufacturing');
        insert into buyers (id, supplier_id, name, name_key)
          values ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Sharma Traders', 'sharma traders');
        insert into invoices (id, supplier_id, buyer_id, invoice_number, invoice_number_key, invoice_date, accepted_on, amount_paise, supplier_category, supplier_activity)
          values ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'INV-001', 'inv-001', '2026-09-02', '2026-09-02', 41200000, 'micro', 'manufacturing');
        insert into escalation_events (id, invoice_id, step, occurred_on, action)
          values ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000003', 'whatsapp_nudge', '2026-11-05', 'approved');
      `);

      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

      const buyerRows = await pglite.query(`select name, whatsapp_number from buyers`);
      expect(buyerRows.rows).toEqual([{ name: "Sharma Traders", whatsapp_number: null }]);

      const eventRows = await pglite.query(
        `select id, invoice_id, step, occurred_on::text as occurred_on, action, draft_id, detail from escalation_events`,
      );
      expect(eventRows.rows).toEqual([
        {
          id: "00000000-0000-0000-0000-000000000004",
          invoice_id: "00000000-0000-0000-0000-000000000003",
          step: "whatsapp_nudge",
          occurred_on: "2026-11-05",
          action: "approved",
          draft_id: null,
          detail: null,
        },
      ]);
      const labels = await pglite.query<{ enumlabel: string }>(
        `select e.enumlabel from pg_enum e join pg_type ty on ty.oid = e.enumtypid
          where ty.typname = 'escalation_action' order by e.enumsortorder`,
      );
      expect(labels.rows.map((row) => row.enumlabel)).toContain("sent");
    } finally {
      await pglite.close();
    }
  });
});

describe("buyers_whatsapp_number_e164", () => {
  it.each(INVALID_NUMBERS)("rejects an insert with %s", async (number) => {
    const t = await freshDb();
    const supplierId = await insertSupplier(t);
    const failure = await failureOf(
      t.db.insert(buyers).values({ supplierId, name: "Sharma Traders", nameKey: "sharma traders", whatsappNumber: number }),
    );
    expect(failure).toEqual({ code: CHECK_VIOLATION, constraint: "buyers_whatsapp_number_e164" });
  });

  it.each(INVALID_NUMBERS)("rejects an update to %s", async (number) => {
    const t = await freshDb();
    const supplierId = await insertSupplier(t);
    const buyerId = await insertBuyer(t, supplierId);
    const failure = await failureOf(
      t.db.update(buyers).set({ whatsappNumber: number }).where(eq(buyers.id, buyerId)),
    );
    expect(failure).toEqual({ code: CHECK_VIOLATION, constraint: "buyers_whatsapp_number_e164" });
  });

  it("accepts +919000000001 on insert and on update", async () => {
    const t = await freshDb();
    const supplierId = await insertSupplier(t);
    const inserted = await t.db
      .insert(buyers)
      .values({ supplierId, name: "Sharma Traders", nameKey: "sharma traders", whatsappNumber: VALID_NUMBER })
      .returning({ whatsappNumber: buyers.whatsappNumber });
    expect(inserted).toEqual([{ whatsappNumber: VALID_NUMBER }]);

    const [other] = await t.db
      .insert(buyers)
      .values({ supplierId, name: "Gupta Steel", nameKey: "gupta steel" })
      .returning({ id: buyers.id, whatsappNumber: buyers.whatsappNumber });
    if (other === undefined) throw new Error("buyer not inserted");
    expect(other.whatsappNumber).toBeNull();
    const updated = await t.db
      .update(buyers)
      .set({ whatsappNumber: VALID_NUMBER })
      .where(eq(buyers.id, other.id))
      .returning({ whatsappNumber: buyers.whatsappNumber });
    expect(updated).toEqual([{ whatsappNumber: VALID_NUMBER }]);
  });
});

describe("migration 0003 objects", () => {
  it("has the sent value in escalation_action, after the existing values", async () => {
    const result = await template.pglite.query<{ enumlabel: string }>(
      `select e.enumlabel from pg_enum e join pg_type ty on ty.oid = e.enumtypid
        where ty.typname = 'escalation_action' order by e.enumsortorder`,
    );
    const labels = result.rows.map((row) => row.enumlabel);
    expect(labels).toContain("approved");
    expect(labels).toContain("sent");
    expect(labels.indexOf("sent")).toBe(labels.length - 1);
  });

  it("has both unique indexes under their exact names", async () => {
    const result = await template.pglite.query<{ tablename: string; indexname: string; indexdef: string }>(
      `select tablename, indexname, indexdef from pg_indexes
        where indexname in ('messages_one_sent_per_draft', 'payment_links_draft_id_key')
        order by indexname`,
    );
    expect(result.rows.map((row) => [row.tablename, row.indexname])).toEqual([
      ["messages", "messages_one_sent_per_draft"],
      ["payment_links", "payment_links_draft_id_key"],
    ]);
    for (const row of result.rows) expect(row.indexdef).toContain("CREATE UNIQUE INDEX");
  });

  it("rejects a repeated (provider, event_id) pair in webhook_events", async () => {
    const t = await freshDb();
    await t.db.insert(webhookEvents).values({ provider: "razorpay", eventId: "evt_test_1" });
    const failure = await failureOf(
      t.db.insert(webhookEvents).values({ provider: "razorpay", eventId: "evt_test_1" }),
    );
    expect(failure).toEqual({ code: UNIQUE_VIOLATION, constraint: "webhook_events_provider_event_id_key" });

    // The same event id from another provider is a different event.
    await t.db.insert(webhookEvents).values({ provider: "twilio", eventId: "evt_test_1" });
    const rows = await t.db.select({ provider: webhookEvents.provider }).from(webhookEvents);
    expect(rows.map((row) => row.provider).sort()).toEqual(["razorpay", "twilio"]);
  });

  it("includes webhook_events in RESET_TABLES", () => {
    expect(RESET_TABLES).toContain("webhook_events");
  });
});

describe("seed demoBuyerWhatsapp", () => {
  async function numbersByBuyer(t: TestDb): Promise<Record<string, string | null>> {
    const rows = await t.db.select({ name: buyers.name, whatsappNumber: buyers.whatsappNumber }).from(buyers);
    return Object.fromEntries(rows.map((row) => [row.name, row.whatsappNumber]));
  }

  const NO_NUMBERS = {
    "Bansal Hardware": null,
    "Gupta Engineering Works": null,
    "Kumar Textiles": null,
    "Mehta Polymers": null,
    "Sharma Traders": null,
    "Verma Auto Parts": null,
  };

  it("stores a valid number on Sharma Traders only, without a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = await freshDb();
    await seed(t.db, { demoBuyerWhatsapp: VALID_NUMBER });
    expect(await numbersByBuyer(t)).toEqual({ ...NO_NUMBERS, "Sharma Traders": VALID_NUMBER });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty value", ""],
    ["a value that is not E.164", "919000000001"],
  ])("leaves every number null and warns once, without the value, for %s", async (_label, value) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = await freshDb();
    await seed(t.db, { demoBuyerWhatsapp: value });
    expect(await numbersByBuyer(t)).toEqual(NO_NUMBERS);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(WARNING);
  });
});
