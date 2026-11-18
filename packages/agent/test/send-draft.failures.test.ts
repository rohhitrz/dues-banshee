// sendDraft failure paths (PGlite, mock model, fakeHttp, fakeClock, no network): Twilio 63015 on the
// create call and on a status poll, a non-sandbox failure on poll 3, polls that end in `sent`, and a
// forced `recordSent` failure after a Twilio `sent` and after a wa.me handoff.
// Requirements: 1.3, 1.7, 3.2, 5.3, 5.6, 5.7, 9.11
import { drafts, escalationEvents, messages, paymentLinks } from "@dues-banshee/db";
import type { TestDb } from "@dues-banshee/db/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sendDraft } from "../src/channel/send-draft";
import type { SendDeps, SendOutcome } from "../src/channel/send-draft";
import type { FakeResponse } from "../src/testing/fake-http";
import {
  BUYER_NUMBER,
  CHANNEL_ENV_VALUES,
  DEMO_TODAY,
  MOCK_PAY_LINK_URL,
  QUEUED_POLL,
  RAZORPAY_LINKS_URL,
  TWILIO_BASE,
  TWILIO_CREATE_URL,
  TWILIO_MESSAGE_SID,
  buildSendHarness,
  cloneSendWorld,
  createSendTemplate,
  draftAndApproveSharma,
  providerRoutes,
  serialise,
  toolRowsInOrder,
  toolRowsSince,
} from "./helpers/send-fixtures";
import type { ProviderResponses, SendWorld } from "./helpers/send-fixtures";

const MASKED_NUMBER = "*********0001";
const QUEUED_RECORD = { status: "queued", errorCode: "" };

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

async function world(): Promise<SendWorld & { draftId: string }> {
  const w = await cloneSendWorld(template);
  open.push(w.t);
  const draftId = await draftAndApproveSharma(w);
  return { ...w, draftId };
}

function poll(status: string, errorCode: number | null): FakeResponse {
  return { json: { status, error_code: errorCode } };
}

/** One `sendDraft` call over fresh fakes. */
async function attempt(
  w: SendWorld & { draftId: string },
  channel: "twilio_sandbox" | "wa_me",
  responses: ProviderResponses = {},
  recordSent?: SendDeps["recordSent"],
) {
  const h = buildSendHarness(w.db, {
    routes: providerRoutes(w.draftId, responses),
    ...(recordSent === undefined ? {} : { recordSent }),
  });
  const before = await toolRowsInOrder(w.t);
  const outcome = await sendDraft(h.deps, {
    supplierId: w.supplierId,
    draftId: w.draftId,
    today: DEMO_TODAY,
    channel,
  });
  const rows = await toolRowsSince(w.t, before);
  return { h, outcome, rows };
}

async function claimOf(w: SendWorld & { draftId: string }): Promise<Date | null> {
  const row = (await w.db.select({ id: drafts.id, at: drafts.sendClaimedAt }).from(drafts)).find((d) => d.id === w.draftId);
  if (row === undefined) throw new Error("draft missing");
  return row.at;
}

async function sentEvents(w: SendWorld) {
  return (await w.db.select().from(escalationEvents)).filter((e) => e.action === "sent");
}

/** Exactly one `send_whatsapp` row, and no number or Channel_Env value anywhere in the new rows. */
function expectOneSendRow(rows: Awaited<ReturnType<typeof toolRowsSince>>) {
  const sendRows = rows.filter((r) => r.tool === "send_whatsapp");
  expect(sendRows).toHaveLength(1);
  const row = sendRows[0];
  if (row === undefined) throw new Error("no send_whatsapp row");
  expect((row.input as { to: string }).to).toEqual(MASKED_NUMBER);
  const logged = serialise(rows);
  expect(logged).not.toContain(BUYER_NUMBER);
  expect(logged).not.toContain(BUYER_NUMBER.slice(1));
  for (const value of Object.values(CHANNEL_ENV_VALUES)) expect(logged).not.toContain(value);
  return row;
}

