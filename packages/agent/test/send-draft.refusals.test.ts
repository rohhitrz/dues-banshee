// sendDraft refusals on the Demo_Seed (PGlite, fakeHttp, no network). Every refusal makes zero Razorpay
// and zero Twilio calls and writes no Message_Row, Pay_Link or Escalation_Event, and holds no send
// claim. The length limit: 1,601 characters is refused for Twilio and still goes out through wa.me,
// 1,600 characters is one Twilio create call.
// Requirements: 2.2, 2.3, 2.5, 2.6, 3.4, 3.8, 9.3, 9.4, 9.12
import { suppliers } from "@dues-banshee/db";
import type { TestDb } from "@dues-banshee/db/testing";
import type { EscalationDecision } from "@dues-banshee/engine";
import type { CalendarDate } from "@dues-banshee/engine";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PAY_LINK_TEXT } from "../src/core/fact-sheet";
import { parseE164 } from "../src/channel/message-channel";
import { buildOutboundText } from "../src/channel/outbound-text";
import { sendDraft } from "../src/channel/send-draft";
import type { SendOutcome } from "../src/channel/send-draft";
import { waMeUrl } from "../src/channel/wa-me";
import {
  BUYER_NUMBER,
  CHANNEL_ENV_VALUES,
  DEMO_TODAY,
  MOCK_PAY_LINK_URL,
  RAZORPAY_LINKS_URL,
  SHARMA_AMOUNT_PAISE,
  TWILIO_CREATE_URL,
  buildSendHarness,
  cloneSendWorld,
  createSendTemplate,
  draftAndApproveSharma,
  providerRoutes,
  toolRowsInOrder,
  toolRowsSince,
} from "./helpers/send-fixtures";
import type { SendWorld } from "./helpers/send-fixtures";

const RULE_IDS = ["MSMED-15", "MSMED-16"] as const;
const UNKNOWN_UUID = "00000000-0000-4000-8000-000000000000";
const LIMIT = 1600;

let template: TestDb;
const open: TestDb[] = [];

beforeAll(async () => {
  template = await createSendTemplate();
});

afterAll(async () => {
  await template.close();
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((t) => t.close()));
});

async function world(): Promise<SendWorld> {
  const w = await cloneSendWorld(template);
  open.push(w.t);
  return w;
}

async function count(w: SendWorld, table: "messages" | "payment_links" | "escalation_events"): Promise<number> {
  const r = await w.t.pglite.query<{ n: number }>(`select count(*)::int as n from ${table}`);
  return r.rows[0]?.n ?? -1;
}

async function written(w: SendWorld) {
  return {
    messages: await count(w, "messages"),
    paymentLinks: await count(w, "payment_links"),
    escalationEvents: await count(w, "escalation_events"),
  };
}

async function claimHeld(w: SendWorld, draftId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/.test(draftId)) return false;
  const r = await w.t.pglite.query<{ held: boolean }>(
    "select send_claimed_at is not null as held from drafts where id = $1",
    [draftId],
  );
  return r.rows[0]?.held ?? false;
}

interface Attempt {
  outcome: SendOutcome;
  toolRows: Awaited<ReturnType<typeof toolRowsSince>>;
}

/**
 * One sendDraft call that must be a refusal: no Razorpay or Twilio request, no new Message_Row,
 * Pay_Link or Escalation_Event, no claim left behind, and exactly the expected Tool_Log tools.
 */
async function refused(
  w: SendWorld,
  draftId: string,
  expectedTools: readonly string[],
  over: {
    today?: CalendarDate;
    channel?: "twilio_sandbox" | "wa_me";
    env?: Readonly<Record<string, string | undefined>>;
    supplierId?: string;
  } = {},
): Promise<Attempt> {
  const h = buildSendHarness(w.db, {
    routes: providerRoutes(draftId),
    ...(over.env === undefined ? {} : { env: over.env }),
  });
  const before = await written(w);
  const claimBefore = await claimHeld(w, draftId);
  const rowsBefore = await toolRowsInOrder(w.t);
  const outcome = await sendDraft(h.deps, {
    supplierId: over.supplierId ?? w.supplierId,
    draftId,
    today: over.today ?? DEMO_TODAY,
    channel: over.channel ?? "twilio_sandbox",
  });
  expect(h.http.requests).toEqual([]);
  expect(await written(w)).toEqual(before);
  // A refusal takes no claim and releases none (a sent Draft keeps the claim it was sent under).
  expect(await claimHeld(w, draftId)).toEqual(claimBefore);
  const toolRows = await toolRowsSince(w.t, rowsBefore);
  expect(toolRows.map((r) => r.tool)).toEqual(expectedTools);
  return { outcome, toolRows };
}

/** A body (no marker) whose Outbound_Text is exactly `target` characters long. */
function bodyForLength(target: number): string {
  const lengthWith = (body: string): number => {
    const built = buildOutboundText({
      body,
      ruleIds: [...RULE_IDS],
      url: MOCK_PAY_LINK_URL,
      amountPaise: SHARMA_AMOUNT_PAISE,
    });
    return built.ok ? built.text.length : -1;
  };
  const overhead = lengthWith("x") - 1;
  const body = "x".repeat(target - overhead);
  expect(lengthWith(body)).toEqual(target);
  return body;
}

