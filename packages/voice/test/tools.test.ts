// Call_Tools through runCallTool on PGlite with the Demo_Seed: Sharma Traders, LPC/26-27/0412,
// call_today 2026-11-12, started_at 2026-11-12T05:00:00Z. Every instant is injected.
// Requirements: 5.2-5.14, 11.3, 11.6, 11.11
import { describe, expect, it } from "vitest";
import { runCallTool } from "../src/index";
import { NOW, SHARMA_FACTS, at, promiseArgs, useCallWorld } from "./support/call-world";

const world = useCallWorld();

const AMOUNT_MESSAGE = "The amount must be more than zero and at most the total due.";
const DATE_MESSAGE = "The date must be one of the allowed dates.";
const BANK_RATE_MESSAGE = "The interest figure is not available right now. Do not state interest or a total.";
const TIME_UP_MESSAGE = "The call time is over. Say goodbye and end the call.";

describe("record_promise_to_pay: amount", () => {
  it("accepts the full total due for 2026-11-20 as not partial and stores the promise row", async () => {
    const w = await world.call();
    const r = await w.tool("record_promise_to_pay", promiseArgs(41712794, "2026-11-20", "Friday tak pura de dunga"), "c1");
    expect(r).toEqual({
      status: 200,
      body: { ok: true, amount_words: "four lakh seventeen thousand one hundred twenty-seven rupees and ninety-four paise", date: "Friday, 20 November 2026", is_partial: false },
      revalidateBuyerId: w.buyerId,
    });
    const rows = await w.voicePromises();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      invoiceId: w.sharmaInvoiceId,
      promisedDate: "2026-11-20",
      amountPaise: 41712794,
      recordedOn: "2026-11-12",
      supersededOn: null,
      source: "voice",
      voiceCallId: w.id,
      spokenText: "Friday tak pura de dunga",
      isPartial: false,
    });
  });

  it("accepts 20000000 paise for 2026-11-20 as a partial promise", async () => {
    const w = await world.call();
    const r = await w.tool("record_promise_to_pay", promiseArgs(20000000, "2026-11-20"), "c1");
    expect(r.body).toEqual({ ok: true, amount_words: "two lakh rupees", date: "Friday, 20 November 2026", is_partial: true });
    expect((await w.voicePromises())[0]).toMatchObject({ amountPaise: 20000000, isPartial: true });
  });

  it.each([0, -1, 41712795])("rejects %i paise with amount_out_of_range and changes no data", async (amount) => {
    const w = await world.call();
    const before = (await w.promiseRows()).length;
    const r = await w.tool("record_promise_to_pay", promiseArgs(amount, "2026-11-20"), "c1");
    expect(r).toEqual({
      status: 200,
      body: { ok: false, error: "amount_out_of_range", message: AMOUNT_MESSAGE, total_due_words: "four lakh seventeen thousand one hundred twenty-seven rupees and ninety-four paise", total_due_paise: 41_712_794 },
    });
    expect(await w.promiseRows()).toHaveLength(before);
    expect(await w.voicePromises()).toEqual([]);
  });
});

describe("record_promise_to_pay: date", () => {
  it.each(["2026-11-11", "2026-12-13", "2026-02-30"])(
    "rejects %s with date_out_of_range and changes no data",
    async (date) => {
      const w = await world.call();
      const before = (await w.promiseRows()).length;
      const r = await w.tool("record_promise_to_pay", promiseArgs(100, date), "c1");
      expect(r).toEqual({
        status: 200,
        body: {
          ok: false,
          error: "date_out_of_range",
          message: DATE_MESSAGE,
          first_date: "Thursday, 12 November 2026",
          last_date: "Saturday, 12 December 2026",
        },
      });
      expect(await w.promiseRows()).toHaveLength(before);
    },
  );

  it.each([
    ["2026-11-12", "Thursday, 12 November 2026"],
    ["2026-12-12", "Saturday, 12 December 2026"],
  ])("accepts the window edge %s", async (date, agentDate) => {
    const w = await world.call();
    const r = await w.tool("record_promise_to_pay", promiseArgs(100, date), "c1");
    expect(r.body).toEqual({ ok: true, amount_words: "one rupee", date: agentDate, is_partial: true });
    expect((await w.voicePromises())[0]).toMatchObject({ promisedDate: date });
  });
});

