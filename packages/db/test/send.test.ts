import type { EscalationDecision } from "@dues-banshee/engine";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { insertEscalationEvent } from "../src/ladder";
import { buyers, drafts, escalationEvents, invoices, messages, paymentLinks, suppliers } from "../src/schema";
import { seed } from "../src/seed";
import {
  claimSend,
  getPayLinkForDraft,
  getSendContext,
  insertFailedMessage,
  insertPayLink,
  listSendState,
  recordSent,
  releaseSend,
} from "../src/send";
import { cloneTestDb, createTestDb, type TestDb } from "../src/testing";
import { logToolCall } from "../src/tool-log";
import { recordWebhookEvent } from "../src/webhooks";

const SHARMA = "LPC/26-27/0412";
const BUYER_NUMBER = "+919000000001";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

const DECISION: EscalationDecision = {
  action: "advance",
  applicable: true,
  step: "whatsapp_nudge",
  rank: 1,
  requiresApproval: false,
  ruleIds: ["MSMED-15"],
};

const PAY_LINK = {
  providerLinkId: "plink_test_0001",
  url: "https://rzp.example/plink_test_0001",
  amountPaise: 41_200_000,
};

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

interface World {
  t: TestDb;
  supplierId: string;
  otherSupplierId: string;
  sharmaBuyerId: string;
  guptaBuyerId: string;
  invoiceId: string;
  /** An approved `whatsapp_nudge` Draft for the Sharma invoice, approved on 2026-11-12. */
  draftId: string;
}

async function insertDraft(
  t: TestDb,
  invoiceId: string,
  over: Partial<typeof drafts.$inferInsert> = {},
): Promise<string> {
  const [row] = await t.db
    .insert(drafts)
    .values({
      invoiceId,
      step: "whatsapp_nudge",
      status: "approved",
      language: "hinglish",
      bodyText: "Sharma ji, a gentle reminder.",
      finalText: "Sharma ji, a gentle reminder.\n\nBasis: MSMED-15 (MSMED Act 2006, s.15)\nDisclaimer",
      ruleIds: ["MSMED-15"],
      modelId: "mock-haiku",
      decision: DECISION,
      createdOn: "2026-11-12",
      ...over,
    })
    .returning({ id: drafts.id });
  if (row === undefined) throw new Error("draft not inserted");
  return row.id;
}

async function approve(
  t: TestDb,
  invoiceId: string,
  draftId: string,
  step: "whatsapp_nudge" | "whatsapp_paylink" | "voice_call",
  day: string,
): Promise<void> {
  await insertEscalationEvent(t.db, { invoiceId, step, occurredOn: day, action: "approved", draftId });
}

/** A migrated database with the demo seed (Sharma has `+919000000001`), a second supplier and one approved Draft. */
async function world(): Promise<World> {
  const t = await cloneTestDb(template);
  open.push(t);
  await seed(t.db, { demoBuyerWhatsapp: BUYER_NUMBER });

  const [supplier] = await t.db.select({ id: suppliers.id }).from(suppliers);
  const [sharma] = await t.db
    .select({ id: invoices.id, buyerId: invoices.buyerId })
    .from(invoices)
    .where(eq(invoices.invoiceNumber, SHARMA));
  const [gupta] = await t.db.select({ id: buyers.id }).from(buyers).where(eq(buyers.name, "Gupta Engineering Works"));
  const [other] = await t.db
    .insert(suppliers)
    .values({
      name: "Other Supplier",
      udyamNumber: "UDYAM-MH-00-0000001",
      supplierCategory: "micro",
      supplierActivity: "manufacturing",
    })
    .returning({ id: suppliers.id });
  if (supplier === undefined || sharma === undefined || gupta === undefined || other === undefined) {
    throw new Error("demo seed missing");
  }

  const draftId = await insertDraft(t, sharma.id);
  await approve(t, sharma.id, draftId, "whatsapp_nudge", "2026-11-12");
  return {
    t,
    supplierId: supplier.id,
    otherSupplierId: other.id,
    sharmaBuyerId: sharma.buyerId,
    guptaBuyerId: gupta.id,
    invoiceId: sharma.id,
    draftId,
  };
}