async function setBody(w: SendWorld, draftId: string, body: string): Promise<void> {
  await w.t.pglite.query("update drafts set body_text = $1 where id = $2", [body, draftId]);
}

describe("sendDraft refusals at Today 2026-11-12", () => {
  it("refuses with the Engine Decision when a promise was recorded after approval (Req 2.5)", async () => {
    const w = await world();
    const draftId = await draftAndApproveSharma(w);
    await w.t.pglite.query(
      "insert into promises (invoice_id, promised_date, amount_paise, recorded_on) values ($1, '2026-11-20', $2, '2026-11-12')",
      [w.invoiceId, SHARMA_AMOUNT_PAISE],
    );

    const { outcome, toolRows } = await refused(w, draftId, ["next_escalation_step"]);

    const decision: EscalationDecision = {
      action: "wait",
      applicable: true,
      reason: "promise_active",
      ruleIds: [],
    };
    expect(outcome).toEqual<SendOutcome>({ kind: "send_check_failed", decision });
    expect(toolRows[0]?.invoiceId).toEqual(w.invoiceId);
    expect(toolRows[0]?.output).toEqual(decision);
    expect((toolRows[0]?.input as { today: string }).today).toEqual(DEMO_TODAY);
  });

  it("answers not_found alike for another supplier's Draft, a non-uuid id and an unknown uuid (Req 2.2)", async () => {
    const w = await world();
    const draftId = await draftAndApproveSharma(w);
    const [other] = await w.db
      .insert(suppliers)
      .values({
        name: "Other Supplier (Test)",
        udyamNumber: "UDYAM-MH-00-0000001",
        supplierCategory: "micro",
        supplierActivity: "manufacturing",
      })
      .returning({ id: suppliers.id });
    if (other === undefined) throw new Error("second supplier not inserted");

    expect((await refused(w, draftId, [], { supplierId: other.id })).outcome).toEqual<SendOutcome>({ kind: "not_found" });
    expect((await refused(w, "not-a-uuid", [])).outcome).toEqual<SendOutcome>({ kind: "not_found" });
    expect((await refused(w, UNKNOWN_UUID, [])).outcome).toEqual<SendOutcome>({ kind: "not_found" });
    // Both channels give the same answer.
    expect((await refused(w, draftId, [], { supplierId: other.id, channel: "wa_me" })).outcome).toEqual<SendOutcome>({
      kind: "not_found",
    });
  });

  it("refuses a pending Draft and a voice_call Draft as cannot_send (Req 2.3)", async () => {
    const pending = await world();
    const pendingId = await draftAndApproveSharma(pending);
    await pending.t.pglite.query("update drafts set status = 'pending' where id = $1", [pendingId]);
    for (const channel of ["twilio_sandbox", "wa_me"] as const) {
      expect((await refused(pending, pendingId, [], { channel })).outcome).toEqual<SendOutcome>({ kind: "cannot_send" });
    }

    const voice = await world();
    const voiceId = await draftAndApproveSharma(voice);
    await voice.t.pglite.query("update drafts set step = 'voice_call' where id = $1", [voiceId]);
    for (const channel of ["twilio_sandbox", "wa_me"] as const) {
      expect((await refused(voice, voiceId, [], { channel })).outcome).toEqual<SendOutcome>({ kind: "cannot_send" });
    }
  });

  it("refuses a Draft that was already sent as cannot_send, with no second send (Req 2.3)", async () => {
    const w = await world();
    const draftId = await draftAndApproveSharma(w);
    const first = buildSendHarness(w.db, { routes: providerRoutes(draftId) });
    expect(
      await sendDraft(first.deps, { supplierId: w.supplierId, draftId, today: DEMO_TODAY, channel: "twilio_sandbox" }),
    ).toEqual<SendOutcome>({ kind: "sent" });
    expect(await written(w)).toEqual({ messages: 1, paymentLinks: 1, escalationEvents: 3 });

    for (const channel of ["twilio_sandbox", "wa_me"] as const) {
      expect((await refused(w, draftId, [], { channel })).outcome).toEqual<SendOutcome>({ kind: "cannot_send" });
    }
  });

  it("refuses a body with two Pay_Link markers as cannot_send, with no Pay_Link made (Req 3.7)", async () => {
    const w = await world();
    const draftId = await draftAndApproveSharma(w);
    await setBody(w, draftId, `Pay here ${PAY_LINK_TEXT} or here ${PAY_LINK_TEXT}`);

    for (const channel of ["twilio_sandbox", "wa_me"] as const) {
      const { outcome } = await refused(w, draftId, ["next_escalation_step"], { channel });
      expect(outcome).toEqual<SendOutcome>({ kind: "cannot_send" });
    }
  });

  it("refuses the same Draft on another day as approved_on, with no Send_Check row (Req 2.6)", async () => {
    const w = await world();
    const draftId = await draftAndApproveSharma(w);

    const { outcome } = await refused(w, draftId, [], { today: "2026-11-13" });

    expect(outcome).toEqual<SendOutcome>({ kind: "approved_on", approvalDay: "2026-11-12" });
  });

  it("refuses a non-test Razorpay key id as payments_not_configured on both channels (Req 3.4)", async () => {
    const w = await world();
    const draftId = await draftAndApproveSharma(w);
    const env = { ...CHANNEL_ENV_VALUES, RAZORPAY_KEY_ID: "rzp_live_SENTINELKEYID" };

    for (const channel of ["twilio_sandbox", "wa_me"] as const) {
      const { outcome } = await refused(w, draftId, ["next_escalation_step"], { env, channel });
      expect(outcome).toEqual<SendOutcome>({ kind: "payments_not_configured" });
    }
  });

  it("refuses the Twilio channel with no Buyer_Number, then with the sender unset", async () => {
    const w = await world();
    const draftId = await draftAndApproveSharma(w);
    const noSender = { ...CHANNEL_ENV_VALUES, TWILIO_ACCOUNT_SID: "" };

    await w.t.pglite.query("update buyers set whatsapp_number = null where id = $1", [w.buyerId]);
    // No number and no sender: the missing number is reported first.
    expect((await refused(w, draftId, ["next_escalation_step"], { env: noSender })).outcome).toEqual<SendOutcome>({
      kind: "no_buyer_number",
    });
    expect((await refused(w, draftId, ["next_escalation_step"])).outcome).toEqual<SendOutcome>({
      kind: "no_buyer_number",
    });

    await w.t.pglite.query("update buyers set whatsapp_number = $1 where id = $2", [BUYER_NUMBER, w.buyerId]);
    expect((await refused(w, draftId, ["next_escalation_step"], { env: noSender })).outcome).toEqual<SendOutcome>({
      kind: "sender_not_configured",
    });
  });
});

