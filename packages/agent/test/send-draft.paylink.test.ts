// sendDraft for a `whatsapp_paylink` Draft whose body carries the Pay_Link_Marker, at Today 2026-11-12
// (PGlite, mock model, fakeHttp, fakeClock, no network). The invoice already has an approved
// `whatsapp_nudge` step event on 2026-11-05 (7 days before Today), so the Send_Check lets the paylink
// step through. Covers the marker replacement, the Razorpay lookup-before-create order, the
// "already attempted" recovery, every pay-link failure, and a stored Pay_Link.
// Requirements: 3.2, 3.5, 3.6, 3.9, 3.10, 5.6, 9.13, 9.14
import { drafts, escalationEvents, messages, paymentLinks, insertPayLink } from "@dues-banshee/db";
import type { TestDb } from "@dues-banshee/db/testing";
import { formatINR } from "@dues-banshee/engine";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sendDraft } from "../src/channel/send-draft";
import type { SendOutcome } from "../src/channel/send-draft";
import type { ModelOutput } from "../src/core/model-output";
import type { FakeResponse } from "../src/testing/fake-http";
import {
  DEMO_TODAY,
  MOCK_PAY_LINK_ID,
  MOCK_PAY_LINK_URL,
  RAZORPAY_LINKS_URL,
  SHARMA_AMOUNT_PAISE,
  SHARMA_INVOICE_NUMBER,
  TWILIO_CREATE_URL,
  TWILIO_MESSAGE_SID,
  TWILIO_POLL_URL,
  buildSendHarness,
  cloneSendWorld,
  createSendTemplate,
  draftAndApproveSharma,
  providerRoutes,
  razorpayLink,
  toolRowsInOrder,
  toolRowsSince,
} from "./helpers/send-fixtures";
import type { ProviderResponses, SendWorld } from "./helpers/send-fixtures";

const NUDGE_DAY = "2026-11-05";
const FOUND_URL = "https://rzp.io/i/foundByLookup";
const FOUND_ID = "plink_found0000000001";
const DISCLAIMER = "Reminders a supplier sends to its own buyers. Not legal advice.";
const BASIS = "Basis: MSMED-15 (MSMED Act 2006, s.15); MSMED-16 (MSMED Act 2006, s.16)";
const ALREADY_ATTEMPTED: FakeResponse = {
  status: 400,
  json: { error: { code: "BAD_REQUEST_ERROR", description: "Payment link reference id already attempted" } },
};
const SERVER_ERROR: FakeResponse = {
  status: 500,
  json: { error: { code: "SERVER_ERROR", description: "Something went wrong" } },
};

/** The paylink Draft: the second line is the sentence around the Pay_Link_Marker. */
const PAYLINK_OUTPUT: ModelOutput = {
  text:
    "Namaste {{buyer_name}} ji, invoice {{invoice_number}} ka {{principal}} abhi baaki hai.\n" +
    "Kripya {{pay_link}} se bhugtan kar dein.",
  ruleIds: ["MSMED-15", "MSMED-16"],
};

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

/** Sharma Traders with an approved nudge on 2026-11-05 and an approved paylink Draft on Today. */
async function paylinkWorld(): Promise<SendWorld & { draftId: string; nudgeDraftId: string }> {
  const w = await cloneSendWorld(template);
  open.push(w.t);
  const nudgeDraftId = await draftAndApproveSharma(w, { step: "whatsapp_nudge", today: NUDGE_DAY });
  const draftId = await draftAndApproveSharma(w, {
    step: "whatsapp_paylink",
    output: PAYLINK_OUTPUT,
    today: DEMO_TODAY,
  });
  return { ...w, draftId, nudgeDraftId };
}

/** The Outbound_Text for the paylink Draft with `url` in place of the marker (Engine figures via formatINR). */
function expectedText(url: string): string {
  const body =
    `Namaste Sharma Traders ji, invoice ${SHARMA_INVOICE_NUMBER} ka ${formatINR(41200000, "full")} abhi baaki hai.\n` +
    `Kripya ${url} se bhugtan kar dein.`;
  return `${body}\n\n${BASIS}\n${DISCLAIMER}`;
}

const foundLookup = (draftId: string): FakeResponse => ({
  json: { count: 1, payment_links: [{ ...razorpayLink(draftId), id: FOUND_ID, short_url: FOUND_URL }] },
});
const EMPTY_LOOKUP: FakeResponse = { json: { count: 0, payment_links: [] } };

async function run(
  w: SendWorld & { draftId: string },
  responses: ProviderResponses = {},
): Promise<{ outcome: SendOutcome; h: ReturnType<typeof buildSendHarness> }> {
  const h = buildSendHarness(w.db, { routes: providerRoutes(w.draftId, responses) });
  const outcome = await sendDraft(h.deps, {
    supplierId: w.supplierId,
    draftId: w.draftId,
    today: DEMO_TODAY,
    channel: "twilio_sandbox",
  });
  return { outcome, h };
}

