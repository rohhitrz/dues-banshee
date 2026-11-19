import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../src/schema";
import { promises, suppliers, voiceCalls, invoices } from "../src/schema";
import { seed } from "../src/seed";
import { cloneTestDb, createTestDb, type TestDb } from "../src/testing";
import {
  claimJoin,
  claimToolCall,
  countStartedCalls,
  createVoiceCall,
  endStaleCalls,
  endVoiceCall,
  endVoiceCallAfterLock,
  findCallByIdAndHash,
  findInvoiceForCall,
  findJoinableCall,
  getCallContext,
  insertTranscriptLine,
  listBuyerVoiceCalls,
  lockLiveCall,
  recordVoicePromise,
  setRequestedOutcome,
  storeToolResult,
} from "../src/voice";

// Quick sanity checks that every voice.ts statement compiles and runs on PGlite.
// Behaviour tests per requirement live in later tasks.

const SHARMA = "LPC/26-27/0412";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const NOW = new Date("2026-11-12T05:00:00.000Z");
const at = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1000);

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

async function world() {
  const t = await cloneTestDb(template);
  open.push(t);
  await seed(t.db);
  const [supplier] = await t.db.select({ id: suppliers.id }).from(suppliers);
  const [sharma] = await t.db
    .select({ id: invoices.id, buyerId: invoices.buyerId })
    .from(invoices)
    .where(eq(invoices.invoiceNumber, SHARMA));
  if (!supplier || !sharma) throw new Error("seed missing");
  return { t, supplierId: supplier.id, invoiceId: sharma.id, buyerId: sharma.buyerId };
}

