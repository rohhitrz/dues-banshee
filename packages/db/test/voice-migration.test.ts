import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetDemo } from "../src/reset";
import * as schema from "../src/schema";
import { invoices, promises, suppliers, voiceCalls, voiceToolCalls, voiceTranscriptLines } from "../src/schema";
import { seed } from "../src/seed";
import { cloneTestDb, createTestDb, type TestDb } from "../src/testing";
import { claimJoin, claimToolCall, createVoiceCall, insertTranscriptLine, recordVoicePromise } from "../src/voice";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

const SUPPLIER = "00000000-0000-0000-0000-000000000001";
const BUYER = "00000000-0000-0000-0000-000000000002";
const INVOICE_A = "00000000-0000-0000-0000-0000000000a1";
const INVOICE_B = "00000000-0000-0000-0000-0000000000b1";
const INVOICE_C = "00000000-0000-0000-0000-0000000000c1";
const pid = (n: number): string => `00000000-0000-0000-0000-0000000001${String(n).padStart(2, "0")}`;

describe("migration 0005 on top of 0004 data", () => {
  let folder: string;

  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), "voice-migration-"));
  });
  afterAll(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it("keeps existing rows, leaves one Current_Promise per invoice, and defaults the new columns", async () => {
    const upTo0004 = join(folder, "up-to-0004");
    cpSync(MIGRATIONS_FOLDER, upTo0004, { recursive: true });
    const journalPath = join(upTo0004, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
    journal.entries = journal.entries.filter((entry) => entry.tag !== "0005_buyer_voice_call");
    expect(journal.entries.at(-1)?.tag).toBe("0004_payment_links_provider_link_id_key");
    writeFileSync(journalPath, JSON.stringify(journal));

    const pglite = new PGlite();
    try {
      const db = drizzle(pglite, { schema });
      await migrate(db, { migrationsFolder: upTo0004 });

      const before = await pglite.query(
        `select 1 from information_schema.columns where table_name = 'promises' and column_name = 'superseded_on'`,
      );
      expect(before.rows).toEqual([]);

      // Raw SQL: the Drizzle schema already knows the 0005 columns, which don't exist yet.
      // Invoice A has three promises (two on the same day, ordered by id), B has one, C has none.
      await pglite.exec(`
        insert into suppliers (id, name, udyam_number, supplier_category, supplier_activity)
          values ('${SUPPLIER}', 'Test Supplier', 'UDYAM-MH-00-0000001', 'micro', 'manufacturing');
        insert into buyers (id, supplier_id, name, name_key)
          values ('${BUYER}', '${SUPPLIER}', 'Sharma Traders', 'sharma traders');
        insert into invoices (id, supplier_id, buyer_id, invoice_number, invoice_number_key, invoice_date, accepted_on, amount_paise, supplier_category, supplier_activity)
          values
          ('${INVOICE_A}', '${SUPPLIER}', '${BUYER}', 'INV-A', 'inv-a', '2026-09-02', '2026-09-02', 41200000, 'micro', 'manufacturing'),
          ('${INVOICE_B}', '${SUPPLIER}', '${BUYER}', 'INV-B', 'inv-b', '2026-09-02', '2026-09-02', 1000000, 'micro', 'manufacturing'),
          ('${INVOICE_C}', '${SUPPLIER}', '${BUYER}', 'INV-C', 'inv-c', '2026-09-02', '2026-09-02', 2000000, 'micro', 'manufacturing');
        insert into promises (id, invoice_id, promised_date, amount_paise, recorded_on)
          values
          ('${pid(1)}', '${INVOICE_A}', '2026-10-10', 100, '2026-10-01'),
          ('${pid(2)}', '${INVOICE_A}', '2026-10-20', 200, '2026-10-05'),
          ('${pid(3)}', '${INVOICE_A}', '2026-10-30', 300, '2026-10-05'),
          ('${pid(4)}', '${INVOICE_B}', '2026-11-20', 400, '2026-11-12');
      `);

      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

      // Every old row is kept with its old values.
      const rows = await pglite.query(
        `select id, invoice_id, promised_date::text as promised_date, amount_paise, recorded_on::text as recorded_on,
                superseded_on::text as superseded_on, source, voice_call_id, spoken_text, is_partial
           from promises order by id`,
      );
      const manual = { source: "manual", voice_call_id: null, spoken_text: null, is_partial: false };
      expect(rows.rows).toEqual([
        { id: pid(1), invoice_id: INVOICE_A, promised_date: "2026-10-10", amount_paise: 100, recorded_on: "2026-10-01", superseded_on: "2026-10-05", ...manual },
        { id: pid(2), invoice_id: INVOICE_A, promised_date: "2026-10-20", amount_paise: 200, recorded_on: "2026-10-05", superseded_on: "2026-10-05", ...manual },
        { id: pid(3), invoice_id: INVOICE_A, promised_date: "2026-10-30", amount_paise: 300, recorded_on: "2026-10-05", superseded_on: null, ...manual },
        { id: pid(4), invoice_id: INVOICE_B, promised_date: "2026-11-20", amount_paise: 400, recorded_on: "2026-11-12", superseded_on: null, ...manual },
      ]);

      // Exactly one Current_Promise per invoice that has promises, none for the invoice without.
      const current = await pglite.query<{ invoice_id: string; n: number }>(
        `select invoice_id, count(*)::int as n from promises where superseded_on is null group by invoice_id order by invoice_id`,
      );
      expect(current.rows).toEqual([
        { invoice_id: INVOICE_A, n: 1 },
        { invoice_id: INVOICE_B, n: 1 },
      ]);

      // The other tables are kept.
      const kept = await pglite.query(`select (select count(*)::int from suppliers) as s, (select count(*)::int from buyers) as b, (select count(*)::int from invoices) as i`);
      expect(kept.rows).toEqual([{ s: 1, b: 1, i: 3 }]);

      // The new tables exist and are empty.
      for (const table of ["voice_calls", "voice_transcript_lines", "voice_tool_calls"]) {
        const result = await pglite.query<{ n: number }>(`select count(*)::int as n from ${table}`);
        expect(result.rows).toEqual([{ n: 0 }]);
      }

      // Inserting through the app schema defaults to manual / not partial.
      const [inserted] = await db
        .insert(promises)
        .values({ invoiceId: INVOICE_C, promisedDate: "2026-11-20", amountPaise: 500, recordedOn: "2026-11-12" })
        .returning({ source: promises.source, isPartial: promises.isPartial, supersededOn: promises.supersededOn });
      expect(inserted).toEqual({ source: "manual", isPartial: false, supersededOn: null });
    } finally {
      await pglite.close();
    }
  });
});

