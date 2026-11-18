// sendDraft on the Demo_Seed at Today 2026-11-12 (PGlite, mock model, fakeHttp, fakeClock, no network):
// the approved Sharma Traders `whatsapp_nudge` Draft goes out through the Twilio sandbox with a Razorpay
// test link. Exact values for the Decision, the Razorpay body, the Outbound_Text, the Twilio request,
// the Message_Row, the `sent` event and the four Tool_Log rows.
// Requirements: 3.1, 3.3, 3.6, 5.1, 5.6, 9.2
import { escalationEvents, messages, paymentLinks } from "@dues-banshee/db";
import type { TestDb } from "@dues-banshee/db/testing";
import { formatINR } from "@dues-banshee/engine";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sendDraft } from "../src/channel/send-draft";
import type { SendOutcome } from "../src/channel/send-draft";
import {
  BUYER_NUMBER,
  CHANNEL_ENV_VALUES,
  DEMO_TODAY,
  MOCK_PAY_LINK_ID,
  MOCK_PAY_LINK_URL,
  RAZORPAY_LINKS_URL,
  SHARMA_AMOUNT_PAISE,
  SHARMA_INVOICE_NUMBER,
  TWILIO_BASE,
  TWILIO_CREATE_URL,
  TWILIO_MESSAGE_SID,
  TWILIO_POLL_URL,
  buildSendHarness,
  cloneSendWorld,
  createSendTemplate,
  draftAndApproveSharma,
  providerRoutes,
  serialise,
  toolRowsInOrder,
  toolRowsSince,
} from "./helpers/send-fixtures";
import type { SendWorld } from "./helpers/send-fixtures";

const MASKED_NUMBER = "*********0001";
const BASIC_TWILIO = `Basic ${Buffer.from(
  `${CHANNEL_ENV_VALUES.TWILIO_ACCOUNT_SID}:${CHANNEL_ENV_VALUES.TWILIO_AUTH_TOKEN}`,
).toString("base64")}`;
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

async function world(): Promise<SendWorld> {
  const w = await cloneSendWorld(template);
  open.push(w.t);
  return w;
}

/** The body the mock Model_Output yields for Sharma Traders at 2026-11-12 (Engine figures via formatINR). */
function expectedBody(): string {
  return (
    `Namaste Sharma Traders ji, invoice ${SHARMA_INVOICE_NUMBER} ka ${formatINR(41200000, "full")} 17 Oct 2026 ko due tha. ` +
    `Tab se ${formatINR(512794, "full")} byaaj jud chuka hai (7 Oct 2026 ki bank rate par).`
  );
}

function expectedOutboundText(): string {
  const payLine = `Pay ${formatINR(41200000, "full")} here: ${MOCK_PAY_LINK_URL}`;
  const basis = "Basis: MSMED-15 (MSMED Act 2006, s.15); MSMED-16 (MSMED Act 2006, s.16)";
  const disclaimer = "Reminders a supplier sends to its own buyers. Not legal advice.";
  return `${expectedBody()}\n\n${payLine}\n\n${basis}\n${disclaimer}`;
}