describe("sendDraft: Twilio 63015 on the create call", () => {
  it("records one failed Message_Row, no event, releases the claim and retries with the stored Pay_Link", async () => {
    const w = await world();
    const first = await attempt(w, "twilio_sandbox", {
      twilioCreate: [{ status: 400, json: { code: 63015, message: "not joined" } }],
    });
    expect(first.outcome).toEqual<SendOutcome>({ kind: "channel_failed", errorKind: "sandbox_window", errorCode: "63015" });
    expect(first.h.http.unmatched).toEqual([]);
    expect(first.h.http.calls("POST", RAZORPAY_LINKS_URL)).toHaveLength(1);
    expect(first.h.http.calls("GET", `${TWILIO_BASE}/Messages/`)).toHaveLength(0);

    const rows = await w.db.select().from(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: "twilio_sandbox",
      direction: "outbound",
      status: "failed",
      draftId: w.draftId,
      providerMessageId: null,
      errorCode: "63015",
    });
    expect(await sentEvents(w)).toEqual([]);
    expect(await claimOf(w)).toBeNull();

    const sendRow = expectOneSendRow(first.rows);
    expect(sendRow.output).toEqual({
      kind: "failed",
      errorKind: "sandbox_window",
      errorCode: "63015",
      providerMessageId: null,
      polls: [],
    });
    expect(await w.db.select().from(paymentLinks)).toHaveLength(1);

    // The Draft is still sendable: the retry reuses the Pay_Link with zero Razorpay calls.
    const retry = await attempt(w, "twilio_sandbox");
    expect(retry.outcome).toEqual<SendOutcome>({ kind: "sent" });
    expect(retry.h.http.calls("POST", RAZORPAY_LINKS_URL)).toHaveLength(0);
    expect(retry.h.http.calls("GET", RAZORPAY_LINKS_URL)).toHaveLength(0);
    expect(retry.rows.map((r) => r.tool)).toEqual(["next_escalation_step", "send_whatsapp"]);
    const retryText = (retry.rows[1]?.input as { text: string }).text;
    expect(retryText).toContain(MOCK_PAY_LINK_URL);
    expect(await sentEvents(w)).toHaveLength(1);
    const after = await w.db.select().from(messages);
    expect(after.map((m) => m.status).sort()).toEqual(["failed", "sent"]);
  });
});

