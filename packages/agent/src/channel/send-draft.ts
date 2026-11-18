import {
  claimSend,
  getPayLinkForDraft,
  getSendContext,
  insertFailedMessage,
  insertPayLink,
  logToolCall,
  recordSent,
  releaseSend,
} from "@dues-banshee/db";
import type { Db, SendContext } from "@dues-banshee/db";
import { DEFAULT_LADDER_CONFIG, RULE_IDS, ValidationError, nextEscalationStep } from "@dues-banshee/engine";
import type { CalendarDate, EscalationDecision, RuleId } from "@dues-banshee/engine";
import { PAY_LINK_TEXT } from "../core/fact-sheet";
import type { ChannelEnv } from "./env";
import { parseE164 } from "./message-channel";
import type { ChannelErrorKind, ChannelResult, E164, MessageChannel } from "./message-channel";
import { maskNumber } from "./mask";
import { buildOutboundText } from "./outbound-text";
import type { CreateLinkBody, PayLinkInfo, RazorpayClient, RazorpayResult } from "./razorpay";
import { sendCheckHistory } from "./send-check";

/** WhatsApp's limit for one free-form message, counted in UTF-16 code units (Req 3.8). */
export const MAX_OUTBOUND_LENGTH = 1600;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SendDeps {
  db: Db;
  env: ChannelEnv;
  /** `null` iff `env.razorpay` is `null`. */
  razorpay: RazorpayClient | null;
  /** `null` iff `env.twilio` is `null`. */
  twilio: MessageChannel | null;
  waMe: MessageChannel;
  /** Test seam: replaces the db `recordSent` (for example to force a failure after a Twilio `sent`). */
  recordSent?: typeof recordSent;
}

export interface SendInput {
  /** From the session only. */
  supplierId: string;
  draftId: string;
  today: CalendarDate;
  channel: "twilio_sandbox" | "wa_me";
}

export type SendOutcome =
  | { kind: "sent" }
  | { kind: "handed_off"; url: string }
  | { kind: "not_found" }
  | { kind: "cannot_send" }
  | { kind: "approved_on"; approvalDay: CalendarDate }
  | { kind: "send_check_failed"; decision: EscalationDecision }
  | { kind: "payments_not_configured" }
  | { kind: "pay_link_failed" }
  | { kind: "no_buyer_number" }
  | { kind: "sender_not_configured" }
  | { kind: "too_long" }
  | { kind: "channel_failed"; errorKind: ChannelErrorKind; errorCode: string }
  | { kind: "record_failed" };

/** One Tool_Log row's `input` and `output`. */
export interface ToolPayload {
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}

/** `find_payment_link` row. Holds ids and the lookup result only. */
export function findPayLinkPayload(args: {
  invoiceId: string;
  draftId: string;
  result: RazorpayResult<PayLinkInfo | null>;
}): ToolPayload {
  const { result } = args;
  return {
    input: { invoiceId: args.invoiceId, draftId: args.draftId, referenceId: args.draftId },
    output: !result.ok
      ? { ok: false, errorKind: result.errorKind, httpStatus: result.httpStatus }
      : result.value === null
        ? { ok: true, found: false }
        : { ok: true, found: true, providerLinkId: result.value.providerLinkId, url: result.value.url },
  };
}

/** `create_payment_link` row. The request body holds no secret and no phone number. */
export function createPayLinkPayload(args: {
  invoiceId: string;
  draftId: string;
  body: CreateLinkBody;
  result: RazorpayResult<PayLinkInfo>;
}): ToolPayload {
  const { result } = args;
  return {
    input: { invoiceId: args.invoiceId, draftId: args.draftId, body: args.body },
    output: result.ok
      ? { ok: true, providerLinkId: result.value.providerLinkId, url: result.value.url }
      : { ok: false, errorKind: result.errorKind, httpStatus: result.httpStatus },
  };
}

/**
 * `send_whatsapp` row. The number appears only through `maskNumber`. A handoff logs `{ kind: "handoff" }`
 * and never its URL (the URL carries the whole number). No header, SID or token is passed in.
 */
export function sendWhatsappPayload(args: {
  invoiceId: string;
  draftId: string;
  channel: "twilio_sandbox" | "wa_me";
  text: string;
  buyerNumber: string | null;
  result: ChannelResult;
}): ToolPayload {
  const { result } = args;
  const input = {
    invoiceId: args.invoiceId,
    draftId: args.draftId,
    channel: args.channel,
    text: args.text,
    to: args.buyerNumber === null ? null : maskNumber(args.buyerNumber),
  };
  switch (result.kind) {
    case "sent":
      return { input, output: { kind: "sent", providerMessageId: result.providerMessageId, polls: result.polls } };
    case "handoff":
      return { input, output: { kind: "handoff" } };
    case "failed":
      return {
        input,
        output: {
          kind: "failed",
          errorKind: result.errorKind,
          errorCode: result.errorCode,
          providerMessageId: result.providerMessageId,
          polls: result.polls,
        },
      };
  }
}

