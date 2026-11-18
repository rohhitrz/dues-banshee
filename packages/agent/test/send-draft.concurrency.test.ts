// sendDraft under overlapping requests (PGlite, mock model, fakeHttp, fakeClock, no network): the send
// claim lets exactly one request reach Twilio, and with the claim out of the way the unique indexes
// still stop a second Pay_Link and a second Sent_Message.
// Requirements: 2.8, 3.3, 5.8, 9.11
import { claimSend, escalationEvents, insertPayLink, messages, paymentLinks, recordSent } from "@dues-banshee/db";
import type { TestDb } from "@dues-banshee/db/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sendDraft } from "../src/channel/send-draft";
import type { SendDeps, SendOutcome } from "../src/channel/send-draft";
import type { FakeResponseSpec } from "../src/testing/fake-http";
import {
  DEMO_TODAY,
  MOCK_PAY_LINK_ID,
  MOCK_PAY_LINK_URL,
  RAZORPAY_LINKS_URL,
  SHARMA_AMOUNT_PAISE,
  TWILIO_CREATE_URL,
  TWILIO_MESSAGE_SID,
  buildSendHarness,
  cloneSendWorld,
  createSendTemplate,
  draftAndApproveSharma,
  providerRoutes,
} from "./helpers/send-fixtures";
import type { SendHarness, SendWorld } from "./helpers/send-fixtures";

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

/** A latch: `opened` resolves once `open()` has been called. */
function latch(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

const TWILIO_CREATED: FakeResponseSpec = { status: 201, json: { sid: TWILIO_MESSAGE_SID, status: "queued" } };

/**
 * Twilio's create call answers only once `gate` opens. The tests open the gate when a request has
 * been refused, so the request holding the claim is still inside Twilio while the other one is
 * decided.
 */
function gatedTwilio(gate: { opened: Promise<void> }) {
  return [
    async (): Promise<FakeResponseSpec> => {
      await gate.opened;
      return TWILIO_CREATED;
    },
  ];
}

/** Runs the given sends together; the gate opens as soon as one of them is refused with `cannot_send`. */
function race(
  h: SendHarness,
  w: SendWorld,
  draftId: string,
  gate: { open: () => void },
  channels: readonly ("twilio_sandbox" | "wa_me")[],
): Promise<SendOutcome[]> {
  return Promise.all(
    channels.map(async (channel) => {
      const outcome = await sendDraft(h.deps, { supplierId: w.supplierId, draftId, today: DEMO_TODAY, channel });
      if (outcome.kind === "cannot_send") gate.open();
      return outcome;
    }),
  );
}

async function sentMessages(w: SendWorld) {
  return (await w.db.select().from(messages)).filter((m) => m.status === "sent" || m.status === "handed_off");
}

async function sentEvents(w: SendWorld) {
  return (await w.db.select().from(escalationEvents)).filter((e) => e.action === "sent");
}

const kinds = (outcomes: readonly SendOutcome[]) => outcomes.map((o) => o.kind).sort();

describe("sendDraft: two overlapping requests for one Draft", () => {
  it("sends once through Twilio, creates one Pay_Link and refuses the other request", async () => {
    const w = await world();
    const draftId = await draftAndApproveSharma(w);
    const gate = latch();
    const h = buildSendHarness(w.db, { routes: providerRoutes(draftId, { twilioCreate: gatedTwilio(gate) }) });

    const outcomes = await race(h, w, draftId, gate, ["twilio_sandbox", "twilio_sandbox"]);

    expect(kinds(outcomes)).toEqual(["cannot_send", "sent"]);
    expect(h.http.unmatched).toEqual([]);
    expect(h.http.calls("POST", TWILIO_CREATE_URL)).toHaveLength(1);
    expect(h.http.calls("GET", RAZORPAY_LINKS_URL)).toHaveLength(1);
    expect(h.http.calls("POST", RAZORPAY_LINKS_URL)).toHaveLength(1);

    const links = await w.db.select().from(paymentLinks);
    expect(links.map((l) => ({ providerLinkId: l.providerLinkId, url: l.url, draftId: l.draftId }))).toEqual([
      { providerLinkId: MOCK_PAY_LINK_ID, url: MOCK_PAY_LINK_URL, draftId },
    ]);
    const sent = await sentMessages(w);
    expect(sent.map((m) => ({ status: m.status, channel: m.channel, providerMessageId: m.providerMessageId }))).toEqual([
      { status: "sent", channel: "twilio_sandbox", providerMessageId: TWILIO_MESSAGE_SID },
    ]);
    expect(await sentEvents(w)).toHaveLength(1);
  });

  it("does the same with a Pay_Link that is already stored, without calling Razorpay", async () => {
    const w = await world();
    const draftId = await draftAndApproveSharma(w);
    expect(
      await insertPayLink(w.db, {
        invoiceId: w.invoiceId,
        draftId,
        link: { providerLinkId: MOCK_PAY_LINK_ID, url: MOCK_PAY_LINK_URL, amountPaise: SHARMA_AMOUNT_PAISE },
        createdOn: DEMO_TODAY,
      }),
    ).toEqual("ok");
    const gate = latch();
    const h = buildSendHarness(w.db, { routes: providerRoutes(draftId, { twilioCreate: gatedTwilio(gate) }) });

    const outcomes = await race(h, w, draftId, gate, ["twilio_sandbox", "twilio_sandbox"]);

    expect(kinds(outcomes)).toEqual(["cannot_send", "sent"]);
    expect(h.http.unmatched).toEqual([]);
    expect(h.http.calls("POST", TWILIO_CREATE_URL)).toHaveLength(1);
    expect(h.http.calls("GET", RAZORPAY_LINKS_URL)).toHaveLength(0);
    expect(h.http.calls("POST", RAZORPAY_LINKS_URL)).toHaveLength(0);
    expect(await w.db.select().from(paymentLinks)).toHaveLength(1);
    expect(await sentMessages(w)).toHaveLength(1);
    expect(await sentEvents(w)).toHaveLength(1);
  });

  it("records one Sent_Message in total when a Twilio send and a wa.me handoff race", async () => {
    const w = await world();
    const draftId = await draftAndApproveSharma(w);
    const gate = latch();
    const h = buildSendHarness(w.db, { routes: providerRoutes(draftId, { twilioCreate: gatedTwilio(gate) }) });

    const outcomes = await race(h, w, draftId, gate, ["twilio_sandbox", "wa_me"]);

    // Either request may take the claim first; the other one is refused and nothing else is sent.
    const winner = outcomes.find((o) => o.kind !== "cannot_send");
    expect(outcomes.filter((o) => o.kind === "cannot_send")).toHaveLength(1);
    expect(winner?.kind === "sent" || winner?.kind === "handed_off").toBe(true);

    const sent = await sentMessages(w);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.channel).toEqual(winner?.kind === "sent" ? "twilio_sandbox" : "wa_me");
    expect(h.http.calls("POST", TWILIO_CREATE_URL)).toHaveLength(winner?.kind === "sent" ? 1 : 0);
    expect(await w.db.select().from(paymentLinks)).toHaveLength(1);
    expect(await sentEvents(w)).toHaveLength(1);
  });
});