describe("sendDraft and the 1,600 character limit (Req 3.8)", () => {
  it("refuses 1,601 characters for Twilio, keeps the Pay_Link, then sends the same Draft through wa.me", async () => {
    const w = await world();
    const draftId = await draftAndApproveSharma(w);
    await setBody(w, draftId, bodyForLength(LIMIT + 1));

    const first = buildSendHarness(w.db, { routes: providerRoutes(draftId) });
    const outcome = await sendDraft(first.deps, {
      supplierId: w.supplierId,
      draftId,
      today: DEMO_TODAY,
      channel: "twilio_sandbox",
    });
    expect(outcome).toEqual<SendOutcome>({ kind: "too_long" });
    expect(first.http.calls("POST", TWILIO_CREATE_URL)).toHaveLength(0);
    expect(first.http.requests.map((r) => `${r.method} ${r.url.split("?")[0]}`)).toEqual([
      `GET ${RAZORPAY_LINKS_URL}`,
      `POST ${RAZORPAY_LINKS_URL}`,
    ]);
    // The Pay_Link is kept, nothing was sent, the claim is released.
    expect(await written(w)).toEqual({ messages: 0, paymentLinks: 1, escalationEvents: 2 });
    expect(await claimHeld(w, draftId)).toEqual(false);

    // The same Draft goes out through wa.me, reusing the stored Pay_Link (no provider request).
    const second = buildSendHarness(w.db, { routes: [] });
    const handed = await sendDraft(second.deps, {
      supplierId: w.supplierId,
      draftId,
      today: DEMO_TODAY,
      channel: "wa_me",
    });
    expect(second.http.requests).toEqual([]);
    if (handed.kind !== "handed_off") throw new Error(`expected handed_off, got ${JSON.stringify(handed)}`);
    const text = decodeURIComponent(handed.url.split("?text=")[1] ?? "");
    expect(text.length).toEqual(LIMIT + 1);
    expect(handed.url).toEqual(waMeUrl(parseE164(BUYER_NUMBER), text));
    expect(await written(w)).toEqual({ messages: 1, paymentLinks: 1, escalationEvents: 3 });
  });

  it("sends exactly 1,600 characters with one Twilio create call", async () => {
    const w = await world();
    const draftId = await draftAndApproveSharma(w);
    await setBody(w, draftId, bodyForLength(LIMIT));

    const h = buildSendHarness(w.db, { routes: providerRoutes(draftId) });
    const outcome = await sendDraft(h.deps, {
      supplierId: w.supplierId,
      draftId,
      today: DEMO_TODAY,
      channel: "twilio_sandbox",
    });

    expect(outcome).toEqual<SendOutcome>({ kind: "sent" });
    const creates = h.http.calls("POST", TWILIO_CREATE_URL);
    expect(creates).toHaveLength(1);
    expect((creates[0]?.body as { Body: string }).Body.length).toEqual(LIMIT);
    expect(await written(w)).toEqual({ messages: 1, paymentLinks: 1, escalationEvents: 3 });
  });
});
