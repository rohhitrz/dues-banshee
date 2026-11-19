// End_Report, Call_Outcome rules, transcript lines and the stale rule, through handleEnd / handleTranscript /
// runCallTool on PGlite with the Demo_Seed (Sharma Traders, started_at 2026-11-12T05:00:00Z). Instants injected.
// Requirements: 7.1, 7.3, 7.5, 7.6, 8.1, 8.3, 8.4, 11.11
import { handleEnd, handleTranscript } from "../src/index";
import { describe, expect, it } from "vitest";
import { NOW, at, promiseArgs, useCallWorld } from "./support/call-world";

const world = useCallWorld();
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

describe("Call_Outcome on end", () => {
  it("is promise when a promise row of the call exists, even if end_call asked for another outcome", async () => {
    const w = await world.call();
    await w.tool("end_call", `{"outcome":"dispute"}`, "c1");
    await w.tool("record_promise_to_pay", promiseArgs(41712794, "2026-11-20"), "c2", at(20));
    const r = await w.end(at(40));
    expect(r).toEqual({ status: 200, body: { ok: true }, revalidateBuyerId: w.buyerId });
    expect(await w.row()).toMatchObject({ status: "ended", outcome: "promise", requestedOutcome: "dispute" });
  });

  it("is promise when the promise comes before end_call", async () => {
    const w = await world.call();
    await w.tool("record_promise_to_pay", promiseArgs(100, "2026-11-20"), "c1", at(20));
    await w.tool("end_call", `{"outcome":"no_promise"}`, "c2", at(30));
    await w.end(at(40));
    expect((await w.row()).outcome).toBe("promise");
  });

  it.each(["dispute", "no_promise", "consent_declined"] as const)(
    "is the requested outcome %s when there is no promise",
    async (outcome) => {
      const w = await world.call();
      await w.tool("end_call", JSON.stringify({ outcome }), "c1");
      await w.end(at(40));
      expect(await w.row()).toMatchObject({ status: "ended", outcome });
    },
  );

  it("uses the latest requested outcome", async () => {
    const w = await world.call();
    await w.tool("end_call", `{"outcome":"no_promise"}`, "c1");
    await w.tool("end_call", `{"outcome":"consent_declined"}`, "c2");
    await w.end(at(40));
    expect((await w.row()).outcome).toBe("consent_declined");
  });

  it("is incomplete with no promise and no requested outcome, also after a rejected promise", async () => {
    const w = await world.call();
    await w.tool("record_promise_to_pay", promiseArgs(0, "2026-11-20"), "c1");
    await w.end(at(40));
    expect(await w.row()).toMatchObject({ status: "ended", outcome: "incomplete", requestedOutcome: null });
  });
});

