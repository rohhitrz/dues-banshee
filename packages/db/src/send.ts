import type { CalendarDate, LadderStep, Paise } from "@dues-banshee/engine";
import { and, asc, desc, eq, inArray, isNull, lt, notExists, or, sql } from "drizzle-orm";
import type { Db } from "./client";
import { insertEscalationEvent, getDraftForSupplier, isUniqueViolation, listLadderRecords } from "./ladder";
import type { DraftWithContext, LadderRecord } from "./ladder";
import { agentRuns, buyers, drafts, escalationEvents, invoices, messages, paymentLinks } from "./schema";

/** The two channels a send can use; also the `messages.channel` value. */
export type SendChannel = "twilio_sandbox" | "wa_me";

/** The ladder steps whose Drafts the send path can send. */
const SENDABLE_STEPS = ["whatsapp_nudge", "whatsapp_paylink"] as const;

/** How long a send claim holds before another request may take it (longer than the page's `maxDuration`). */
const CLAIM_LEASE_SECONDS = 360;

const PAY_LINK_DRAFT_INDEX = "payment_links_draft_id_key";
const SENT_MESSAGE_INDEX = "messages_one_sent_per_draft";

/** A Razorpay Payment Link as the send path stores and reuses it. */
export interface PayLinkInfo {
  providerLinkId: string;
  url: string;
  amountPaise: Paise;
}

/** Everything `sendDraft` reads about one Draft, all reached through `invoices.supplier_id`. */
export interface SendContext extends DraftWithContext {
  /** `occurred_on` of the Draft's `approved` Escalation_Event; `null` if there is none. */
  approvalDay: CalendarDate | null;
  /** True when the Draft already has a `sent` or `handed_off` Message_Row. */
  hasSentMessage: boolean;
  /** The stored Pay_Link for this Draft, if any. */
  payLink: (PayLinkInfo & { createdOn: CalendarDate | null }) | null;
  /** The buyer's E.164 WhatsApp number, or `null`. */
  buyerNumber: string | null;
  /** `listLadderRecords(db, supplierId, invoiceId)[0]`. */
  record: LadderRecord;
}

/** The stored Pay_Link of a Draft, only if its invoice belongs to `supplierId`; `null` if there is none. */
export async function getPayLinkForDraft(
  db: Db,
  supplierId: string,
  draftId: string,
): Promise<(PayLinkInfo & { createdOn: CalendarDate | null }) | null> {
  const [link] = await db
    .select({
      providerLinkId: paymentLinks.providerLinkId,
      url: paymentLinks.url,
      amountPaise: paymentLinks.amountPaise,
      createdOn: paymentLinks.createdOn,
    })
    .from(paymentLinks)
    .innerJoin(invoices, eq(invoices.id, paymentLinks.invoiceId))
    .where(and(eq(invoices.supplierId, supplierId), eq(paymentLinks.draftId, draftId)))
    .limit(1);
  return link === undefined ? null : link;
}
/**
 * Reads one Draft with its send facts, only if its invoice belongs to `supplierId`. Returns `null`
 * for an unknown id and for another supplier's Draft (the two look the same to the caller).
 */
export async function getSendContext(db: Db, supplierId: string, draftId: string): Promise<SendContext | null> {
  const ctx = await getDraftForSupplier(db, supplierId, draftId);
  if (ctx === null) return null;

  const [record] = await listLadderRecords(db, supplierId, ctx.draft.invoiceId);
  if (record === undefined) return null;

  const approved = record.steps
    .filter((s) => s.action === "approved" && s.draftId === draftId)
    .map((s) => s.occurredOn)
    .sort();
  const approvalDay = approved.length > 0 ? (approved[approved.length - 1] ?? null) : null;

  const [sent] = await db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(invoices, eq(invoices.id, messages.invoiceId))
    .where(
      and(
        eq(invoices.supplierId, supplierId),
        eq(messages.draftId, draftId),
        inArray(messages.status, ["sent", "handed_off"]),
      ),
    )
    .limit(1);

  const link = await getPayLinkForDraft(db, supplierId, draftId);

  const [buyer] = await db
    .select({ whatsappNumber: buyers.whatsappNumber })
    .from(buyers)
    .where(and(eq(buyers.supplierId, supplierId), eq(buyers.id, ctx.buyerId)))
    .limit(1);

  return {
    ...ctx,
    approvalDay,
    hasSentMessage: sent !== undefined,
    payLink: link,
    buyerNumber: buyer?.whatsappNumber ?? null,
    record,
  };
}