function sentRow(w: World, over: Partial<Parameters<typeof recordSent>[1]> = {}): Parameters<typeof recordSent>[1] {
  return {
    invoiceId: w.invoiceId,
    draftId: w.draftId,
    step: "whatsapp_nudge",
    today: "2026-11-12",
    channel: "twilio_sandbox",
    text: "Final text",
    providerMessageId: "SM0000000000000000000000000000test",
    ...over,
  };
}

describe("getSendContext", () => {
  it("returns null for another supplier's Draft and for an unknown id", async () => {
    const w = await world();
    expect(await getSendContext(w.t.db, w.otherSupplierId, w.draftId)).toBeNull();
    expect(await getSendContext(w.t.db, w.supplierId, UNKNOWN_ID)).toBeNull();
  });

  it("returns the approval day, no Sent_Message, no Pay_Link and the Buyer_Number for the demo Draft", async () => {
    const w = await world();
    const ctx = await getSendContext(w.t.db, w.supplierId, w.draftId);
    expect(ctx).not.toBeNull();
    expect(ctx?.draft.id).toBe(w.draftId);
    expect(ctx?.draft.status).toBe("approved");
    expect(ctx?.draft.step).toBe("whatsapp_nudge");
    expect(ctx?.buyerId).toBe(w.sharmaBuyerId);
    expect(ctx?.buyerName).toBe("Sharma Traders");
    expect(ctx?.invoiceNumber).toBe(SHARMA);
    expect(ctx?.approvalDay).toBe("2026-11-12");
    expect(ctx?.hasSentMessage).toBe(false);
    expect(ctx?.payLink).toBeNull();
    expect(ctx?.buyerNumber).toBe(BUYER_NUMBER);
    expect(ctx?.record.invoiceNumber).toBe(SHARMA);
  });

  it("returns a null approval day for a Draft with no approved event and a null Buyer_Number for a buyer without one", async () => {
    const w = await world();
    const [guptaInvoice] = await w.t.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.buyerId, w.guptaBuyerId));
    if (guptaInvoice === undefined) throw new Error("gupta invoice missing");
    const unapproved = await insertDraft(w.t, guptaInvoice.id, { status: "pending" });
    const ctx = await getSendContext(w.t.db, w.supplierId, unapproved);
    expect(ctx?.approvalDay).toBeNull();
    expect(ctx?.buyerNumber).toBeNull();
  });

  it("returns the stored Pay_Link", async () => {
    const w = await world();
    expect(
      await insertPayLink(w.t.db, {
        invoiceId: w.invoiceId,
        draftId: w.draftId,
        link: PAY_LINK,
        createdOn: "2026-11-12",
      }),
    ).toBe("ok");
    const ctx = await getSendContext(w.t.db, w.supplierId, w.draftId);
    expect(ctx?.payLink).toEqual({ ...PAY_LINK, createdOn: "2026-11-12" });
  });

  it("reports a Sent_Message, but not a failed attempt", async () => {
    const w = await world();
    await insertFailedMessage(w.t.db, {
      invoiceId: w.invoiceId,
      draftId: w.draftId,
      text: "Final text",
      errorCode: "63015",
      providerMessageId: null,
    });
    expect((await getSendContext(w.t.db, w.supplierId, w.draftId))?.hasSentMessage).toBe(false);
    expect(await recordSent(w.t.db, sentRow(w))).toBe("ok");
    expect((await getSendContext(w.t.db, w.supplierId, w.draftId))?.hasSentMessage).toBe(true);
  });
});

