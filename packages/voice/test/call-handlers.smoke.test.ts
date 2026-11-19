// Smoke checks for runCallTool / handleTranscript / handleEnd on PGlite with the Demo_Seed.
// The full matrix lives in tools.test.ts and end-and-transcript.test.ts (task 5.3).
// Requirements: 5.2-5.14, 7.1-7.3, 7.5, 7.6, 8.1, 8.3, 8.4
import {
  DEMO_SUPPLIER,
  agentRuns,
  createVoiceCall,
  findSupplierIdByUdyam,
  invoices,
  promises,
  seed,
  voiceCalls,
  voiceTranscriptLines,
} from "@dues-banshee/db";
import { cloneTestDb, createTestDb, type TestDb } from "@dues-banshee/db/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { generateJoinToken, handleEnd, handleTranscript, hashToken, runCallTool } from "../src/index";

const NOW = new Date("2026-11-12T05:00:00.000Z");
const at = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1000);

let template: TestDb;
const open: TestDb[] = [];

beforeAll(async () => {
  template = await createTestDb();
  await seed(template.db);
});
afterAll(async () => {
  await template.close();
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((t) => t.close()));
});

async function liveCall() {
  const t = await cloneTestDb(template);
  open.push(t);
  const supplierId = await findSupplierIdByUdyam(t.db, DEMO_SUPPLIER.udyamNumber);
  const sharma = (await t.db.select({ id: invoices.id, n: invoices.invoiceNumber }).from(invoices)).find(
    (i) => i.n === "LPC/26-27/0412",
  );
  if (supplierId === null || sharma === undefined) throw new Error("test setup: demo seed missing");
  const token = generateJoinToken();
  const created = await createVoiceCall(t.db, {
    supplierId,
    invoiceId: sharma.id,
    callToday: "2026-11-12",
    tokenHash: hashToken(token),
    now: NOW,
  });
  if (created === null) throw new Error("test setup: createVoiceCall returned null");
  await t.pglite.query(`UPDATE voice_calls SET status = 'live', started_at = $2 WHERE id = $1`, [
    created.voiceCallId,
    NOW.toISOString(),
  ]);
  const id = created.voiceCallId;
  const tool = (name: string, args: string, callId: string, when = NOW, withToken = token) =>
    runCallTool({ db: t.db, now: when }, { voiceCallId: id, token: withToken, callId, name, arguments: args });
  const row = async () => (await t.db.select().from(voiceCalls)).find((c) => c.id === id)!;
  return { t, id, token, tool, row, buyerId: created.buyerId };
}

describe("runCallTool", () => {
  it("returns Engine facts for empty arguments and logs one Tool_Log row", async () => {
    const w = await liveCall();
    const r = await w.tool("get_invoice_facts", "  ", "call_1");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, principal: "₹4,12,000", days_overdue: 26, total_due: expect.any(String) });
    expect((await w.t.db.select().from(agentRuns)).filter((a) => a.tool === "get_invoice_facts")).toHaveLength(1);
  });

  it("records a promise, supersedes the old one, repeats a call_id without a second row", async () => {
    const w = await liveCall();
    const args = (n: number, d: string) => JSON.stringify({ amount_paise: n, date_iso: d, spoken_text: "haan" });
    const first = await w.tool("record_promise_to_pay", args(41712794, "2026-11-20"), "c1");
    expect(first.body).toMatchObject({ ok: true, date: "Friday, 20 Nov 2026", is_partial: false });
    expect(first.revalidateBuyerId).toBe(w.buyerId);
    const again = await w.tool("record_promise_to_pay", args(1, "2026-11-21"), "c1");
    expect(again.body).toEqual(first.body);
    await w.tool("record_promise_to_pay", args(20000000, "2026-11-25"), "c2");
    const rows = await w.t.db.select().from(promises);
    const voice = rows.filter((p) => p.source === "voice");
    expect(voice).toHaveLength(2);
    expect(voice.filter((p) => p.supersededOn === null)).toHaveLength(1);
    expect(await w.tool("record_promise_to_pay", args(0, "2026-11-20"), "c3")).toMatchObject({
      body: { ok: false, error: "amount_out_of_range" },
    });
    expect(await w.tool("record_promise_to_pay", args(100, "2026-12-13"), "c4")).toMatchObject({
      body: { ok: false, error: "date_out_of_range" },
    });
  });

  it("404s without logging for a wrong token; rejects unknown tools and bad call ids", async () => {
    const w = await liveCall();
    const before = (await w.t.db.select().from(agentRuns)).length;
    expect((await w.tool("get_invoice_facts", "{}", "c1", NOW, "wrong")).status).toBe(404);
    expect((await w.t.db.select().from(agentRuns)).length).toBe(before);
    expect((await w.tool("nope", "{}", "c1")).body).toMatchObject({ error: "unknown_tool" });
    expect((await w.tool("end_call", "{}", "bad id!")).body).toMatchObject({ error: "invalid_arguments" });
  });

  it("answers call_time_up at the cap and ends the call; ended_at = cap after the 60 s grace", async () => {
    const w = await liveCall();
    expect((await w.tool("end_call", `{"outcome":"dispute"}`, "c1")).body).toEqual({ ok: true });
    const r = await w.tool("get_invoice_facts", "{}", "c2", at(300));
    expect(r.body).toMatchObject({ ok: false, error: "call_time_up" });
    const row = await w.row();
    expect(row).toMatchObject({ status: "ended", outcome: "dispute", durationSeconds: 300 });
    expect(row.endedAt).toEqual(at(300));
    expect((await w.tool("get_invoice_facts", "{}", "c3", at(301))).status).toBe(404);

    const w2 = await liveCall();
    await w2.tool("get_invoice_facts", "{}", "c1", at(400));
    expect((await w2.row()).endedAt).toEqual(at(300));
  });
});

describe("handleTranscript and handleEnd", () => {
  it("stores, cuts, dedupes and skips blank lines; 404 on mismatch", async () => {
    const w = await liveCall();
    const send = (itemId: string, text: string, token = w.token) =>
      handleTranscript({ db: w.t.db, now: NOW }, { voiceCallId: w.id, token, itemId, speaker: "buyer", text });
    expect((await send("i1", "x".repeat(2500))).status).toBe(200);
    expect((await send("i1", "again")).status).toBe(200);
    expect((await send("i2", "   ")).status).toBe(200);
    expect((await send("i3", "hi", "wrong")).status).toBe(404);
    const lines = await w.t.db.select().from(voiceTranscriptLines);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toHaveLength(2000);
  });

  it("ends a live call once, ignores a client outcome, and leaves ended calls alone", async () => {
    const w = await liveCall();
    const clientSent = { outcome: "promise" }; // a client-sent outcome has no way into the handler
    const end = (when: Date, token = w.token) =>
      handleEnd({ db: w.t.db, now: when }, { voiceCallId: w.id, token, ...clientSent });
    expect((await end(NOW, "wrong")).status).toBe(404);
    const done = await end(at(42));
    expect(done).toMatchObject({ status: 200, revalidateBuyerId: w.buyerId });
    expect(await w.row()).toMatchObject({ status: "ended", outcome: "incomplete", durationSeconds: 42 });
    const repeat = await end(at(99));
    expect(repeat.status).toBe(200);
    expect((await w.row()).durationSeconds).toBe(42);
  });
});