/**
 * Takes the send claim on a Draft of this supplier with one conditional `UPDATE … FROM invoices`.
 * It succeeds only for an `approved` WhatsApp Draft that has no Sent_Message and whose claim is
 * unset or older than the 360-second lease, and that has no `send_whatsapp` Tool_Log row recording a
 * Twilio `sent` (the message may have gone out without a Message_Row). Two overlapping calls serialise on the row lock, so
 * only one gets `true`.
 */
export async function claimSend(db: Db, supplierId: string, draftId: string): Promise<boolean> {
  const rows = await db
    .update(drafts)
    .set({ sendClaimedAt: sql`now()` })
    .from(invoices)
    .where(
      and(
        eq(drafts.invoiceId, invoices.id),
        eq(invoices.supplierId, supplierId),
        eq(drafts.id, draftId),
        eq(drafts.status, "approved"),
        inArray(drafts.step, [...SENDABLE_STEPS]),
        or(
          isNull(drafts.sendClaimedAt),
          lt(drafts.sendClaimedAt, sql`now() - make_interval(secs => ${CLAIM_LEASE_SECONDS})`),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(messages)
            .where(and(eq(messages.draftId, drafts.id), inArray(messages.status, ["sent", "handed_off"]))),
        ),
        // Twilio said `sent` but `recordSent` failed: the Tool_Log row is the only trace of the message,
        // so an expired lease must not let a retry message the buyer a second time.
        notExists(
          db
            .select({ one: sql`1` })
            .from(agentRuns)
            .where(
              and(
                eq(agentRuns.tool, "send_whatsapp"),
                sql`${agentRuns.input}->>'draftId' = ${drafts.id}::text`,
                sql`${agentRuns.output}->>'kind' = 'sent'`,
              ),
            ),
        ),
      ),
    )
    .returning({ id: drafts.id });
  return rows.length > 0;
}

/** Clears the send claim. Call it only after a successful `claimSend` on the same Draft. */
export async function releaseSend(db: Db, draftId: string): Promise<void> {
  await db.update(drafts).set({ sendClaimedAt: null }).where(eq(drafts.id, draftId));
}

/**
 * Stores the Pay_Link of a Draft (status `created`). A second link for the same Draft is rejected
 * by `payment_links_draft_id_key` and returned as `"duplicate"`; any other error is rethrown.
 */
export async function insertPayLink(
  db: Db,
  row: { invoiceId: string; draftId: string; link: PayLinkInfo; createdOn: CalendarDate },
): Promise<"ok" | "duplicate"> {
  try {
    await db.insert(paymentLinks).values({
      invoiceId: row.invoiceId,
      draftId: row.draftId,
      providerLinkId: row.link.providerLinkId,
      url: row.link.url,
      amountPaise: row.link.amountPaise,
      status: "created",
      createdOn: row.createdOn,
    });
    return "ok";
  } catch (error) {
    if (isUniqueViolation(error, PAY_LINK_DRAFT_INDEX)) return "duplicate";
    throw error;
  }
}

/**
 * Writes the Sent_Message and its `sent` Escalation_Event in one transaction. `twilio_sandbox`
 * stores status `sent`, `wa_me` stores `handed_off`. A second Sent_Message for the Draft is rejected
 * by `messages_one_sent_per_draft`: the transaction rolls back (no event) and `"duplicate"` is
 * returned. Any other error is rethrown.
 */
export async function recordSent(
  db: Db,
  row: {
    invoiceId: string;
    draftId: string;
    step: LadderStep;
    today: CalendarDate;
    channel: SendChannel;
    text: string;
    providerMessageId: string | null;
  },
): Promise<"ok" | "duplicate"> {
  try {
    await db.transaction(async (tx) => {
      const [message] = await tx
        .insert(messages)
        .values({
          invoiceId: row.invoiceId,
          channel: row.channel,
          direction: "outbound",
          body: row.text,
          status: row.channel === "twilio_sandbox" ? "sent" : "handed_off",
          draftId: row.draftId,
          providerMessageId: row.providerMessageId,
          errorCode: null,
        })
        .returning({ id: messages.id });
      if (message === undefined) throw new Error("recordSent: no message row returned");
      await insertEscalationEvent(tx, {
        invoiceId: row.invoiceId,
        step: row.step,
        occurredOn: row.today,
        action: "sent",
        draftId: row.draftId,
        detail: { channel: row.channel, messageRowId: message.id },
      });
    });
    return "ok";
  } catch (error) {
    if (isUniqueViolation(error, SENT_MESSAGE_INDEX)) return "duplicate";
    throw error;
  }
}

/**
 * Records one failed Twilio attempt: a `failed` Message_Row and no Escalation_Event. The SID is
 * kept when the create call returned one (a failure reported by a status poll). `failed` rows are
 * not limited by `messages_one_sent_per_draft`.
 */