describe("voice db functions (PGlite sanity)", () => {
  it("creates, joins once, and finds the call", async () => {
    const { t, supplierId, invoiceId, buyerId } = await world();
    const created = await createVoiceCall(t.db, { supplierId, invoiceId, callToday: "2026-11-12", tokenHash: HASH_A, now: NOW });
    expect(created?.buyerId).toBe(buyerId);
    expect(created?.tokenExpiresAt).toEqual(at(600));

    expect(await findJoinableCall(t.db, HASH_A, at(599))).toMatchObject({ supplierName: expect.any(String) });
    expect(await findJoinableCall(t.db, HASH_A, at(600))).toBeNull();

    const [first, second] = await Promise.all([claimJoin(t.db, HASH_A, at(5)), claimJoin(t.db, HASH_A, at(5))]);
    expect([first, second].filter((r) => r !== null)).toHaveLength(1);
    expect(await claimJoin(t.db, HASH_A, at(6))).toBeNull();

    const ctx = await getCallContext(t.db, created!.voiceCallId);
    expect(ctx).toMatchObject({ status: "live", startedAt: at(5), callToday: "2026-11-12", buyerId, invoiceNumber: SHARMA });
    expect(ctx?.invoice.id).toBe(invoiceId);
  });

  it("a new call expires the buyer's other created calls", async () => {
    const { t, supplierId, invoiceId } = await world();
    const a = await createVoiceCall(t.db, { supplierId, invoiceId, callToday: "2026-11-12", tokenHash: HASH_A, now: NOW });
    await createVoiceCall(t.db, { supplierId, invoiceId, callToday: "2026-11-12", tokenHash: HASH_B, now: at(1) });
    const [row] = await t.db.select({ status: voiceCalls.status }).from(voiceCalls).where(eq(voiceCalls.id, a!.voiceCallId));
    expect(row?.status).toBe("expired");
    expect(await claimJoin(t.db, HASH_A, at(2))).toBeNull();
  });

  it("scopes invoice lookups to the supplier and rejects non-uuids", async () => {
    const { t, supplierId, invoiceId } = await world();
    expect(await findInvoiceForCall(t.db, supplierId, invoiceId)).toMatchObject({ invoiceNumber: SHARMA });
    expect(await findInvoiceForCall(t.db, supplierId, "nope")).toBeNull();
    expect(await findInvoiceForCall(t.db, "00000000-0000-4000-8000-000000000000", invoiceId)).toBeNull();
    expect(await createVoiceCall(t.db, { supplierId: "00000000-0000-4000-8000-000000000000", invoiceId, callToday: "2026-11-12", tokenHash: HASH_A, now: NOW })).toBeNull();
  });

  it("locks a live call, supersedes promises, dedupes tool calls, and ends with the right outcome", async () => {
    const { t, supplierId, invoiceId, buyerId } = await world();
    const created = await createVoiceCall(t.db, { supplierId, invoiceId, callToday: "2026-11-12", tokenHash: HASH_A, now: NOW });
    const id = created!.voiceCallId;
    expect(await lockLiveCall(t.db, id, HASH_A)).toBeNull(); // not live yet
    await claimJoin(t.db, HASH_A, at(0));

    await t.db.transaction(async (tx) => {
      const live = await lockLiveCall(tx, id, HASH_A);
      expect(live).toMatchObject({ voiceCallId: id, invoiceId, buyerId, requestedOutcome: null });
      expect(await lockLiveCall(tx, id, HASH_B)).toBeNull();

      expect(await claimToolCall(tx, { voiceCallId: id, callId: "call_1", tool: "record_promise_to_pay", arguments: "{}", now: at(10) })).toEqual({ kind: "claimed" });
      await recordVoicePromise(tx, { voiceCallId: id, invoiceId, callToday: "2026-11-12", promisedDate: "2026-11-20", amountPaise: 100, spokenText: "haan", isPartial: true, now: at(10) });
      await storeToolResult(tx, id, "call_1", { ok: true });
      expect(await claimToolCall(tx, { voiceCallId: id, callId: "call_1", tool: "x", arguments: "{}", now: at(11) })).toEqual({ kind: "repeat", result: { ok: true } });
    });
    await t.db.transaction(async (tx) => {
      await recordVoicePromise(tx, { voiceCallId: id, invoiceId, callToday: "2026-11-12", promisedDate: "2026-11-25", amountPaise: 200, spokenText: "haan", isPartial: false, now: at(20) });
    });
    const rows = await t.db.select().from(promises).where(eq(promises.invoiceId, invoiceId));
    expect(rows.filter((r) => r.supersededOn === null)).toHaveLength(1);
    expect(rows.filter((r) => r.supersededOn === "2026-11-12")).toHaveLength(1);

    expect(await setRequestedOutcome(t.db, id, "dispute")).toBe(true);
    expect(await endVoiceCall(t.db, id, at(400))).toEqual({ buyerId });
    expect(await endVoiceCall(t.db, id, at(500))).toBeNull();
    const [ended] = await t.db.select().from(voiceCalls).where(eq(voiceCalls.id, id));
    expect(ended).toMatchObject({ status: "ended", outcome: "promise", durationSeconds: 300, endedAt: at(400) });
    expect(await findCallByIdAndHash(t.db, id, HASH_A)).toMatchObject({ status: "ended" });
    expect(await findCallByIdAndHash(t.db, id, HASH_B)).toBeNull();
  });

  it("uses the requested outcome, else incomplete", async () => {
    const { t, supplierId, invoiceId } = await world();
    const a = await createVoiceCall(t.db, { supplierId, invoiceId, callToday: "2026-11-12", tokenHash: HASH_A, now: NOW });
    await claimJoin(t.db, HASH_A, at(0));
    await setRequestedOutcome(t.db, a!.voiceCallId, "no_promise");
    await endVoiceCall(t.db, a!.voiceCallId, at(30));
    const b = await createVoiceCall(t.db, { supplierId, invoiceId, callToday: "2026-11-12", tokenHash: HASH_B, now: at(40) });
    await claimJoin(t.db, HASH_B, at(41));
    await endVoiceCall(t.db, b!.voiceCallId, at(50));
    const rows = await t.db.select({ id: voiceCalls.id, outcome: voiceCalls.outcome, d: voiceCalls.durationSeconds }).from(voiceCalls);
    expect(rows.find((r) => r.id === a!.voiceCallId)).toMatchObject({ outcome: "no_promise", d: 30 });
    expect(rows.find((r) => r.id === b!.voiceCallId)).toMatchObject({ outcome: "incomplete", d: 9 });
  });

  it("ends stale calls at started_at + 300 s only after 360 s", async () => {
    const { t, supplierId, invoiceId, buyerId } = await world();
    const a = await createVoiceCall(t.db, { supplierId, invoiceId, callToday: "2026-11-12", tokenHash: HASH_A, now: NOW });
    await claimJoin(t.db, HASH_A, at(0));
    expect(await endStaleCalls(t.db, at(359), { voiceCallId: a!.voiceCallId })).toEqual([]);
    expect(await endStaleCalls(t.db, at(360), { supplierId, buyerId })).toEqual([buyerId]);
    const [row] = await t.db.select().from(voiceCalls).where(eq(voiceCalls.id, a!.voiceCallId));
    expect(row).toMatchObject({ status: "ended", outcome: "incomplete", durationSeconds: 300, endedAt: at(300) });
  });

  it("stores transcript lines (dedupe, cut, skip empty) and lists them with tool calls", async () => {
    const { t, supplierId, invoiceId, buyerId } = await world();
    const a = await createVoiceCall(t.db, { supplierId, invoiceId, callToday: "2026-11-12", tokenHash: HASH_A, now: NOW });
    const id = a!.voiceCallId;
    await claimJoin(t.db, HASH_A, at(0));
    const base = { voiceCallId: id, speaker: "buyer" as const, now: at(3) };
    expect(await insertTranscriptLine(t.db, { ...base, itemId: "i1", text: "   " })).toBe("skipped");
    expect(await insertTranscriptLine(t.db, { ...base, itemId: "i1", text: "x".repeat(2500) })).toBe("inserted");
    expect(await insertTranscriptLine(t.db, { ...base, itemId: "i1", text: "again" })).toBe("duplicate");
    expect(await insertTranscriptLine(t.db, { ...base, itemId: "i2", text: "😀".repeat(2001) })).toBe("inserted");

    const calls = await listBuyerVoiceCalls(t.db, supplierId, buyerId, at(10));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.transcript.map((l) => Array.from(l.text).length)).toEqual([2000, 2000]);
    expect(await countStartedCalls(t.db, { supplierId, buyerId }, { start: NOW, end: at(3600) })).toBe(1);
    expect(await countStartedCalls(t.db, { supplierId }, { start: at(3600), end: at(7200) })).toBe(0);

    // another supplier sees nothing
    expect(await listBuyerVoiceCalls(t.db, "00000000-0000-4000-8000-000000000000", buyerId, at(10))).toEqual([]);
  });
});