describe("claimSend and releaseSend", () => {
  it("succeeds once and fails for a second claim", async () => {
    const w = await world();
    expect(await claimSend(w.t.db, w.supplierId, w.draftId)).toBe(true);
    expect(await claimSend(w.t.db, w.supplierId, w.draftId)).toBe(false);
  });

  it("succeeds again after releaseSend", async () => {
    const w = await world();
    expect(await claimSend(w.t.db, w.supplierId, w.draftId)).toBe(true);
    await releaseSend(w.t.db, w.draftId);
    const [row] = await w.t.db.select({ at: drafts.sendClaimedAt }).from(drafts).where(eq(drafts.id, w.draftId));
    expect(row?.at).toBeNull();
    expect(await claimSend(w.t.db, w.supplierId, w.draftId)).toBe(true);
  });

  it("holds a claim made 300 s ago and takes over one made 361 s ago", async () => {
    const w = await world();
    expect(await claimSend(w.t.db, w.supplierId, w.draftId)).toBe(true);
    await w.t.db
      .update(drafts)
      .set({ sendClaimedAt: sql`now() - make_interval(secs => 300)` })
      .where(eq(drafts.id, w.draftId));
    expect(await claimSend(w.t.db, w.supplierId, w.draftId)).toBe(false);
    await w.t.db
      .update(drafts)
      .set({ sendClaimedAt: sql`now() - make_interval(secs => 361)` })
      .where(eq(drafts.id, w.draftId));
    expect(await claimSend(w.t.db, w.supplierId, w.draftId)).toBe(true);
  });

  it("fails for another supplier and leaves the Draft claimable by its owner", async () => {
    const w = await world();
    expect(await claimSend(w.t.db, w.otherSupplierId, w.draftId)).toBe(false);
    expect(await claimSend(w.t.db, w.supplierId, UNKNOWN_ID)).toBe(false);
    expect(await claimSend(w.t.db, w.supplierId, w.draftId)).toBe(true);
  });

  it("fails for a Draft that is not approved or is not a WhatsApp step", async () => {
    const w = await world();
    const pending = await insertDraft(w.t, w.invoiceId, { status: "pending" });
    const voice = await insertDraft(w.t, w.invoiceId, { step: "voice_call" });
    expect(await claimSend(w.t.db, w.supplierId, pending)).toBe(false);
    expect(await claimSend(w.t.db, w.supplierId, voice)).toBe(false);
  });

  it("fails once a Sent_Message exists, for both channels", async () => {
    const w = await world();
    expect(await recordSent(w.t.db, sentRow(w))).toBe("ok");
    expect(await claimSend(w.t.db, w.supplierId, w.draftId)).toBe(false);

    const second = await insertDraft(w.t, w.invoiceId);
    expect(await recordSent(w.t.db, sentRow(w, { draftId: second, channel: "wa_me", providerMessageId: null }))).toBe(
      "ok",
    );
    expect(await claimSend(w.t.db, w.supplierId, second)).toBe(false);
  });

  it("is not blocked by a failed Message_Row", async () => {
    const w = await world();
    await insertFailedMessage(w.t.db, {
      invoiceId: w.invoiceId,
      draftId: w.draftId,
      text: "Final text",
      errorCode: "63015",
      providerMessageId: null,
    });
    expect(await claimSend(w.t.db, w.supplierId, w.draftId)).toBe(true);
  });
});

