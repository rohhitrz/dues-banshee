import { logToolCall, recordWebhookEvent } from "@dues-banshee/db";
import type { Db } from "@dues-banshee/db";
import twilio from "twilio";
import type { ChannelEnv } from "../channel/env";
import { maskNumber } from "../channel/mask";
import { jsonResponse } from "./response";
import type { WebhookResponse } from "./response";

/** The most `Body` characters kept in the Tool_Log row (Req 7.3). */
export const INBOUND_BODY_MAX = 1600;

/** The empty TwiML reply: no message goes back to the buyer (Req 7.3, 7.4). */
export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

const WEBHOOK_PATH = "/api/webhooks/twilio";

export interface TwilioInboundDeps {
  db: Db;
  env: ChannelEnv;
}

export interface TwilioInboundRequest {
  /** The POST form fields, as `name -> value`. */
  params: Record<string, string>;
  /** The `X-Twilio-Signature` header, or `null` when absent. */
  signature: string | null;
}

/** The `input` of one `whatsapp_inbound` Tool_Log row. The body is stored as untrusted data, never read as an instruction. */
export interface WhatsappInboundInput {
  messageSid: string;
  from: string;
  untrusted: { body: string };
}

/**
 * Builds the `whatsapp_inbound` row input (Req 7.3). The sender keeps only its last four digits
 * (the `whatsapp:` prefix is dropped first) and the body is cut to 1,600 characters. Pure.
 */
export function whatsappInboundPayload(params: Readonly<Record<string, string | undefined>>): WhatsappInboundInput {
  const from = (params["From"] ?? "").replace(/^whatsapp:/, "");
  return {
    messageSid: params["MessageSid"] ?? "",
    from: maskNumber(from),
    untrusted: { body: (params["Body"] ?? "").slice(0, INBOUND_BODY_MAX) },
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function twimlResponse(): WebhookResponse {
  return { status: 200, body: EMPTY_TWIML, contentType: "text/xml", revalidateBuyerId: null };
}

/**
 * Handles one Twilio inbound WhatsApp message (Req 7). Order: config (503), signature (401),
 * `MessageSid` (400), then one transaction that records the SID and writes one `whatsapp_inbound`
 * Tool_Log row. It sends no reply, makes no LLM call and writes no other table. A transaction
 * error rolls both rows back and returns 500 `{"error":"internal"}`, so Twilio's retry of the
 * same SID is processed as new.
 */
export async function handleTwilioInbound(
  deps: TwilioInboundDeps,
  req: TwilioInboundRequest,
): Promise<WebhookResponse> {
  const { twilioAuthToken: token, publicBaseUrl } = deps.env;
  if (token === undefined || token === "" || publicBaseUrl === undefined || publicBaseUrl === "") {
    return jsonResponse(503, { error: "not_configured" });
  }

  const url = `${publicBaseUrl}${WEBHOOK_PATH}`;
  if (req.signature === null || req.signature === "" || !twilio.validateRequest(token, req.signature, url, req.params)) {
    return jsonResponse(401, { error: "invalid_signature" });
  }

  const messageSid = req.params["MessageSid"];
  if (messageSid === undefined || messageSid === "") return jsonResponse(400, { error: "bad_request" });

  try {
    await deps.db.transaction(async (tx) => {
      const isNew = await recordWebhookEvent(tx, "twilio", messageSid);
      if (!isNew) return;
      await logToolCall(tx, {
        tool: "whatsapp_inbound",
        invoiceId: null,
        input: whatsappInboundPayload(req.params),
        output: null,
      });
    });
    return twimlResponse();
  } catch (error) {
    // Name only: driver errors can carry SQL text and parameters.
    console.error("twilio webhook: transaction failed", errorName(error));
    return jsonResponse(500, { error: "internal" });
  }
}
