import { PGlite } from "@electric-sql/pglite";
import type { EscalationDecision } from "@dues-banshee/engine";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { listGraveyardInvoices } from "../src/graveyard";
import * as schema from "../src/schema";
import { drafts, escalationEvents, invoices, suppliers } from "../src/schema";
import { seed } from "../src/seed";
import { cloneTestDb, createTestDb, type TestDb } from "../src/testing";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const SHARMA = "LPC/26-27/0412";
const DECISION: EscalationDecision = {
  action: "advance",
  applicable: true,
  step: "whatsapp_nudge",
  rank: 1,
  requiresApproval: false,
  ruleIds: ["MSMED-15"],
};
interface PgFailure {
  code: string;
  constraint: string;
}
/** Finds the Postgres error behind a failed query by walking the `cause` chain. */
function pgFailure(error: unknown): PgFailure {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const { code, constraint, cause } = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof code === "string" && typeof constraint === "string") return { code, constraint };
    current = cause;
  }
  throw new Error(`no Postgres error with a constraint in the cause chain of: ${String(error)}`);
}
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
const scratch: string[] = [];
beforeAll(async () => {
  template = await createTestDb();
});
afterAll(async () => {
  await template.close();
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((t) => t.close()));
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function freshDb(): Promise<TestDb> {
  const t = await cloneTestDb(template);
  open.push(t);
  return t;
}
/** A migrated database with the demo seed, and the id of the Sharma invoice. */
async function seeded(): Promise<{ t: TestDb; supplierId: string; sharmaId: string }> {
  const t = await freshDb();
  await seed(t.db);
  const [supplier] = await t.db.select({ id: suppliers.id }).from(suppliers);
  const [sharma] = await t.db
    .select({ id: invoices.id })
    .from(invoices)
    .where(eq(invoices.invoiceNumber, SHARMA));
  if (supplier === undefined || sharma === undefined) throw new Error("demo seed missing");
  return { t, supplierId: supplier.id, sharmaId: sharma.id };
}
function newDraft(invoiceId: string, over: Partial<typeof drafts.$inferInsert> = {}): typeof drafts.$inferInsert {
  return {
    invoiceId,
    step: "whatsapp_nudge",
    language: "hinglish",
    bodyText: "Sharma ji, a gentle reminder.",
    finalText: "Sharma ji, a gentle reminder.\n\nBasis: MSMED-15 (MSMED Act 2006, s.15)\nDisclaimer",
    ruleIds: ["MSMED-15"],
    modelId: "mock-haiku",
    decision: DECISION,
    createdOn: "2026-11-12",
    ...over,
  };
}
describe("migration 0002 backfill", () => {
  it("reads a pre-migration escalation_events row back with action approved", async () => {
    // Copy migrations 0000 and 0001 only, with a journal that stops at 0001.
    const dir = mkdtempSync(join(tmpdir(), "drafts-migration-"));
    scratch.push(dir);
    mkdirSync(join(dir, "meta"));
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    const before = journal.entries.filter((e) => e.idx <= 1);
    expect(before.map((e) => e.idx)).toEqual([0, 1]);
    for (const e of before) cpSync(join(MIGRATIONS_FOLDER, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
    writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: before }));
    const pglite = new PGlite();
    try {
      await migrate(drizzle(pglite, { schema }), { migrationsFolder: dir });
      // Raw SQL: `seed` writes columns of the current schema, which this older database lacks.
      await pglite.query(
        `WITH s AS (
           INSERT INTO suppliers (name, udyam_number, supplier_category, supplier_activity)
           VALUES ('Pre-migration Supplier', 'UDYAM-MH-00-0000000', 'micro', 'manufacturing') RETURNING id
         ), b AS (
           INSERT INTO buyers (supplier_id, name, name_key) SELECT id, 'Sharma Traders', 'sharma traders' FROM s RETURNING id, supplier_id
         ), i AS (
           INSERT INTO invoices (supplier_id, buyer_id, invoice_number, invoice_number_key, invoice_date, accepted_on,
                                 amount_paise, supplier_category, supplier_activity)
           SELECT supplier_id, id, $1, 'lpc/26-27/0412', '2026-09-02', '2026-09-02', 41200000, 'micro', 'manufacturing' FROM b
           RETURNING id
         )
         INSERT INTO escalation_events (invoice_id, step, occurred_on)
         SELECT id, 'whatsapp_nudge', '2026-10-20' FROM i`,
        [SHARMA],
      );
      // Apply every committed migration; 0000 and 0001 are skipped, 0002 runs over the existing row.
      const db = drizzle(pglite, { schema });
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      const rows = await db
        .select({ step: escalationEvents.step, occurredOn: escalationEvents.occurredOn, action: escalationEvents.action, draftId: escalationEvents.draftId, detail: escalationEvents.detail })
        .from(escalationEvents);
      expect(rows).toEqual([
        { step: "whatsapp_nudge", occurredOn: "2026-10-20", action: "approved", draftId: null, detail: null },
      ]);
      // The default was dropped in the same migration: a new row must name its action.
      const [sharma] = await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.invoiceNumber, SHARMA));
      await expect(
        pglite.query(`INSERT INTO escalation_events (invoice_id, step, occurred_on) VALUES ($1, 'voice_call', '2026-11-01')`, [
          sharma?.id,
        ]),
      ).rejects.toMatchObject({ code: "23502" });
    } finally {
      await pglite.close();
    }
  });
});
describe("drafts constraints", () => {
  it("rejects a second pending Draft for one invoice", async () => {
    const { t, sharmaId } = await seeded();
    await t.db.insert(drafts).values(newDraft(sharmaId));
    expect(await failureOf(t.db.insert(drafts).values(newDraft(sharmaId, { language: "english" })))).toEqual({
      code: UNIQUE_VIOLATION,
      constraint: "drafts_one_pending_per_invoice",
    });
  });
  it("allows a second Draft once the first is approved", async () => {
    const { t, sharmaId } = await seeded();
    await t.db.insert(drafts).values(newDraft(sharmaId));
    await t.db.update(drafts).set({ status: "approved" }).where(eq(drafts.invoiceId, sharmaId));
    await t.db.insert(drafts).values(newDraft(sharmaId, { language: "english" }));
    const rows = await t.db
      .select({ status: drafts.status, language: drafts.language })
      .from(drafts)
      .where(eq(drafts.invoiceId, sharmaId))
      .orderBy(drafts.status); // enum order: pending before approved
    expect(rows).toEqual([
      { status: "pending", language: "english" },
      { status: "approved", language: "hinglish" },
    ]);
  });
  it("rejects a blank body_text", async () => {
    const { t, sharmaId } = await seeded();
    expect(await failureOf(t.db.insert(drafts).values(newDraft(sharmaId, { bodyText: "    " })))).toEqual({
      code: CHECK_VIOLATION,
      constraint: "drafts_body_not_blank",
    });
  });
  it("stores the decision and the document bytes unchanged", async () => {
    const { t, sharmaId } = await seeded();
    const document = new Uint8Array([37, 80, 68, 70, 0, 255]);
    await t.db.insert(drafts).values(newDraft(sharmaId, { step: "legal_notice", document }));
    const [row] = await t.db.select().from(drafts).where(eq(drafts.invoiceId, sharmaId));
    expect(row?.decision).toEqual(DECISION);
    expect(row?.ruleIds).toEqual(["MSMED-15"]);
    expect(Array.from(row?.document ?? [])).toEqual([37, 80, 68, 70, 0, 255]);
    expect(row?.status).toBe("pending");
  });
});
describe("listGraveyardInvoices and escalation actions", () => {
  it("counts only approved events as steps", async () => {
    const { t, supplierId, sharmaId } = await seeded();
    const [draft] = await t.db.insert(drafts).values(newDraft(sharmaId)).returning({ id: drafts.id });
    if (draft === undefined) throw new Error("draft not inserted");
    const base = { invoiceId: sharmaId, draftId: draft.id };
    await t.db.insert(escalationEvents).values([
      { ...base, step: "whatsapp_nudge", occurredOn: "2026-11-01", action: "drafted" },
      { ...base, step: "whatsapp_nudge", occurredOn: "2026-11-02", action: "edited", detail: { before: "a", after: "b" } },
      { ...base, step: "whatsapp_paylink", occurredOn: "2026-11-03", action: "rejected", detail: { reason: null } },
      { ...base, step: "voice_call", occurredOn: "2026-11-04", action: "expired" },
    ]);
    const sharmaHistory = async () =>
      (await listGraveyardInvoices(t.db, supplierId)).find((r) => r.invoiceNumber === SHARMA)?.history;
    expect(await sharmaHistory()).toEqual([]);
    await t.db.insert(escalationEvents).values({
      ...base,
      step: "whatsapp_nudge",
      occurredOn: "2026-11-05",
      action: "approved",
    });
    expect(await sharmaHistory()).toEqual([{ kind: "step", step: "whatsapp_nudge", on: "2026-11-05" }]);
    const stored = await t.db
      .select({ n: escalationEvents.action })
      .from(escalationEvents)
      .where(and(eq(escalationEvents.invoiceId, sharmaId)))
      .orderBy(escalationEvents.occurredOn);
    expect(stored.map((r) => r.n)).toEqual(["drafted", "edited", "rejected", "expired", "approved"]);
  });
});