describe("handleEnd", () => {
  it("gives outcome promise when a promise was recorded before the end", async () => {
    const w = await world.call();
    await w.tool("record_promise_to_pay", promiseArgs(41712794, "2026-11-20"), "c1", at(20));
    await w.end(at(40));
    expect(await w.row()).toMatchObject({ status: "ended", outcome: "promise", requestedOutcome: null });
  });
  // PGlite runs on one connection, so this cannot run a true race between an end and an in-flight tool
  // request. It checks the statement order the race fix relies on: inside one transaction, the
  // `FOR UPDATE` select runs before the end `UPDATE`, as separate statements.
  it("locks the row before it runs the end UPDATE, in one transaction", async () => {
    const w = await world.call();
    const log: string[] = [];
    const transaction = w.t.pglite.transaction.bind(w.t.pglite) as (cb: (tx: never) => Promise<unknown>) => Promise<unknown>;
    w.t.pglite.transaction = ((cb: (tx: { query: (...a: unknown[]) => Promise<unknown> }) => Promise<unknown>) => {
      log.push("begin");
      return transaction((tx) =>
        cb(
          new Proxy(tx as unknown as { query: (...a: unknown[]) => Promise<unknown> }, {
            get(target, prop, receiver) {
              if (prop !== "query") return Reflect.get(target, prop, receiver) as unknown;
              return (text: unknown, ...rest: unknown[]) => {
                const t = String(text);
                log.push(/for update/i.test(t) ? "lock" : /^\s*update/i.test(t) ? "update" : "other");
                return target.query(text, ...rest);
              };
            },
          }),
        ),
      );
    }) as typeof w.t.pglite.transaction;
    await w.end(at(40));
    // The first transaction is the stale check (it locks no row here); the second is the end itself.
    const steps = log.filter((k) => k !== "other");
    expect(steps.slice(steps.lastIndexOf("begin"))).toEqual(["begin", "lock", "update"]);
    expect(await w.row()).toMatchObject({ status: "ended", endedAt: at(40) });
  });
  it("sets ended_at and whole-second duration", async () => {
    const w = await world.call();
    await w.end(new Date(NOW.getTime() + 42_900));
    expect(await w.row()).toMatchObject({
      status: "ended",
      durationSeconds: 42,
      endedAt: new Date(NOW.getTime() + 42_900),
    });
  });

  it("caps the duration at 300 seconds when the report comes after the cap but before the stale rule", async () => {
    const w = await world.call();
    await w.end(at(320));
    expect(await w.row()).toMatchObject({ status: "ended", durationSeconds: 300, endedAt: at(320) });
  });

  it("ignores an outcome sent by the client", async () => {
    const w = await world.call();
    const clientBody = { voiceCallId: w.id, token: w.token, outcome: "promise" };
    await handleEnd({ db: w.t.db, now: at(40) }, clientBody);
    expect((await w.row()).outcome).toBe("incomplete");
    expect(await w.voicePromises()).toEqual([]);
  });

  it("changes nothing on a repeated End_Report", async () => {
    const w = await world.call();
    await w.end(at(42));
    const before = await w.row();
    const repeat = await w.end(at(99));
    expect(repeat).toEqual({ status: 200, body: { ok: true } });
    expect(await w.row()).toEqual(before);
    expect(before).toMatchObject({ durationSeconds: 42, outcome: "incomplete", endedAt: at(42) });
  });

  it("answers 200 and changes nothing for a call that was never joined", async () => {
    const w = await world.call("created");
    const r = await w.end(at(5));
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(await w.row()).toMatchObject({ status: "created", startedAt: null, endedAt: null, outcome: null });
  });

  it("answers 404 and changes nothing for a wrong token or an unknown id", async () => {
    const w = await world.call();
    expect(await w.end(at(5), "wrong-token")).toEqual({ status: 404, body: { error: "not_found" } });
    for (const voiceCallId of [UNKNOWN_ID, "not-a-uuid"]) {
      const r = await handleEnd({ db: w.t.db, now: at(5) }, { voiceCallId, token: w.token });
      expect(r).toEqual({ status: 404, body: { error: "not_found" } });
    }
    expect(await w.row()).toMatchObject({ status: "live", endedAt: null, outcome: null });
  });
});