describe("record_promise_to_pay: one Current_Promise", () => {
  it("supersedes the first promise on call_today when a second is accepted", async () => {
    const w = await world.call();
    await w.tool("record_promise_to_pay", promiseArgs(41712794, "2026-11-20"), "c1");
    await w.tool("record_promise_to_pay", promiseArgs(20000000, "2026-11-25"), "c2", at(30));
    const rows = (await w.voicePromises()).sort((a, b) => a.promisedDate.localeCompare(b.promisedDate));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ promisedDate: "2026-11-20", supersededOn: "2026-11-12" });
    expect(rows[1]).toMatchObject({ promisedDate: "2026-11-25", supersededOn: null, isPartial: true });
    expect(rows.filter((p) => p.supersededOn === null)).toHaveLength(1);
  });

  it("leaves exactly one Current_Promise when two requests overlap", async () => {
    const w = await world.call();
    await Promise.all([
      w.tool("record_promise_to_pay", promiseArgs(100, "2026-11-20"), "c1"),
      w.tool("record_promise_to_pay", promiseArgs(200, "2026-11-21"), "c2"),
    ]);
    const rows = await w.voicePromises();
    expect(rows).toHaveLength(2);
    expect(rows.filter((p) => p.supersededOn === null)).toHaveLength(1);
  });
});

describe("a repeated call_id", () => {
  it("returns the stored result and leaves one promise row and one tool-call row", async () => {
    const w = await world.call();
    const first = await w.tool("record_promise_to_pay", promiseArgs(41712794, "2026-11-20"), "c1");
    const again = await w.tool("record_promise_to_pay", promiseArgs(1, "2026-11-21"), "c1", at(5));
    // The repeat changes nothing, so it asks for no revalidation.
    expect(again).toEqual({
      status: 200,
      body: { ok: true, amount_words: "four lakh seventeen thousand one hundred twenty-seven rupees and ninety-four paise", date: "Friday, 20 November 2026", is_partial: false },
    });
    expect(again.body).toEqual(first.body);
    expect(await w.voicePromises()).toHaveLength(1);
    expect(await w.toolCallRows()).toHaveLength(1);
  });

  it("returns a stored error result too, even when the new arguments are valid", async () => {
    const w = await world.call();
    const first = await w.tool("record_promise_to_pay", promiseArgs(0, "2026-11-20"), "c1");
    const again = await w.tool("record_promise_to_pay", promiseArgs(100, "2026-11-20"), "c1");
    expect(again.body).toEqual(first.body);
    expect(again.body).toEqual({ ok: false, error: "amount_out_of_range", message: AMOUNT_MESSAGE, total_due_words: "four lakh seventeen thousand one hundred twenty-seven rupees and ninety-four paise", total_due_paise: 41_712_794 });
    expect(await w.voicePromises()).toEqual([]);
    expect(await w.toolCallRows()).toHaveLength(1);
  });

  it("does not repeat a call_id across tools: the stored result wins over the new tool name", async () => {
    const w = await world.call();
    await w.tool("end_call", `{"outcome":"dispute"}`, "c1");
    const again = await w.tool("get_invoice_facts", "{}", "c1");
    expect(again.body).toEqual({ ok: true });
  });
});

describe("404 before anything runs", () => {
  it("answers 404 with no Tool_Log row and no data change for a wrong token", async () => {
    const w = await world.call();
    const r = await w.tool("record_promise_to_pay", promiseArgs(100, "2026-11-20"), "c1", NOW, "wrong-token");
    expect(r).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await w.toolLog()).toEqual([]);
    expect(await w.toolCallRows()).toEqual([]);
    expect(await w.voicePromises()).toEqual([]);
  });

  it("answers 404 for an unknown or malformed voiceCallId", async () => {
    const w = await world.call();
    for (const voiceCallId of ["00000000-0000-4000-8000-000000000000", "not-a-uuid", ""]) {
      const r = await runCallTool(
        { db: w.t.db, now: NOW },
        { voiceCallId, token: w.token, callId: "c1", name: "get_invoice_facts", arguments: "{}" },
      );
      expect(r).toEqual({ status: 404, body: { error: "not_found" } });
    }
    expect(await w.toolLog()).toEqual([]);
  });

  it("answers 404 for a call that was never joined (created)", async () => {
    const w = await world.call("created");
    const r = await w.tool("get_invoice_facts", "{}", "c1");
    expect(r).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await w.toolLog()).toEqual([]);
    expect(await w.toolCallRows()).toEqual([]);
  });

  it("answers 404 for an ended call", async () => {
    const w = await world.call();
    await w.end(at(10));
    const r = await w.tool("record_promise_to_pay", promiseArgs(100, "2026-11-20"), "c1", at(11));
    expect(r).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await w.toolLog()).toEqual([]);
    expect(await w.voicePromises()).toEqual([]);
  });
});