/** The Draft's stored rule IDs were validated against `RULE_IDS` when it was written. */
function toRuleIds(ids: readonly string[]): RuleId[] {
  return ids.filter((id): id is RuleId => (RULE_IDS as readonly string[]).includes(id));
}

/** Step 4: the Engine Decision for Today, without the Draft's own approved event. One Tool_Log row. */
async function sendCheck(db: Db, ctx: SendContext, today: CalendarDate): Promise<EscalationDecision | null> {
  const history = sendCheckHistory(ctx.record, ctx.draft.id);
  const input = { invoice: ctx.record.invoice, history, today, config: DEFAULT_LADDER_CONFIG };
  let decision: EscalationDecision;
  try {
    decision = nextEscalationStep(ctx.record.invoice, history, today, DEFAULT_LADDER_CONFIG);
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    await logToolCall(db, {
      tool: "next_escalation_step",
      invoiceId: ctx.record.invoice.id,
      input,
      output: { error: "ValidationError", field: err.field, message: err.message },
    });
    return null;
  }
  await logToolCall(db, { tool: "next_escalation_step", invoiceId: ctx.record.invoice.id, input, output: decision });
  return decision;
}

/**
 * Step 8: the stored Pay_Link, else a lookup, else a create (then a lookup again on `already_attempted`).
 * A link whose amount differs from the invoice's is `"failed"`. If another request stores its link first,
 * the stored link is used. `"duplicate"` is returned only if that link cannot be read back.
 */
async function resolvePayLink(
  deps: SendDeps & { razorpay: RazorpayClient },
  ctx: SendContext,
  supplierId: string,
  today: CalendarDate,
): Promise<PayLinkInfo | "failed" | "duplicate"> {
  const { db, razorpay } = deps;
  const invoiceId = ctx.draft.invoiceId;
  const draftId = ctx.draft.id;
  if (ctx.payLink !== null) {
    // A stored link for a different amount must never reach the buyer.
    if (ctx.payLink.amountPaise !== ctx.invoice.amountPaise) return "failed";
    return {
      providerLinkId: ctx.payLink.providerLinkId,
      url: ctx.payLink.url,
      amountPaise: ctx.payLink.amountPaise,
    };
  }

  const lookup = async (): Promise<RazorpayResult<PayLinkInfo | null>> => {
    const result = await razorpay.findByReference(draftId);
    const payload = findPayLinkPayload({ invoiceId, draftId, result });
    await logToolCall(db, { tool: "find_payment_link", invoiceId, ...payload });
    return result;
  };

  let link: PayLinkInfo | null;
  const found = await lookup();
  if (!found.ok) return "failed";
  link = found.value;

  if (link === null) {
    const body: CreateLinkBody = {
      amount: ctx.invoice.amountPaise,
      currency: "INR",
      accept_partial: false,
      reference_id: draftId,
      notes: { invoice_id: invoiceId },
      notify: { sms: false, email: false },
    };
    const created = await razorpay.create(body);
    const payload = createPayLinkPayload({ invoiceId, draftId, body, result: created });
    await logToolCall(db, { tool: "create_payment_link", invoiceId, ...payload });
    if (created.ok) {
      link = created.value;
    } else if (created.errorKind === "already_attempted") {
      const again = await lookup();
      if (!again.ok || again.value === null) return "failed";
      link = again.value;
    } else {
      return "failed";
    }
  }

  // A link Razorpay returned for another amount is neither stored nor sent.
  if (link.amountPaise !== ctx.invoice.amountPaise) return "failed";
  const stored = await insertPayLink(db, { invoiceId, draftId, link, createdOn: today });
  if (stored === "ok") return link;
  // Another request stored its link first: continue with the stored one (the unique index makes it the only one).
  const winner = await getPayLinkForDraft(db, supplierId, draftId);
  if (winner === null) return "duplicate";
  if (winner.amountPaise !== ctx.invoice.amountPaise) return "failed";
  return { providerLinkId: winner.providerLinkId, url: winner.url, amountPaise: winner.amountPaise };
}

/**
 * Sends one approved WhatsApp Draft: the 12 steps of design.md "Send flow", in order. The first
 * failure ends the request. The send claim is taken at step 7 and released on every failure from
 * step 8 on, except when Twilio said `sent` and the record could not be written (releasing would let
 * a retry message the buyer twice; the claim then expires with its lease).
 *
 * Expected failures come back as a `SendOutcome`. An unexpected database error releases the claim
 * (same exception) and propagates.
 */