describe("end path: lock first, then update", () => {
  // PGlite runs on one connection, so this cannot run a true race between two requests. It checks the
  // statement order instead: the `FOR UPDATE` select must run before the end `UPDATE`, as separate
  // statements. Under Postgres READ COMMITTED that order makes the `EXISTS (promises)` outcome check
  // take a fresh snapshot after the lock wait.
  async function loggedWorld() {
    const w = await world();
    const statements: string[] = [];
    const db = drizzle(w.t.pglite, { schema, logger: { logQuery: (query: string) => void statements.push(query) } });
    const created = await createVoiceCall(w.t.db, {
      supplierId: w.supplierId,
      invoiceId: w.invoiceId,
      callToday: "2026-11-12",
      tokenHash: HASH_A,
      now: NOW,
    });
    await claimJoin(w.t.db, HASH_A, at(0));
    return { ...w, db, statements, id: created!.voiceCallId };
  }
  const kinds = (statements: string[]): string[] =>
    statements.map((q) => (/for update/i.test(q) ? "lock" : /^\s*update/i.test(q) ? "update" : "other"));

  it("endVoiceCallAfterLock locks the row, then updates it in a separate statement", async () => {
    const { db, statements, id, buyerId } = await loggedWorld();
    expect(await endVoiceCallAfterLock(db, id, at(40))).toEqual({ buyerId });
    expect(kinds(statements).filter((k) => k !== "other")).toEqual(["lock", "update"]);
    expect(statements.find((q) => /^\s*update/i.test(q))).not.toMatch(/for update/i);
  });

  it("endVoiceCallAfterLock gives outcome promise for a promise recorded before the end", async () => {
    const { t, id, invoiceId, buyerId } = await loggedWorld();
    await t.db.transaction(async (tx) => {
      await recordVoicePromise(tx, { voiceCallId: id, invoiceId, callToday: "2026-11-12", promisedDate: "2026-11-20", amountPaise: 100, spokenText: "haan", isPartial: true, now: at(10) });
    });
    expect(await endVoiceCallAfterLock(t.db, id, at(40))).toEqual({ buyerId });
    const [row] = await t.db.select().from(voiceCalls).where(eq(voiceCalls.id, id));
    expect(row).toMatchObject({ status: "ended", outcome: "promise", endedAt: at(40) });
  });

  it("endVoiceCallAfterLock changes nothing and returns null for a call that is not live", async () => {
    const { db, statements, id } = await loggedWorld();
    await endVoiceCall(db, id, at(30));
    statements.length = 0;
    expect(await endVoiceCallAfterLock(db, id, at(99))).toBeNull();
    expect(kinds(statements)).not.toContain("update");
    const [row] = await db.select().from(voiceCalls).where(eq(voiceCalls.id, id));
    expect(row?.endedAt).toEqual(at(30));
  });

  it("endStaleCalls locks the matching live rows, then updates them in a separate statement", async () => {
    const { db, statements, id, buyerId } = await loggedWorld();
    statements.length = 0;
    expect(await endStaleCalls(db, at(360), { voiceCallId: id })).toEqual([buyerId]);
    expect(kinds(statements).filter((k) => k !== "other")).toEqual(["lock", "update"]);
    const [row] = await db.select().from(voiceCalls).where(eq(voiceCalls.id, id));
    expect(row).toMatchObject({ status: "ended", endedAt: at(300) });
  });

  it("endStaleCalls runs no update when no live row is stale", async () => {
    const { db, statements, id } = await loggedWorld();
    statements.length = 0;
    expect(await endStaleCalls(db, at(359), { voiceCallId: id })).toEqual([]);
    expect(kinds(statements)).not.toContain("update");
  });
});