describe("the client cannot choose the invoice", () => {
  it("ignores an invoice id, supplier id, call_today and amount limit sent beside the request", async () => {
    const w = await world.call();
    const sneaky = {
      voiceCallId: w.id,
      token: w.token,
      callId: "c1",
      name: "get_invoice_facts",
      arguments: "{}",
      invoiceId: w.otherInvoiceId,
      supplierId: "00000000-0000-4000-8000-000000000000",
      callToday: "2026-12-01",
      totalDue: 1,
    };
    const facts = await runCallTool({ db: w.t.db, now: NOW }, sneaky);
    expect(facts.body).toEqual({ ok: true, ...SHARMA_FACTS });

    const promised = await runCallTool(
      { db: w.t.db, now: NOW },
      { ...sneaky, callId: "c2", name: "record_promise_to_pay", arguments: promiseArgs(41712794, "2026-11-20") },
    );
    expect(promised.body).toMatchObject({ ok: true });
    const rows = await w.voicePromises();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ invoiceId: w.sharmaInvoiceId, recordedOn: "2026-11-12" });
    expect((await w.toolLog()).every((l) => l.invoiceId === w.sharmaInvoiceId)).toBe(true);
  });

  it("takes the invoice from the call row also when the arguments carry extra fields", async () => {
    const w = await world.call();
    const r = await w.tool(
      "record_promise_to_pay",
      JSON.stringify({ amount_paise: 100, date_iso: "2026-11-20", spoken_text: "ok", invoice_id: w.otherInvoiceId }),
      "c1",
    );
    expect(r.body).toEqual({ ok: false, error: "invalid_arguments", message: "The arguments do not match the tool's schema." });
    expect(await w.voicePromises()).toEqual([]);
  });
});

describe("the Call_Cap", () => {
  it("answers call_time_up at started_at + 300 s, runs no tool and ends the call", async () => {
    const w = await world.call();
    const r = await w.tool("record_promise_to_pay", promiseArgs(100, "2026-11-20"), "c1", at(300));
    expect(r).toEqual({
      status: 200,
      body: { ok: false, error: "call_time_up", message: TIME_UP_MESSAGE },
      revalidateBuyerId: w.buyerId,
    });
    expect(await w.row()).toMatchObject({
      status: "ended",
      outcome: "incomplete",
      durationSeconds: 300,
      endedAt: at(300),
    });
    expect(await w.voicePromises()).toEqual([]);
    expect(await w.toolCallRows()).toEqual([]);
  });

  it("still runs a tool at started_at + 299 s", async () => {
    const w = await world.call();
    const r = await w.tool("get_invoice_facts", "{}", "c1", at(299));
    expect(r.body).toEqual({ ok: true, ...SHARMA_FACTS });
    expect((await w.row()).status).toBe("live");
  });

  it("ends with ended_at = the cap when the request comes 60 s or more after it", async () => {
    const w = await world.call();
    await w.tool("get_invoice_facts", "{}", "c1", at(359));
    expect((await w.row()).endedAt).toEqual(at(359));
    const w2 = await world.call();
    const r = await w2.tool("get_invoice_facts", "{}", "c1", at(360));
    expect(r.body).toEqual({ ok: false, error: "call_time_up", message: TIME_UP_MESSAGE });
    expect(await w2.row()).toMatchObject({ status: "ended", durationSeconds: 300, endedAt: at(300) });
  });

  it("checks the cap before a repeated call_id", async () => {
    const w = await world.call();
    await w.tool("get_invoice_facts", "{}", "c1", at(10));
    const r = await w.tool("get_invoice_facts", "{}", "c1", at(300));
    expect(r.body).toEqual({ ok: false, error: "call_time_up", message: TIME_UP_MESSAGE });
  });

  it("gives a promise recorded before the cap the outcome promise when the call ends at the cap", async () => {
    const w = await world.call();
    await w.tool("record_promise_to_pay", promiseArgs(100, "2026-11-20"), "c1", at(100));
    await w.tool("get_invoice_facts", "{}", "c2", at(300));
    expect(await w.row()).toMatchObject({ status: "ended", outcome: "promise", durationSeconds: 300 });
  });
});