describe("sendDraft: Sharma Traders whatsapp_nudge through the Twilio sandbox at 2026-11-12", () => {
  it("sends the approved Draft with the Razorpay link and records every row exactly", async () => {
    const w = await world();
    const draftId = await draftAndApproveSharma(w);
    const h = buildSendHarness(w.db, { routes: providerRoutes(draftId) });
    const rowsBefore = await toolRowsInOrder(w.t);

    const outcome = await sendDraft(h.deps, {
      supplierId: w.supplierId,
      draftId,
      today: DEMO_TODAY,
      channel: "twilio_sandbox",
    });
    expect(outcome).toEqual<SendOutcome>({ kind: "sent" });

    const text = expectedOutboundText();
    // The tail the buyer reads: pay line, blank line, Basis_Line, Disclaimer last.
    expect(text.split("\n").slice(-4)).toEqual([
      `Pay ${formatINR(41200000, "full")} here: ${MOCK_PAY_LINK_URL}`,
      "",
      "Basis: MSMED-15 (MSMED Act 2006, s.15); MSMED-16 (MSMED Act 2006, s.16)",
      "Reminders a supplier sends to its own buyers. Not legal advice.",
    ]);

    // Requests: lookup, create, Twilio create, three status polls (Req 3.1, 9.2).
    expect(h.http.unmatched).toEqual([]);
    expect(h.http.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${RAZORPAY_LINKS_URL}?reference_id=${draftId}`,
      `POST ${RAZORPAY_LINKS_URL}`,
      `POST ${TWILIO_CREATE_URL}`,
      `GET ${TWILIO_POLL_URL}`,
      `GET ${TWILIO_POLL_URL}`,
      `GET ${TWILIO_POLL_URL}`,
    ]);
    expect(h.clock.sleeps).toEqual([2000, 2000]);

    const razorpayCreate = h.http.calls("POST", RAZORPAY_LINKS_URL)[0];
    expect(razorpayCreate?.body).toEqual({
      amount: 41200000,
      currency: "INR",
      accept_partial: false,
      reference_id: draftId,
      notes: { invoice_id: w.invoiceId },
      notify: { sms: false, email: false },
    });
    expect(SHARMA_AMOUNT_PAISE).toEqual(41200000);

    const twilioCreate = h.http.calls("POST", TWILIO_CREATE_URL);
    expect(twilioCreate).toHaveLength(1);
    expect(twilioCreate[0]?.headers["authorization"]).toEqual(BASIC_TWILIO);
    expect(twilioCreate[0]?.body).toEqual({
      From: "whatsapp:+14155550100",
      To: `whatsapp:${BUYER_NUMBER}`,
      Body: text,
    });
    expect(h.http.calls("GET", `${TWILIO_BASE}/Messages/`)).toHaveLength(3);

    // The stored Pay_Link (Req 3.3).
    const links = await w.db.select().from(paymentLinks);
    expect(links.map((row) => ({ ...row, id: "<id>", createdAt: "<time>" }))).toEqual([
      {
        id: "<id>",
        createdAt: "<time>",
        invoiceId: w.invoiceId,
        providerLinkId: MOCK_PAY_LINK_ID,
        url: MOCK_PAY_LINK_URL,
        amountPaise: 41200000,
        status: "created",
        draftId,
        createdOn: DEMO_TODAY,
      },
    ]);

    // The Message_Row (Req 5.1).
    const messageRows = await w.db.select().from(messages);
    expect(messageRows).toHaveLength(1);
    const message = messageRows[0];
    if (message === undefined) throw new Error("no message row");
    expect({ ...message, id: "<id>", createdAt: "<time>" }).toEqual({
      id: "<id>",
      invoiceId: w.invoiceId,
      channel: "twilio_sandbox",
      direction: "outbound",
      body: text,
      status: "sent",
      draftId,
      providerMessageId: TWILIO_MESSAGE_SID,
      errorCode: null,
      createdAt: "<time>",
    });

    // The `sent` Escalation_Event (Req 5.1).
    const sentEvents = (await w.db.select().from(escalationEvents)).filter((e) => e.action === "sent");
    expect(sentEvents.map((row) => ({ ...row, id: "<id>", createdAt: "<time>" }))).toEqual([
      {
        id: "<id>",
        createdAt: "<time>",
        invoiceId: w.invoiceId,
        step: "whatsapp_nudge",
        occurredOn: DEMO_TODAY,
        action: "sent",
        draftId,
        detail: { channel: "twilio_sandbox", messageRowId: message.id },
      },
    ]);

    // The four Tool_Log rows, in order (Req 5.6).
    const rows = await toolRowsSince(w.t, rowsBefore);
    expect(rows.map((r) => r.tool)).toEqual([
      "next_escalation_step",
      "find_payment_link",
      "create_payment_link",
      "send_whatsapp",
    ]);
    expect(rows.map((r) => r.invoiceId)).toEqual([w.invoiceId, w.invoiceId, w.invoiceId, w.invoiceId]);
    const [check, find, create, send] = rows;

    // The Send_Check sees the invoice without the Draft's own approved event.
    expect(check?.output).toEqual({
      action: "advance",
      applicable: true,
      step: "whatsapp_nudge",
      rank: 1,
      requiresApproval: false,
      ruleIds: ["MSMED-15"],
    });
    expect((check?.input as { today: string; history: unknown[] }).today).toEqual(DEMO_TODAY);
    expect((check?.input as { history: unknown[] }).history).toEqual([]);

    expect(find?.input).toEqual({ invoiceId: w.invoiceId, draftId, referenceId: draftId });
    expect(find?.output).toEqual({ ok: true, found: false });

    expect(create?.input).toEqual({
      invoiceId: w.invoiceId,
      draftId,
      body: razorpayCreate?.body,
    });
    expect(create?.output).toEqual({ ok: true, providerLinkId: MOCK_PAY_LINK_ID, url: MOCK_PAY_LINK_URL });

    expect(send?.input).toEqual({
      invoiceId: w.invoiceId,
      draftId,
      channel: "twilio_sandbox",
      text,
      to: MASKED_NUMBER,
    });
    expect(send?.output).toEqual({
      kind: "sent",
      providerMessageId: TWILIO_MESSAGE_SID,
      polls: [QUEUED_RECORD, QUEUED_RECORD, QUEUED_RECORD],
    });

    // No full number and no Channel_Env value in any of the four rows.
    const logged = serialise(rows);
    expect(logged).not.toContain(BUYER_NUMBER);
    expect(logged).not.toContain(BUYER_NUMBER.slice(1));
    for (const value of Object.values(CHANNEL_ENV_VALUES)) expect(logged).not.toContain(value);
  });
});