describe("claimSend and the send_whatsapp Tool_Log", () => {
  async function expireClaim(w: World): Promise<void> {
    await w.t.db
      .update(drafts)
      .set({ sendClaimedAt: sql`now() - make_interval(secs => 361)` })
      .where(eq(drafts.id, w.draftId));
  }
  it("refuses a Draft with a `sent` send_whatsapp row even after the lease expired", async () => {
    const w = await world();
    expect(await claimSend(w.t.db, w.supplierId, w.draftId)).toBe(true);
    await logToolCall(w.t.db, {
      tool: "send_whatsapp",
      invoiceId: w.invoiceId,
      input: { invoiceId: w.invoiceId, draftId: w.draftId, channel: "twilio_sandbox" },
      output: { kind: "sent", providerMessageId: "SM1", polls: [] },
    });
    await expireClaim(w);
    expect(await claimSend(w.t.db, w.supplierId, w.draftId)).toBe(false);
    await releaseSend(w.t.db, w.draftId);
    expect(await claimSend(w.t.db, w.supplierId, w.draftId)).toBe(false);
  });
  it("is not blocked by a failed or handoff row, another tool, or another Draft's `sent` row", async () => {
    const w = await world();
    const other = await insertDraft(w.t, w.invoiceId);
    const row = (tool: string, draftId: string, kind: string) => ({
      tool,
      invoiceId: w.invoiceId,
      input: { invoiceId: w.invoiceId, draftId },
      output: { kind },
    });
    await logToolCall(w.t.db, row("send_whatsapp", w.draftId, "failed"));
    await logToolCall(w.t.db, row("send_whatsapp", w.draftId, "handoff"));
    await logToolCall(w.t.db, row("find_payment_link", w.draftId, "sent"));
    await logToolCall(w.t.db, row("send_whatsapp", other, "sent"));
    await logToolCall(w.t.db, { tool: "send_whatsapp", invoiceId: null, input: { draftId: w.draftId }, output: null });
    expect(await claimSend(w.t.db, w.supplierId, w.draftId)).toBe(true);
  });
});
describe("getPayLinkForDraft", () => {
  it("returns the stored Pay_Link for its supplier only", async () => {
    const w = await world();
    expect(await getPayLinkForDraft(w.t.db, w.supplierId, w.draftId)).toBeNull();
    await insertPayLink(w.t.db, { invoiceId: w.invoiceId, draftId: w.draftId, link: PAY_LINK, createdOn: "2026-11-12" });
    expect(await getPayLinkForDraft(w.t.db, w.supplierId, w.draftId)).toEqual({ ...PAY_LINK, createdOn: "2026-11-12" });
    expect(await getPayLinkForDraft(w.t.db, w.otherSupplierId, w.draftId)).toBeNull();
    expect(await getPayLinkForDraft(w.t.db, w.supplierId, UNKNOWN_ID)).toBeNull();
  });
});
describe("insertPayLink", () => {
  it("accepts the first Pay_Link for a Draft and reports the second as duplicate", async () => {
    const w = await world();
    const row = { invoiceId: w.invoiceId, draftId: w.draftId, link: PAY_LINK, createdOn: "2026-11-12" } as const;
    expect(await insertPayLink(w.t.db, row)).toBe("ok");
    expect(
      await insertPayLink(w.t.db, {
        ...row,
        link: { providerLinkId: "plink_test_0002", url: "https://rzp.example/plink_test_0002", amountPaise: 41_200_000 },
      }),
    ).toBe("duplicate");

    const stored = await w.t.db
      .select({
        invoiceId: paymentLinks.invoiceId,
        draftId: paymentLinks.draftId,
        providerLinkId: paymentLinks.providerLinkId,
        url: paymentLinks.url,
        amountPaise: paymentLinks.amountPaise,
        status: paymentLinks.status,
        createdOn: paymentLinks.createdOn,
      })
      .from(paymentLinks);
    expect(stored).toEqual([
      {
        invoiceId: w.invoiceId,
        draftId: w.draftId,
        providerLinkId: "plink_test_0001",
        url: "https://rzp.example/plink_test_0001",
        amountPaise: 41_200_000,
        status: "created",
        createdOn: "2026-11-12",
      },
    ]);
  });
});