describe("Tool_Log: one row per request past the 404 check", () => {
  it("logs accepted, rejected, repeated, invalid, unknown and call_time_up requests once each", async () => {
    const w = await world.call();
    const requests: [string, string, string, Date][] = [
      ["get_invoice_facts", "{}", "c1", NOW],
      ["record_promise_to_pay", promiseArgs(0, "2026-11-20"), "c2", NOW],
      ["record_promise_to_pay", promiseArgs(100, "2026-11-20"), "c3", NOW],
      ["record_promise_to_pay", promiseArgs(100, "2026-11-20"), "c3", NOW],
      ["record_promise_to_pay", "{", "c4", NOW],
      ["no_such_tool", "{}", "c5", NOW],
      ["end_call", `{"outcome":"no_promise"}`, "c6", NOW],
      ["get_invoice_facts", "{}", "c7", at(300)],
    ];
    for (const [index, [name, args, callId, when]] of requests.entries()) {
      await w.tool(name, args, callId, when);
      expect(await w.toolLog(), `after request ${index + 1}`).toHaveLength(index + 1);
    }
    const log = await w.toolLog();
    expect(log.map((l) => l.tool).sort()).toEqual([
      "end_call",
      "get_invoice_facts",
      "get_invoice_facts",
      "no_such_tool",
      "record_promise_to_pay",
      "record_promise_to_pay",
      "record_promise_to_pay",
      "record_promise_to_pay",
    ]);
  });

  it("stores the tool, invoice id, voiceCallId, call_id, arguments and result, and no Join_Token", async () => {
    const w = await world.call();
    const args = promiseArgs(100, "2026-12-13", "agle mahine");
    await w.tool("record_promise_to_pay", args, "call_Xy-9");
    const log = await w.toolLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      tool: "record_promise_to_pay",
      invoiceId: w.sharmaInvoiceId,
      input: { voiceCallId: w.id, callId: "call_Xy-9", arguments: args },
      output: {
        ok: false,
        error: "date_out_of_range",
        message: DATE_MESSAGE,
        first_date: "Thursday, 12 November 2026",
        last_date: "Saturday, 12 December 2026",
      },
    });
    expect(JSON.stringify(log)).not.toContain(w.token);
  });

  it("logs a call_id that does not fit the format as invalid_arguments without a tool-call row", async () => {
    const w = await world.call();
    const r = await w.tool("get_invoice_facts", "{}", "bad id!");
    expect(r.body).toEqual({ ok: false, error: "invalid_arguments", message: "The call_id is not valid." });
    expect(await w.toolLog()).toHaveLength(1);
    expect(await w.toolCallRows()).toEqual([]);
  });
});

describe("get_invoice_facts", () => {
  it.each(["", "   ", "\n\t "])("works with empty or whitespace arguments %j", async (args) => {
    const w = await world.call();
    const r = await w.tool("get_invoice_facts", args, "c1");
    expect(r).toEqual({ status: 200, body: { ok: true, ...SHARMA_FACTS } });
  });

  it("returns no digit amount string: words fields and total_due_paise only", async () => {
    const w = await world.call();
    const r = await w.tool("get_invoice_facts", "{}", "c1");
    const body = r.body as Record<string, unknown>;
    for (const key of ["principal", "interest", "total_due", "amount"]) expect(body).not.toHaveProperty(key);
    expect(JSON.stringify(body)).not.toContain("₹");
    expect(body.total_due_paise).toBe(41_712_794);
  });

  it("returns the Sharma facts for `{}` and changes no data", async () => {
    const w = await world.call();
    const before = (await w.promiseRows()).length;
    const r = await w.tool("get_invoice_facts", "{}", "c1");
    expect(r.body).toEqual({ ok: true, ...SHARMA_FACTS });
    expect(r.revalidateBuyerId).toBeUndefined();
    expect(await w.promiseRows()).toHaveLength(before);
  });
});