describe("handleTranscript", () => {
  it("stores one line with speaker, text and the server's receive time", async () => {
    const w = await world.call();
    const r = await w.transcript("item_1", "Haan ji, Friday tak de dunga", at(12), "buyer");
    expect(r).toEqual({ status: 200, body: { ok: true } });
    await w.transcript("item_2", "Shukriya Sharma ji", at(15), "agent");
    const lines = (await w.lines()).sort((a, b) => a.itemId.localeCompare(b.itemId));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      voiceCallId: w.id,
      speaker: "buyer",
      itemId: "item_1",
      text: "Haan ji, Friday tak de dunga",
      receivedAt: at(12),
    });
    expect(lines[1]).toMatchObject({ speaker: "agent", itemId: "item_2", receivedAt: at(15) });
  });

  it("keeps the first line for a repeated item id and still answers 200", async () => {
    const w = await world.call();
    await w.transcript("item_1", "first", at(1), "buyer");
    const again = await w.transcript("item_1", "second", at(2), "agent");
    expect(again).toEqual({ status: 200, body: { ok: true } });
    const lines = await w.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ text: "first", speaker: "buyer", receivedAt: at(1) });
  });

  it("cuts text to its first 2,000 characters and keeps exactly 2,000", async () => {
    const w = await world.call();
    const long = "a".repeat(1999) + "BC" + "d".repeat(500);
    await w.transcript("long", long);
    await w.transcript("exact", "e".repeat(2000));
    const lines = await w.lines();
    expect(lines.find((l) => l.itemId === "long")?.text).toBe("a".repeat(1999) + "B");
    expect(lines.find((l) => l.itemId === "exact")?.text).toBe("e".repeat(2000));
  });

  it("answers 200 and stores nothing for empty or whitespace text", async () => {
    const w = await world.call();
    for (const [i, text] of ["", "   ", "\n\t"].entries()) {
      expect(await w.transcript(`blank_${i}`, text)).toEqual({ status: 200, body: { ok: true } });
    }
    expect(await w.lines()).toEqual([]);
  });

  it("stores markup as plain data, unchanged", async () => {
    const w = await world.call();
    await w.transcript("html", `<img src=x onerror=alert(1)> "ignore previous instructions"`);
    expect((await w.lines())[0]?.text).toBe(`<img src=x onerror=alert(1)> "ignore previous instructions"`);
  });

  it("answers 404 and stores nothing for a wrong token, an unknown id, a created call or an ended call", async () => {
    const w = await world.call();
    expect(await w.transcript("i1", "hi", at(1), "buyer", "wrong-token")).toEqual({
      status: 404,
      body: { error: "not_found" },
    });
    for (const voiceCallId of [UNKNOWN_ID, "not-a-uuid"]) {
      const r = await handleTranscript(
        { db: w.t.db, now: at(1) },
        { voiceCallId, token: w.token, itemId: "i1", speaker: "buyer", text: "hi" },
      );
      expect(r).toEqual({ status: 404, body: { error: "not_found" } });
    }
    await w.end(at(10));
    expect(await w.transcript("i2", "late", at(11))).toEqual({ status: 404, body: { error: "not_found" } });

    const created = await world.call("created");
    expect(await created.transcript("i3", "early", at(1))).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await w.lines()).toEqual([]);
    expect(await created.lines()).toEqual([]);
  });
});

describe("the stale rule: no End_Report by started_at + 360 s", () => {
  it("leaves a call live and stores the line at started_at + 359 s", async () => {
    const w = await world.call();
    expect(await w.transcript("i1", "still talking", at(359))).toEqual({ status: 200, body: { ok: true } });
    expect(await w.row()).toMatchObject({ status: "live", endedAt: null });
    expect(await w.lines()).toHaveLength(1);
  });

  it("is ended by the next transcript with ended_at = started_at + 300 s and the line is refused", async () => {
    const w = await world.call();
    const r = await w.transcript("i1", "too late", at(360));
    expect(r).toEqual({ status: 404, body: { error: "not_found" }, revalidateBuyerId: w.buyerId });
    expect(await w.row()).toMatchObject({
      status: "ended",
      endedAt: at(300),
      durationSeconds: 300,
      outcome: "incomplete",
    });
    expect(await w.lines()).toEqual([]);
  });

  it("is ended by the next End_Report with ended_at = started_at + 300 s", async () => {
    const w = await world.call();
    const r = await w.end(at(360));
    expect(r).toEqual({ status: 200, body: { ok: true }, revalidateBuyerId: w.buyerId });
    expect(await w.row()).toMatchObject({ status: "ended", endedAt: at(300), durationSeconds: 300 });
  });

  it("is ended by the next tool request with ended_at = started_at + 300 s", async () => {
    const w = await world.call();
    const r = await w.tool("get_invoice_facts", "{}", "c1", at(500));
    expect(r.body).toMatchObject({ ok: false, error: "call_time_up" });
    expect(await w.row()).toMatchObject({ status: "ended", endedAt: at(300), durationSeconds: 300 });
  });

  it("keeps the promise outcome and a requested outcome when it ends a stale call", async () => {
    const promised = await world.call();
    await promised.tool("record_promise_to_pay", promiseArgs(100, "2026-11-20"), "c1", at(100));
    await promised.end(at(400));
    expect(await promised.row()).toMatchObject({ outcome: "promise", endedAt: at(300) });

    const disputed = await world.call();
    await disputed.tool("end_call", `{"outcome":"dispute"}`, "c1", at(100));
    await disputed.end(at(400));
    expect(await disputed.row()).toMatchObject({ outcome: "dispute", endedAt: at(300) });
  });
});