describe("sendDraft: the unique indexes hold when the claim does not", () => {
  it("rejects a second Pay_Link and a second Sent_Message at the database", async () => {
    const w = await world();
    const draftId = await draftAndApproveSharma(w);
    const link = { providerLinkId: MOCK_PAY_LINK_ID, url: MOCK_PAY_LINK_URL, amountPaise: SHARMA_AMOUNT_PAISE };
    const payLink = { invoiceId: w.invoiceId, draftId, link, createdOn: DEMO_TODAY };
    expect(await insertPayLink(w.db, payLink)).toEqual("ok");
    expect(await insertPayLink(w.db, { ...payLink, link: { ...link, providerLinkId: "plink_other" } })).toEqual(
      "duplicate",
    );

    const sentRow = {
      invoiceId: w.invoiceId,
      draftId,
      step: "whatsapp_nudge",
      today: DEMO_TODAY,
      channel: "twilio_sandbox",
      text: "text",
      providerMessageId: TWILIO_MESSAGE_SID,
    } as const;
    expect(await recordSent(w.db, sentRow)).toEqual("ok");
    expect(await recordSent(w.db, { ...sentRow, channel: "wa_me", providerMessageId: null })).toEqual("duplicate");

    expect(await w.db.select().from(paymentLinks)).toHaveLength(1);
    expect(await sentMessages(w)).toHaveLength(1);
    expect(await sentEvents(w)).toHaveLength(1);
  });

  it("returns cannot_send when another request stored the Pay_Link first, and releases the claim", async () => {
    const w = await world();
    const draftId = await draftAndApproveSharma(w);
    const h = buildSendHarness(w.db, {
      routes: providerRoutes(draftId, {
        // A request that got past the claim stores its link while this one is looking.
        lookup: [
          async (): Promise<FakeResponseSpec> => {
            const stored = await insertPayLink(w.db, {
              invoiceId: w.invoiceId,
              draftId,
              link: { providerLinkId: "plink_other", url: "https://rzp.io/i/other", amountPaise: SHARMA_AMOUNT_PAISE },
              createdOn: DEMO_TODAY,
            });
            expect(stored).toEqual("ok");
            return { json: { count: 0, payment_links: [] } };
          },
        ],
      }),
    });

    const outcome = await sendDraft(h.deps, {
      supplierId: w.supplierId,
      draftId,
      today: DEMO_TODAY,
      channel: "twilio_sandbox",
    });

    expect(outcome).toEqual<SendOutcome>({ kind: "cannot_send" });
    expect(h.http.calls("POST", TWILIO_CREATE_URL)).toHaveLength(0);
    const links = await w.db.select().from(paymentLinks);
    expect(links.map((l) => l.providerLinkId)).toEqual(["plink_other"]);
    expect(await w.db.select().from(messages)).toHaveLength(0);
    expect(await sentEvents(w)).toHaveLength(0);
    // The claim was released: a new request can take it.
    expect(await claimSend(w.db, w.supplierId, draftId)).toBe(true);
  });

  it("returns cannot_send when another request recorded the Sent_Message first, and releases the claim", async () => {
    const w = await world();
    const draftId = await draftAndApproveSharma(w);
    const competing: NonNullable<SendDeps["recordSent"]> = async (db, row) => {
      // A request that got past the claim records its send just before this one does.
      expect(await recordSent(db, row)).toEqual("ok");
      return recordSent(db, row);
    };
    const h = buildSendHarness(w.db, { routes: providerRoutes(draftId), recordSent: competing });

    const outcome = await sendDraft(h.deps, {
      supplierId: w.supplierId,
      draftId,
      today: DEMO_TODAY,
      channel: "twilio_sandbox",
    });

    expect(outcome).toEqual<SendOutcome>({ kind: "cannot_send" });
    expect(await sentMessages(w)).toHaveLength(1);
    expect(await sentEvents(w)).toHaveLength(1);
    // The Draft now has a Sent_Message, so the claim cannot be taken again.
    expect(await claimSend(w.db, w.supplierId, draftId)).toBe(false);
    expect(h.http.unmatched).toEqual([]);
  });
});