describe("recordSent and insertFailedMessage", () => {
  it("writes a Message_Row and one sent event, and reports the second send as duplicate with no second event", async () => {
    const w = await world();
    expect(await recordSent(w.t.db, sentRow(w))).toBe("ok");
    expect(await recordSent(w.t.db, sentRow(w, { channel: "wa_me", providerMessageId: null }))).toBe("duplicate");

    const rows = await w.t.db
      .select({
        id: messages.id,
        invoiceId: messages.invoiceId,
        channel: messages.channel,
        direction: messages.direction,
        body: messages.body,
        status: messages.status,
        draftId: messages.draftId,
        providerMessageId: messages.providerMessageId,
        errorCode: messages.errorCode,
      })
      .from(messages);
    expect(rows).toEqual([
      {
        id: rows[0]?.id,
        invoiceId: w.invoiceId,
        channel: "twilio_sandbox",
        direction: "outbound",
        body: "Final text",
        status: "sent",
        draftId: w.draftId,
        providerMessageId: "SM0000000000000000000000000000test",
        errorCode: null,
      },
    ]);

    const events = await w.t.db
      .select({
        invoiceId: escalationEvents.invoiceId,
        step: escalationEvents.step,
        occurredOn: escalationEvents.occurredOn,
        draftId: escalationEvents.draftId,
        detail: escalationEvents.detail,
      })
      .from(escalationEvents)
      .where(eq(escalationEvents.action, "sent"));
    expect(events).toEqual([
      {
        invoiceId: w.invoiceId,
        step: "whatsapp_nudge",
        occurredOn: "2026-11-12",
        draftId: w.draftId,
        detail: { channel: "twilio_sandbox", messageRowId: rows[0]?.id },
      },
    ]);
  });

  it("stores a wa_me handoff with status handed_off", async () => {
    const w = await world();
    expect(await recordSent(w.t.db, sentRow(w, { channel: "wa_me", providerMessageId: null }))).toBe("ok");
    const [row] = await w.t.db
      .select({ channel: messages.channel, status: messages.status, providerMessageId: messages.providerMessageId })
      .from(messages);
    expect(row).toEqual({ channel: "wa_me", status: "handed_off", providerMessageId: null });
  });

  it("does not let a failed Message_Row block a later sent one", async () => {
    const w = await world();
    await insertFailedMessage(w.t.db, {
      invoiceId: w.invoiceId,
      draftId: w.draftId,
      text: "Final text",
      errorCode: "63015",
      providerMessageId: "SM0000000000000000000000000000fail",
    });
    await insertFailedMessage(w.t.db, {
      invoiceId: w.invoiceId,
      draftId: w.draftId,
      text: "Final text",
      errorCode: "63016",
      providerMessageId: null,
    });
    expect(await recordSent(w.t.db, sentRow(w))).toBe("ok");

    const rows = await w.t.db
      .select({
        status: messages.status,
        errorCode: messages.errorCode,
        providerMessageId: messages.providerMessageId,
      })
      .from(messages)
      .orderBy(messages.status, messages.errorCode);
    expect(rows).toEqual([
      { status: "failed", errorCode: "63015", providerMessageId: "SM0000000000000000000000000000fail" },
      { status: "failed", errorCode: "63016", providerMessageId: null },
      { status: "sent", errorCode: null, providerMessageId: "SM0000000000000000000000000000test" },
    ]);
    const sentEvents = await w.t.db.select({ id: escalationEvents.id }).from(escalationEvents).where(eq(escalationEvents.action, "sent"));
    expect(sentEvents).toHaveLength(1);
  });
});

describe("recordWebhookEvent", () => {
  it("returns true the first time and false for a repeated (provider, event id) pair", async () => {
    const w = await world();
    expect(await recordWebhookEvent(w.t.db, "razorpay", "evt_test_0001")).toBe(true);
    expect(await recordWebhookEvent(w.t.db, "razorpay", "evt_test_0001")).toBe(false);
    expect(await recordWebhookEvent(w.t.db, "twilio", "evt_test_0001")).toBe(true);
    expect(await recordWebhookEvent(w.t.db, "razorpay", "evt_test_0002")).toBe(true);
  });
});