export async function insertFailedMessage(
  db: Db,
  row: { invoiceId: string; draftId: string; text: string; errorCode: string; providerMessageId: string | null },
): Promise<void> {
  await db.insert(messages).values({
    invoiceId: row.invoiceId,
    channel: "twilio_sandbox",
    direction: "outbound",
    body: row.text,
    status: "failed",
    draftId: row.draftId,
    providerMessageId: row.providerMessageId,
    errorCode: row.errorCode,
  });
}

/** An approved WhatsApp Draft that has not been sent yet. */
export interface SendableDraftRow {
  draftId: string;
  step: LadderStep;
  approvalDay: CalendarDate;
  createdAt: Date;
  bodyText: string;
  ruleIds: string[];
}

/** One invoice's send facts for the Debtor_Page. */
export interface InvoiceSendState {
  invoiceId: string;
  /** Approved WhatsApp Drafts with no Sent_Message. */
  sendableDrafts: SendableDraftRow[];
  /** The latest Sent_Message: its channel and the `occurred_on` of its `sent` event. */
  lastSent: { channel: SendChannel; sentOn: CalendarDate } | null;
}

/** Send facts for every invoice of one buyer of this supplier, ordered by invoice id. */
export async function listSendState(
  db: Db,
  supplierId: string,
  buyerId: string,
): Promise<{ buyerHasNumber: boolean; invoices: InvoiceSendState[] }> {
  const [buyer] = await db
    .select({ whatsappNumber: buyers.whatsappNumber })
    .from(buyers)
    .where(and(eq(buyers.supplierId, supplierId), eq(buyers.id, buyerId)))
    .limit(1);

  const invoiceRows = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.supplierId, supplierId), eq(invoices.buyerId, buyerId)))
    .orderBy(asc(invoices.id));

  const draftRows = await db
    .select({
      invoiceId: drafts.invoiceId,
      draftId: drafts.id,
      step: drafts.step,
      createdAt: drafts.createdAt,
      bodyText: drafts.bodyText,
      ruleIds: drafts.ruleIds,
      approvalDay: escalationEvents.occurredOn,
    })
    .from(drafts)
    .innerJoin(invoices, eq(invoices.id, drafts.invoiceId))
    .innerJoin(
      escalationEvents,
      and(eq(escalationEvents.draftId, drafts.id), eq(escalationEvents.action, "approved")),
    )
    .where(
      and(
        eq(invoices.supplierId, supplierId),
        eq(invoices.buyerId, buyerId),
        eq(drafts.status, "approved"),
        inArray(drafts.step, [...SENDABLE_STEPS]),
        notExists(
          db
            .select({ one: sql`1` })
            .from(messages)
            .where(and(eq(messages.draftId, drafts.id), inArray(messages.status, ["sent", "handed_off"]))),
        ),
      ),
    )
    .orderBy(asc(drafts.createdAt), asc(drafts.id));

  const sentRows = await db
    .select({
      invoiceId: messages.invoiceId,
      channel: messages.channel,
      sentOn: escalationEvents.occurredOn,
    })
    .from(messages)
    .innerJoin(invoices, eq(invoices.id, messages.invoiceId))
    .innerJoin(
      escalationEvents,
      and(eq(escalationEvents.draftId, messages.draftId), eq(escalationEvents.action, "sent")),
    )
    .where(
      and(
        eq(invoices.supplierId, supplierId),
        eq(invoices.buyerId, buyerId),
        inArray(messages.status, ["sent", "handed_off"]),
      ),
    )
    .orderBy(desc(escalationEvents.occurredOn), desc(messages.createdAt), desc(messages.id));

  const states = new Map<string, InvoiceSendState>();
  for (const r of invoiceRows) states.set(r.id, { invoiceId: r.id, sendableDrafts: [], lastSent: null });

  const seenDraft = new Set<string>();
  for (const d of draftRows) {
    const state = states.get(d.invoiceId);
    if (state === undefined || seenDraft.has(d.draftId)) continue;
    seenDraft.add(d.draftId);
    state.sendableDrafts.push({
      draftId: d.draftId,
      step: d.step,
      approvalDay: d.approvalDay,
      createdAt: d.createdAt,
      bodyText: d.bodyText,
      ruleIds: d.ruleIds,
    });
  }
  // Rows are newest first, so the first one seen for an invoice is its latest Sent_Message.
  for (const s of sentRows) {
    const state = states.get(s.invoiceId);
    if (state === undefined || state.lastSent !== null) continue;
    if (s.channel !== "twilio_sandbox" && s.channel !== "wa_me") continue;
    state.lastSent = { channel: s.channel, sentOn: s.sentOn };
  }

  return { buyerHasNumber: buyer?.whatsappNumber != null, invoices: [...states.values()] };
}