export async function sendDraft(deps: SendDeps, input: SendInput): Promise<SendOutcome> {
  const { db } = deps;
  const { supplierId, draftId, today, channel } = input;

  // 1. Same result for a non-uuid, an unknown id and another supplier's Draft.
  if (!UUID.test(draftId)) return { kind: "not_found" };
  const ctx = await getSendContext(db, supplierId, draftId);
  if (ctx === null) return { kind: "not_found" };

  // 2. Approved WhatsApp Draft with no Sent_Message.
  const { draft } = ctx;
  const sendableStep = draft.step === "whatsapp_nudge" || draft.step === "whatsapp_paylink";
  if (draft.status !== "approved" || !sendableStep || ctx.hasSentMessage || ctx.approvalDay === null) {
    return { kind: "cannot_send" };
  }

  // 3. The Draft's figures are as of its approval day.
  if (today !== ctx.approvalDay) return { kind: "approved_on", approvalDay: ctx.approvalDay };

  // 4. Send_Check (one Tool_Log row). An invoice the Engine now rejects can't be sent.
  const decision = await sendCheck(db, ctx, today);
  if (decision === null) return { kind: "cannot_send" };
  if (decision.action !== "advance" || decision.step !== draft.step) {
    return { kind: "send_check_failed", decision };
  }

  // 5. Test-mode Razorpay only.
  const razorpay = deps.razorpay;
  if (razorpay === null) return { kind: "payments_not_configured" };

  // 6. Twilio only: a buyer number and a configured sender.
  const buyerNumber: E164 | null = parseE164(ctx.buyerNumber);
  let channelImpl: MessageChannel;
  if (channel === "twilio_sandbox") {
    if (buyerNumber === null) return { kind: "no_buyer_number" };
    if (deps.twilio === null) return { kind: "sender_not_configured" };
    channelImpl = deps.twilio;
  } else {
    channelImpl = deps.waMe;
  }

  // A body with two or more Pay_Link_Markers can never become a valid Outbound_Text (step 9). Refuse it
  // before the claim so that no Razorpay call is made and no Pay_Link is stored for it.
  if (draft.bodyText.split(PAY_LINK_TEXT).length > 2) return { kind: "cannot_send" };

  // 7. The send claim: only one overlapping request gets past here.
  if (!(await claimSend(db, supplierId, draftId))) return { kind: "cannot_send" };

  let keepClaim = false;
  const fail = async <T extends SendOutcome>(outcome: T): Promise<T> => {
    await releaseSend(db, draftId);
    return outcome;
  };

  try {
    // 8. Pay_Link.
    const link = await resolvePayLink({ ...deps, razorpay }, ctx, supplierId, today);
    if (link === "failed") return await fail({ kind: "pay_link_failed" });
    if (link === "duplicate") return await fail({ kind: "cannot_send" });

    // 9. Outbound_Text.
    const built = buildOutboundText({
      body: draft.bodyText,
      ruleIds: toRuleIds(draft.ruleIds),
      url: link.url,
      amountPaise: ctx.invoice.amountPaise,
    });
    if (!built.ok) return await fail({ kind: "cannot_send" });
    const text = built.text;

    // 10. Twilio only: WhatsApp's length limit.
    if (channel === "twilio_sandbox" && text.length > MAX_OUTBOUND_LENGTH) return await fail({ kind: "too_long" });

    // 11. The channel call and its one Tool_Log row.
    const result = await channelImpl.send({ to: buyerNumber, text, idempotencyKey: draftId });
    if (channel === "twilio_sandbox" && result.kind === "sent") keepClaim = true;
    const payload = sendWhatsappPayload({
      invoiceId: draft.invoiceId,
      draftId,
      channel,
      text,
      buyerNumber,
      result,
    });
    await logToolCall(db, { tool: "send_whatsapp", invoiceId: draft.invoiceId, ...payload });

    if (result.kind === "failed") {
      if (channel === "twilio_sandbox") {
        await insertFailedMessage(db, {
          invoiceId: draft.invoiceId,
          draftId,
          text,
          errorCode: result.errorCode,
          providerMessageId: result.providerMessageId,
        });
      }
      return await fail({ kind: "channel_failed", errorKind: result.errorKind, errorCode: result.errorCode });
    }

    // 12. Message_Row and `sent` event in one transaction.
    let recorded: "ok" | "duplicate";
    try {
      recorded = await (deps.recordSent ?? recordSent)(db, {
        invoiceId: draft.invoiceId,
        draftId,
        step: draft.step,
        today,
        channel,
        text,
        providerMessageId: result.kind === "sent" ? result.providerMessageId : null,
      });
    } catch {
      // A Twilio `sent` keeps the claim (`keepClaim`); a handoff releases it so the owner can retry.
      if (keepClaim) return { kind: "record_failed" };
      return await fail({ kind: "record_failed" });
    }
    if (recorded === "duplicate") {
      keepClaim = false;
      return await fail({ kind: "cannot_send" });
    }
    return result.kind === "sent" ? { kind: "sent" } : { kind: "handed_off", url: result.url };
  } catch (error) {
    if (!keepClaim) {
      try {
        await releaseSend(db, draftId);
      } catch {
        // The original error matters more; the claim expires with its lease.
      }
    }
    throw error;
  }
}