describe("demo reset and new column defaults", () => {
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

  const HASH = "a".repeat(64);
  const NOW = new Date("2026-11-12T05:00:00.000Z");

  it("clears voice_calls, voice_transcript_lines, voice_tool_calls and the voice promise, then reseeds", async () => {
    const t = await cloneTestDb(template);
    open.push(t);
    await seed(t.db);
    const [supplier] = await t.db.select({ id: suppliers.id }).from(suppliers);
    const [sharma] = await t.db.select({ id: invoices.id }).from(invoices).where(eq(invoices.invoiceNumber, "LPC/26-27/0412"));
    if (!supplier || !sharma) throw new Error("seed missing");

    const created = await createVoiceCall(t.db, {
      supplierId: supplier.id,
      invoiceId: sharma.id,
      callToday: "2026-11-12",
      tokenHash: HASH,
      now: NOW,
    });
    if (!created) throw new Error("call not created");
    await claimJoin(t.db, HASH, NOW);
    await insertTranscriptLine(t.db, { voiceCallId: created.voiceCallId, speaker: "buyer", itemId: "i1", text: "haan", now: NOW });
    await t.db.transaction(async (tx) => {
      await claimToolCall(tx, { voiceCallId: created.voiceCallId, callId: "call_1", tool: "record_promise_to_pay", arguments: "{}", now: NOW });
      await recordVoicePromise(tx, {
        voiceCallId: created.voiceCallId,
        invoiceId: sharma.id,
        callToday: "2026-11-12",
        promisedDate: "2026-11-20",
        amountPaise: 41_200_000,
        spokenText: "haan, Friday",
        isPartial: false,
        now: NOW,
      });
    });

    const [voicePromise] = await t.db.select().from(promises).where(eq(promises.invoiceId, sharma.id));
    expect(voicePromise).toMatchObject({ source: "voice", voiceCallId: created.voiceCallId, isPartial: false, supersededOn: null });
    expect(await t.db.select().from(voiceCalls)).toHaveLength(1);
    expect(await t.db.select().from(voiceTranscriptLines)).toHaveLength(1);
    expect(await t.db.select().from(voiceToolCalls)).toHaveLength(1);

    await resetDemo(t.db);

    expect(await t.db.select().from(voiceCalls)).toEqual([]);
    expect(await t.db.select().from(voiceTranscriptLines)).toEqual([]);
    expect(await t.db.select().from(voiceToolCalls)).toEqual([]);
    expect(await t.db.select().from(promises)).toEqual([]);
    expect(await t.db.select({ id: invoices.id }).from(invoices)).toHaveLength(6);
  });
});