describe("sendDraft: Twilio status polls", () => {
  it("63015 on poll 1 → channel_failed/sandbox_window with the SID kept", async () => {
    const w = await world();
    const { h, outcome, rows } = await attempt(w, "twilio_sandbox", { twilioPolls: [poll("failed", 63015)] });
    expect(outcome).toEqual<SendOutcome>({ kind: "channel_failed", errorKind: "sandbox_window", errorCode: "63015" });
    expect(h.http.calls("POST", RAZORPAY_LINKS_URL)).toHaveLength(1);
    expect(h.http.calls("POST", TWILIO_CREATE_URL)).toHaveLength(1);
    expect(h.http.calls("GET", `${TWILIO_BASE}/Messages/`)).toHaveLength(1);
    expect(h.clock.sleeps).toEqual([]);

    const stored = await w.db.select().from(messages);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      status: "failed",
      errorCode: "63015",
      providerMessageId: TWILIO_MESSAGE_SID,
      draftId: w.draftId,
    });
    expect(await sentEvents(w)).toEqual([]);
    expect(await claimOf(w)).toBeNull();
    expect(expectOneSendRow(rows).output).toEqual({
      kind: "failed",
      errorKind: "sandbox_window",
      errorCode: "63015",
      providerMessageId: TWILIO_MESSAGE_SID,
      polls: [{ status: "failed", errorCode: "63015" }],
    });
  });

  it("a non-sandbox code on poll 3 → channel_failed/provider_error, failed row, no event", async () => {
    const w = await world();
    const { h, outcome, rows } = await attempt(w, "twilio_sandbox", {
      twilioPolls: [QUEUED_POLL, QUEUED_POLL, poll("undelivered", 30008)],
    });
    expect(outcome).toEqual<SendOutcome>({ kind: "channel_failed", errorKind: "provider_error", errorCode: "30008" });
    expect(h.http.calls("GET", `${TWILIO_BASE}/Messages/`)).toHaveLength(3);
    expect(h.clock.sleeps).toEqual([2000, 2000]);

    const stored = await w.db.select().from(messages);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      status: "failed",
      errorCode: "30008",
      providerMessageId: TWILIO_MESSAGE_SID,
    });
    expect(await sentEvents(w)).toEqual([]);
    expect(await claimOf(w)).toBeNull();
    expect(expectOneSendRow(rows).output).toEqual({
      kind: "failed",
      errorKind: "provider_error",
      errorCode: "30008",
      providerMessageId: TWILIO_MESSAGE_SID,
      polls: [QUEUED_RECORD, QUEUED_RECORD, { status: "undelivered", errorCode: "30008" }],
    });
  });

  it("three queued polls → sent after 3 GETs", async () => {
    const w = await world();
    const { h, outcome, rows } = await attempt(w, "twilio_sandbox");
    expect(outcome).toEqual<SendOutcome>({ kind: "sent" });
    expect(h.http.calls("GET", `${TWILIO_BASE}/Messages/`)).toHaveLength(3);
    expect(h.clock.sleeps).toEqual([2000, 2000]);
    expect(expectOneSendRow(rows).output).toEqual({
      kind: "sent",
      providerMessageId: TWILIO_MESSAGE_SID,
      polls: [QUEUED_RECORD, QUEUED_RECORD, QUEUED_RECORD],
    });
    expect((await w.db.select().from(messages)).map((m) => m.status)).toEqual(["sent"]);
    expect(await sentEvents(w)).toHaveLength(1);
  });

  it("a poll network error → sent, polling ends after 1 GET", async () => {
    const w = await world();
    const { h, outcome, rows } = await attempt(w, "twilio_sandbox", { twilioPolls: [{ throws: "network" }] });
    expect(outcome).toEqual<SendOutcome>({ kind: "sent" });
    expect(h.http.calls("GET", `${TWILIO_BASE}/Messages/`)).toHaveLength(1);
    expect(expectOneSendRow(rows).output).toEqual({
      kind: "sent",
      providerMessageId: TWILIO_MESSAGE_SID,
      polls: [{ error: "network", httpStatus: null }],
    });
    expect((await w.db.select().from(messages)).map((m) => m.status)).toEqual(["sent"]);
    expect(await sentEvents(w)).toHaveLength(1);
  });
});

describe("sendDraft: recordSent forced to fail", () => {
  const failingRecord: SendDeps["recordSent"] = () => Promise.reject(new Error("forced recordSent failure"));

  it("after a Twilio `sent` → record_failed, nothing persisted, SID kept in the log, claim kept", async () => {
    const w = await world();
    const { outcome, rows } = await attempt(w, "twilio_sandbox", {}, failingRecord);
    expect(outcome).toEqual<SendOutcome>({ kind: "record_failed" });
    expect(await w.db.select().from(messages)).toEqual([]);
    expect(await sentEvents(w)).toEqual([]);
    expect(await claimOf(w)).not.toBeNull();
    expect(expectOneSendRow(rows).output).toEqual({
      kind: "sent",
      providerMessageId: TWILIO_MESSAGE_SID,
      polls: [QUEUED_RECORD, QUEUED_RECORD, QUEUED_RECORD],
    });

    // The kept claim blocks a second send, so the buyer is not messaged twice.
    const again = await attempt(w, "twilio_sandbox");
    expect(again.outcome).toEqual<SendOutcome>({ kind: "cannot_send" });
    expect(again.h.http.requests).toEqual([]);
  });

  it("after a wa_me handoff → record_failed, nothing persisted, claim released", async () => {
    const w = await world();
    const { h, outcome, rows } = await attempt(w, "wa_me", {}, failingRecord);
    expect(outcome).toEqual<SendOutcome>({ kind: "record_failed" });
    expect(h.http.calls("POST", TWILIO_CREATE_URL)).toHaveLength(0);
    expect(await w.db.select().from(messages)).toEqual([]);
    expect(await sentEvents(w)).toEqual([]);
    expect(await claimOf(w)).toBeNull();
    expect(expectOneSendRow(rows).output).toEqual({ kind: "handoff" });
    expect(serialise(rows)).not.toContain("wa.me");
    // The Draft is still sendable.
    const retry = await attempt(w, "wa_me");
    expect(retry.outcome.kind).toEqual("handed_off");
  });
});
