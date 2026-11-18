import {
  findPayLinkByProviderId,
  logToolCall,
  markPayLinkPaid,
  recordWebhookEvent,
  setPaidOnIfNull,
} from "@dues-banshee/db";
import type { Db, PayLinkMatch } from "@dues-banshee/db";
import { istCalendarDate } from "@dues-banshee/engine";
import type { ChannelEnv } from "../channel/env";
import { classifyRazorpayEvent, parseRazorpayEvent, paymentDay } from "./razorpay-event";
import type { ParsedRazorpayEvent, RazorpayOutcome } from "./razorpay-event";
import { razorpaySignatureValid } from "./razorpay-signature";
import { jsonResponse } from "./response";
import type { WebhookResponse } from "./response";

/** The outcomes written to the `razorpay_webhook` Tool_Log row: the classifier's plus `duplicate` (Req 6.8). */
export type RazorpayLogOutcome = RazorpayOutcome | "duplicate";

export interface RazorpayWebhookDeps {
  db: Db;
  env: ChannelEnv;
  /**
   * True for the demo supplier, whose Payment_Day is the day its link was created. It may query the
   * database, so the handler calls it only for a signature-verified, new, matching paid event.
   */
  isDemoSupplier: (supplierId: string) => boolean | Promise<boolean>;
}

export interface RazorpayWebhookRequest {
  /** The raw request text, read before any JSON parsing (Req 6.11). */
  rawBody: string;
  /** The `X-Razorpay-Signature` header, or `null` when absent. */
  signature: string | null;
  /** The `x-razorpay-event-id` header, or `null` when absent. */
  eventId: string | null;
}

/** The Tool_Log row of one signature-verified delivery. Holds no secret and no raw body. */
export function razorpayWebhookPayload(args: {
  eventId: string | null;
  eventType: string | null;
  payLinkId: string | null;
  amountPaidPaise: number | null;
  outcome: RazorpayLogOutcome;
}): { input: unknown; output: unknown } {
  return {
    input: { eventId: args.eventId, eventType: args.eventType },
    output: { payLinkId: args.payLinkId, amountPaid: args.amountPaidPaise, outcome: args.outcome },
  };
}

const ERROR_INTERNAL = { error: "internal" };

/** Reads the body as JSON. `ok: false` when it is not valid JSON. */
function parseJson(rawBody: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(rawBody) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Writes the one Tool_Log row of a delivery that never reaches the transaction (the 400 cases). */
async function logOnly(db: Db, row: { eventId: string | null; outcome: RazorpayLogOutcome }): Promise<void> {
  try {
    const payload = razorpayWebhookPayload({
      eventId: row.eventId,
      eventType: null,
      payLinkId: null,
      amountPaidPaise: null,
      outcome: row.outcome,
    });
    await logToolCall(db, { tool: "razorpay_webhook", invoiceId: null, ...payload });
  } catch (error) {
    // The 400 stands even when the log write fails. Name only, never the message (it can hold SQL).
    console.error("razorpay webhook: tool log write failed", errorName(error));
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

/**
 * Handles one Razorpay webhook delivery (Req 6). Order: secret (503), signature (401), body and
 * event id (400), then one transaction that records the event id, applies the payment and writes
 * the Tool_Log row last. Any error inside the transaction rolls all of it back and returns 500
 * `{"error":"internal"}`, so Razorpay's retry of the same event id is processed as new.
 */
export async function handleRazorpayWebhook(
  deps: RazorpayWebhookDeps,
  req: RazorpayWebhookRequest,
): Promise<WebhookResponse> {
  const secret = deps.env.razorpayWebhookSecret;
  if (secret === undefined) return jsonResponse(503, { error: "not_configured" });
  if (!razorpaySignatureValid(req.rawBody, req.signature, secret)) {
    return jsonResponse(401, { error: "invalid_signature" });
  }

  const eventId = req.eventId !== null && req.eventId.trim() !== "" ? req.eventId : null;
  const json = parseJson(req.rawBody);
  if (!json.ok || eventId === null) {
    await logOnly(deps.db, { eventId, outcome: "invalid_payload" });
    return jsonResponse(400, { error: "bad_request" });
  }

  const event = parseRazorpayEvent(json.value);

  try {
    const revalidateBuyerId = await deps.db.transaction(async (tx) => {
      const isNew = await recordWebhookEvent(tx, "razorpay", eventId);
      if (!isNew) {
        await writeLog(tx, eventId, event, null, "duplicate");
        return null;
      }

      const link = event.paid === null ? null : await findPayLinkByProviderId(tx, event.paid.linkId);
      const outcome = classifyRazorpayEvent(event, link);

      let changedBuyerId: string | null = null;
      if (link !== null && event.paid !== null && (outcome === "paid" || outcome === "already_paid")) {
        await markPayLinkPaid(tx, link.payLinkId);
        if (outcome === "paid") {
          const day = paymentDay(
            await deps.isDemoSupplier(link.supplierId),
            // Rows from before migration 0003 have no created_on: use the payment's own IST day.
            link.createdOn ?? istCalendarDate(event.paid.paymentCreatedAtSec * 1000),
            event.paid.paymentCreatedAtSec,
          );
          if (await setPaidOnIfNull(tx, link.invoiceId, day)) changedBuyerId = link.buyerId;
        }
      }

      await writeLog(tx, eventId, event, link, outcome);
      return changedBuyerId;
    });
    return jsonResponse(200, { status: "ok" }, revalidateBuyerId);
  } catch (error) {
    // Name only: driver errors can carry SQL text and parameters.
    console.error("razorpay webhook: transaction failed", errorName(error));
    return jsonResponse(500, ERROR_INTERNAL);
  }
}

async function writeLog(
  tx: Db,
  eventId: string,
  event: ParsedRazorpayEvent,
  link: PayLinkMatch | null,
  outcome: RazorpayLogOutcome,
): Promise<void> {
  const payload = razorpayWebhookPayload({
    eventId,
    eventType: event.type,
    payLinkId: link?.payLinkId ?? null,
    amountPaidPaise: event.paid?.amountPaidPaise ?? null,
    outcome,
  });
  await logToolCall(tx, { tool: "razorpay_webhook", invoiceId: link?.invoiceId ?? null, ...payload });
}