describe("listSendState", () => {
  it("lists approved WhatsApp Drafts without a Sent_Message, and the latest Sent_Message with its sent event date", async () => {
    const w = await world();

    // Sent earlier: a nudge approved and sent on 2026-11-05 through Twilio.
    const earlier = await insertDraft(w.t, w.invoiceId, { createdOn: "2026-11-05" });
    await approve(w.t, w.invoiceId, earlier, "whatsapp_nudge", "2026-11-05");
    expect(
      await recordSent(w.t.db, sentRow(w, { draftId: earlier, today: "2026-11-05", channel: "twilio_sandbox" })),
    ).toBe("ok");

    // Sent later: a pay-link message handed off through wa.me on 2026-11-12.
    const later = await insertDraft(w.t, w.invoiceId, { step: "whatsapp_paylink" });
    await approve(w.t, w.invoiceId, later, "whatsapp_paylink", "2026-11-12");
    expect(
      await recordSent(
        w.t.db,
        sentRow(w, {
          draftId: later,
          step: "whatsapp_paylink",
          today: "2026-11-12",
          channel: "wa_me",
          providerMessageId: null,
        }),
      ),
    ).toBe("ok");

    // Not listed: a pending Draft and an approved voice-call Draft.
    await insertDraft(w.t, w.invoiceId, { status: "pending" });
    const voice = await insertDraft(w.t, w.invoiceId, { step: "voice_call" });
    await approve(w.t, w.invoiceId, voice, "voice_call", "2026-11-12");

    // Listed second: another approved paylink Draft, created after the demo Draft.
    const paylink = await insertDraft(w.t, w.invoiceId, {
      step: "whatsapp_paylink",
      bodyText: "Kripya {{pay_link}} se bhugtan kar dein.",
      ruleIds: ["MSMED-16"],
      createdAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    await approve(w.t, w.invoiceId, paylink, "whatsapp_paylink", "2026-11-11");

    const state = await listSendState(w.t.db, w.supplierId, w.sharmaBuyerId);
    expect(state.buyerHasNumber).toBe(true);
    expect(state.invoices).toHaveLength(1);
    const [inv] = state.invoices;
    expect(inv?.invoiceId).toBe(w.invoiceId);
    expect(inv?.lastSent).toEqual({ channel: "wa_me", sentOn: "2026-11-12" });
    expect(inv?.sendableDrafts.map((d) => ({ draftId: d.draftId, step: d.step, approvalDay: d.approvalDay }))).toEqual([
      { draftId: w.draftId, step: "whatsapp_nudge", approvalDay: "2026-11-12" },
      { draftId: paylink, step: "whatsapp_paylink", approvalDay: "2026-11-11" },
    ]);
    expect(inv?.sendableDrafts[0]).toMatchObject({
      bodyText: "Sharma ji, a gentle reminder.",
      ruleIds: ["MSMED-15"],
    });
    expect(inv?.sendableDrafts[1]).toMatchObject({
      bodyText: "Kripya {{pay_link}} se bhugtan kar dein.",
      ruleIds: ["MSMED-16"],
      createdAt: new Date("2030-01-01T00:00:00.000Z"),
    });
  });

  it("reports an invoice with nothing approved or sent as empty, and no number for a buyer without one", async () => {
    const w = await world();
    const gupta = await listSendState(w.t.db, w.supplierId, w.guptaBuyerId);
    expect(gupta.buyerHasNumber).toBe(false);
    expect(gupta.invoices).toHaveLength(1);
    expect(gupta.invoices[0]?.sendableDrafts).toEqual([]);
    expect(gupta.invoices[0]?.lastSent).toBeNull();
  });

  it("returns nothing for another supplier", async () => {
    const w = await world();
    expect(await listSendState(w.t.db, w.otherSupplierId, w.sharmaBuyerId)).toEqual({
      buyerHasNumber: false,
      invoices: [],
    });
  });

  it("drops a Draft from the sendable list once it is sent", async () => {
    const w = await world();
    expect((await listSendState(w.t.db, w.supplierId, w.sharmaBuyerId)).invoices[0]?.sendableDrafts).toHaveLength(1);
    expect(await recordSent(w.t.db, sentRow(w))).toBe("ok");
    const [inv] = (await listSendState(w.t.db, w.supplierId, w.sharmaBuyerId)).invoices;
    expect(inv?.sendableDrafts).toEqual([]);
    expect(inv?.lastSent).toEqual({ channel: "twilio_sandbox", sentOn: "2026-11-12" });
  });
});