const razorpayCreates = (h: ReturnType<typeof buildSendHarness>) => h.http.calls("POST", RAZORPAY_LINKS_URL);
const razorpayLookups = (h: ReturnType<typeof buildSendHarness>) => h.http.calls("GET", `${RAZORPAY_LINKS_URL}?reference_id=`);
const twilioCreates = (h: ReturnType<typeof buildSendHarness>) => h.http.calls("POST", TWILIO_CREATE_URL);

describe("sendDraft: whatsapp_paylink Draft with the Pay_Link_Marker at 2026-11-12", () => {
  it("replaces only the marker with the link URL and appends no Pay_Link_Line", async () => {
    const w = await paylinkWorld();
    const paylinkDraft = (await w.db.select().from(drafts)).find((d) => d.id === w.draftId);
    expect(paylinkDraft?.step).toEqual("whatsapp_paylink");
    expect(paylinkDraft?.bodyText).toContain("Kripya [payment link added on send] se bhugtan kar dein.");

    const rowsBefore = await toolRowsInOrder(w.t);
    const { outcome, h } = await run(w);
    expect(outcome).toEqual<SendOutcome>({ kind: "sent" });

    const text = expectedText(MOCK_PAY_LINK_URL);
    const body = twilioCreates(h)[0]?.body as { Body: string };
    expect(body.Body).toEqual(text);
    expect(body.Body.split("\n")).toContain(`Kripya ${MOCK_PAY_LINK_URL} se bhugtan kar dein.`);
    expect(body.Body).not.toContain("here:");
    expect(body.Body).not.toContain("[payment link added on send]");
    expect(body.Body.split("\n").at(-1)).toEqual(DISCLAIMER);
    expect(body.Body.split(MOCK_PAY_LINK_URL)).toHaveLength(2);

    const messageRows = await w.db.select().from(messages);
    expect(messageRows.map((m) => ({ draftId: m.draftId, body: m.body, status: m.status, sid: m.providerMessageId }))).toEqual([
      { draftId: w.draftId, body: text, status: "sent", sid: TWILIO_MESSAGE_SID },
    ]);
    const sentEvents = (await w.db.select().from(escalationEvents)).filter((e) => e.action === "sent");
    expect(sentEvents.map((e) => ({ step: e.step, draftId: e.draftId, occurredOn: e.occurredOn }))).toEqual([
      { step: "whatsapp_paylink", draftId: w.draftId, occurredOn: DEMO_TODAY },
    ]);

    // The Send_Check ran for the paylink step, then one lookup, one create, one send (Req 5.6).
    const rows = await toolRowsSince(w.t, rowsBefore);
    expect(rows.map((r) => r.tool)).toEqual([
      "next_escalation_step",
      "find_payment_link",
      "create_payment_link",
      "send_whatsapp",
    ]);
    expect(rows[0]?.output).toMatchObject({ action: "advance", step: "whatsapp_paylink", rank: 2 });
  });

  it("uses a link found by the lookup before any create, stores it and sends with its URL", async () => {
    const w = await paylinkWorld();
    const rowsBefore = await toolRowsInOrder(w.t);
    const { outcome, h } = await run(w, { lookup: [foundLookup(w.draftId)], create: [] });
    expect(outcome).toEqual<SendOutcome>({ kind: "sent" });

    expect(razorpayLookups(h)).toHaveLength(1);
    expect(razorpayCreates(h)).toHaveLength(0);
    expect(h.http.unmatched).toEqual([]);

    const links = await w.db.select().from(paymentLinks);
    expect(
      links.map((l) => ({
        invoiceId: l.invoiceId,
        draftId: l.draftId,
        providerLinkId: l.providerLinkId,
        url: l.url,
        amountPaise: l.amountPaise,
        status: l.status,
        createdOn: l.createdOn,
      })),
    ).toEqual([
      {
        invoiceId: w.invoiceId,
        draftId: w.draftId,
        providerLinkId: FOUND_ID,
        url: FOUND_URL,
        amountPaise: SHARMA_AMOUNT_PAISE,
        status: "created",
        createdOn: DEMO_TODAY,
      },
    ]);
    expect((twilioCreates(h)[0]?.body as { Body: string }).Body).toEqual(expectedText(FOUND_URL));
    expect(h.http.calls("GET", TWILIO_POLL_URL)).toHaveLength(3);

    const rows = await toolRowsSince(w.t, rowsBefore);
    expect(rows.map((r) => r.tool)).toEqual(["next_escalation_step", "find_payment_link", "send_whatsapp"]);
    expect(rows[1]?.output).toEqual({ ok: true, found: true, providerLinkId: FOUND_ID, url: FOUND_URL });
  });

  it("looks the link up again after create answers 400 'already attempted', then stores and sends it", async () => {
    const w = await paylinkWorld();
    const rowsBefore = await toolRowsInOrder(w.t);
    const { outcome, h } = await run(w, {
      lookup: [EMPTY_LOOKUP, foundLookup(w.draftId)],
      create: [ALREADY_ATTEMPTED],
    });
    expect(outcome).toEqual<SendOutcome>({ kind: "sent" });

    expect(razorpayLookups(h)).toHaveLength(2);
    expect(razorpayCreates(h)).toHaveLength(1);
    expect(h.http.requests.slice(0, 3).map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${RAZORPAY_LINKS_URL}?reference_id=${w.draftId}`,
      `POST ${RAZORPAY_LINKS_URL}`,
      `GET ${RAZORPAY_LINKS_URL}?reference_id=${w.draftId}`,
    ]);

    const links = await w.db.select().from(paymentLinks);
    expect(links.map((l) => ({ draftId: l.draftId, providerLinkId: l.providerLinkId, url: l.url }))).toEqual([
      { draftId: w.draftId, providerLinkId: FOUND_ID, url: FOUND_URL },
    ]);
    expect((twilioCreates(h)[0]?.body as { Body: string }).Body).toEqual(expectedText(FOUND_URL));

    const rows = await toolRowsSince(w.t, rowsBefore);
    expect(rows.map((r) => r.tool)).toEqual([
      "next_escalation_step",
      "find_payment_link",
      "create_payment_link",
      "find_payment_link",
      "send_whatsapp",
    ]);
    expect(rows[2]?.output).toEqual({ ok: false, errorKind: "already_attempted", httpStatus: 400 });
  });

  it.each<[string, ProviderResponses, { lookups: number; creates: number }]>([
    ["the lookup fails", { lookup: [SERVER_ERROR], create: [] }, { lookups: 1, creates: 0 }],
    ["the create answers 500", { lookup: [EMPTY_LOOKUP], create: [SERVER_ERROR] }, { lookups: 1, creates: 1 }],
    [
      "the create answers 400 'already attempted' and the second lookup is empty",
      { lookup: [EMPTY_LOOKUP, EMPTY_LOOKUP], create: [ALREADY_ATTEMPTED] },
      { lookups: 2, creates: 1 },
    ],
  ])("ends with pay_link_failed and sends nothing when %s", async (_name, responses, counts) => {
    const w = await paylinkWorld();
    const { outcome, h } = await run(w, responses);
    expect(outcome).toEqual<SendOutcome>({ kind: "pay_link_failed" });

    expect(razorpayLookups(h)).toHaveLength(counts.lookups);
    expect(razorpayCreates(h)).toHaveLength(counts.creates);
    expect(twilioCreates(h)).toHaveLength(0);
    expect(h.http.calls("GET", TWILIO_POLL_URL)).toHaveLength(0);
    expect(h.http.unmatched).toEqual([]);

    expect(await w.db.select().from(paymentLinks)).toEqual([]);
    expect(await w.db.select().from(messages)).toEqual([]);
    expect((await w.db.select().from(escalationEvents)).filter((e) => e.action === "sent")).toEqual([]);

    // The claim is released and the Draft is still approved, so the owner can retry.
    const draft = (await w.db.select().from(drafts)).find((d) => d.id === w.draftId);
    expect(draft?.sendClaimedAt).toBeNull();
    expect(draft?.status).toEqual("approved");

    const tools = (await toolRowsInOrder(w.t)).map((r) => r.tool);
    expect(tools.filter((t) => t === "send_whatsapp")).toEqual([]);
  });

  it("reuses a stored Pay_Link with no Razorpay call and no find or create Tool_Log row", async () => {
    const w = await paylinkWorld();
    const stored = await insertPayLink(w.db, {
      invoiceId: w.invoiceId,
      draftId: w.draftId,
      link: { providerLinkId: MOCK_PAY_LINK_ID, url: MOCK_PAY_LINK_URL, amountPaise: SHARMA_AMOUNT_PAISE },
      createdOn: DEMO_TODAY,
    });
    expect(stored).toEqual("ok");

    const rowsBefore = await toolRowsInOrder(w.t);
    const { outcome, h } = await run(w, { lookup: [], create: [] });
    expect(outcome).toEqual<SendOutcome>({ kind: "sent" });

    expect(h.http.calls("GET", RAZORPAY_LINKS_URL)).toHaveLength(0);
    expect(razorpayCreates(h)).toHaveLength(0);
    expect(h.http.unmatched).toEqual([]);
    expect((twilioCreates(h)[0]?.body as { Body: string }).Body).toEqual(expectedText(MOCK_PAY_LINK_URL));
    expect(await w.db.select().from(paymentLinks)).toHaveLength(1);

    const rows = await toolRowsSince(w.t, rowsBefore);
    expect(rows.map((r) => r.tool)).toEqual(["next_escalation_step", "send_whatsapp"]);
  });
});