describe("bank_rate_missing", () => {
  async function withoutBankRate() {
    const w = await world.call();
    await w.t.pglite.query(`DELETE FROM config WHERE key = 'rbi_bank_rate_bps'`);
    return w;
  }

  it("get_invoice_facts returns every field except interest and total due", async () => {
    const w = await withoutBankRate();
    const r = await w.tool("get_invoice_facts", "{}", "c1");
    expect(r).toEqual({
      status: 200,
      body: {
        ok: false,
        error: "bank_rate_missing",
        message: BANK_RATE_MESSAGE,
        buyer_name: "Sharma Traders",
        supplier_name: "Laxmi Precision Components (Demo)",
        invoice_number: "LPC/26-27/0412",
        principal_words: "four lakh twelve thousand rupees",
        due_date: "17 October 2026",
        due_rule_ids: ["MSMED-15"],
        days_overdue: 26,
        tax_bomb_date: "31 March 2027",
        tax_bomb_days_left: 139,
        tax_bomb_rule_ids: ["IT-43BH"],
      },
    });
  });

  it("record_promise_to_pay returns bank_rate_missing and changes no data", async () => {
    const w = await withoutBankRate();
    const before = (await w.promiseRows()).length;
    const r = await w.tool("record_promise_to_pay", promiseArgs(100, "2026-11-20"), "c1");
    expect(r).toEqual({ status: 200, body: { ok: false, error: "bank_rate_missing", message: BANK_RATE_MESSAGE } });
    expect(await w.promiseRows()).toHaveLength(before);
    expect(await w.toolLog()).toHaveLength(1);
  });
});

describe("unknown_tool and invalid_arguments change no data", () => {
  const INVALID = { ok: false, error: "invalid_arguments", message: "The arguments do not match the tool's schema." };

  it("returns unknown_tool for a name that is not a Call_Tool", async () => {
    const w = await world.call();
    const r = await w.tool("delete_everything", "{}", "c1");
    expect(r).toEqual({
      status: 200,
      body: { ok: false, error: "unknown_tool", message: "There is no tool with that name." },
    });
  });

  it.each([
    ["not JSON", "record_promise_to_pay", "{"],
    ["a missing field", "record_promise_to_pay", `{"amount_paise":100,"date_iso":"2026-11-20"}`],
    ["a string amount", "record_promise_to_pay", `{"amount_paise":"100","date_iso":"2026-11-20","spoken_text":"ok"}`],
    ["a fractional amount", "record_promise_to_pay", `{"amount_paise":1.5,"date_iso":"2026-11-20","spoken_text":"ok"}`],
    ["a date in the wrong format", "record_promise_to_pay", `{"amount_paise":100,"date_iso":"20-11-2026","spoken_text":"ok"}`],
    ["empty spoken text", "record_promise_to_pay", `{"amount_paise":100,"date_iso":"2026-11-20","spoken_text":""}`],
    ["spoken text over 2,000 characters", "record_promise_to_pay", JSON.stringify({ amount_paise: 100, date_iso: "2026-11-20", spoken_text: "x".repeat(2001) })],
    ["an outcome that is not allowed", "end_call", `{"outcome":"promise"}`],
    ["no outcome", "end_call", "{}"],
    ["an argument for a no-argument tool", "get_invoice_facts", `{"invoice_id":"x"}`],
  ])("returns invalid_arguments for %s", async (_label, name, args) => {
    const w = await world.call();
    const before = (await w.promiseRows()).length;
    const r = await w.tool(name, args, "c1");
    expect(r).toEqual({ status: 200, body: INVALID });
    expect(await w.promiseRows()).toHaveLength(before);
    expect((await w.row()).requestedOutcome).toBeNull();
    expect((await w.row()).status).toBe("live");
    expect(await w.toolLog()).toHaveLength(1);
  });
});

describe("end_call", () => {
  it.each(["dispute", "no_promise", "consent_declined"] as const)("stores %s as the requested outcome and keeps the call live", async (outcome) => {
    const w = await world.call();
    const r = await w.tool("end_call", JSON.stringify({ outcome }), "c1");
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(await w.row()).toMatchObject({ requestedOutcome: outcome, status: "live", outcome: null });
  });

  it("replaces an earlier requested outcome with the latest one", async () => {
    const w = await world.call();
    await w.tool("end_call", `{"outcome":"no_promise"}`, "c1");
    await w.tool("end_call", `{"outcome":"dispute"}`, "c2");
    expect((await w.row()).requestedOutcome).toBe("dispute");
    await w.tool("end_call", `{"outcome":"consent_declined"}`, "c3");
    expect((await w.row()).requestedOutcome).toBe("consent_declined");
  });
});
