/** E.164 as the Buyer_Number column and `TWILIO_WHATSAPP_FROM` accept it: `+`, a non-zero digit, 7 to 14 more digits. */
const E164_PATTERN = /^\+[1-9][0-9]{7,14}$/;

/** A validated E.164 number. Branded so only a string that passed `parseE164` reaches a channel. */
export type E164 = string & { readonly __e164: unique symbol };

/** The number itself when it is E.164, else `null` (also for `null`, `undefined` and any padded or prefixed value). */
export function parseE164(raw: string | null | undefined): E164 | null {
  if (typeof raw !== "string" || !E164_PATTERN.test(raw)) return null;
  return raw as E164;
}

export interface SendRequest {
  /** `null` only for the WaMe_Link, where the owner picks the contact (Req 4.4). */
  to: E164 | null;
  /** The Outbound_Text, sent unchanged. */
  text: string;
  /** The Draft id. The Twilio Messages API has no idempotency header, so this is logged only. */
  idempotencyKey: string;
}

/** One status poll, as logged in the `send_whatsapp` Tool_Log row. Holds no secret and no number. */
export type PollRecord =
  /** Twilio `status` and `error_code` (`""` when null). */
  | { status: string; errorCode: string }
  | { error: "timeout" | "network" | "provider_error"; httpStatus: number | null };

export type ChannelErrorKind =
  /** Twilio 63015 or 63016, from the create response or a status poll. */
  | "sandbox_window"
  /** Any other Twilio error response or polled `failed`/`undelivered` code. */
  | "provider_error"
  | "timeout"
  | "network"
  | "no_recipient";

export type ChannelResult =
  | { kind: "sent"; providerMessageId: string; polls: readonly PollRecord[] }
  | { kind: "handoff"; url: string }
  | {
      kind: "failed";
      errorKind: ChannelErrorKind;
      /** The provider error code, `""` when the provider returned none. */
      errorCode: string;
      /** The Twilio SID when the create call returned one (a failure found by a status poll), else `null`. */
      providerMessageId: string | null;
      /** `[]` when no poll ran. */
      polls: readonly PollRecord[];
    };

/** The one interface every WhatsApp sender implements (Req 1.1). */
export interface MessageChannel {
  /** Also the `messages.channel` value. */
  readonly name: "twilio_sandbox" | "wa_me";
  /** Never throws. */
  send(req: SendRequest): Promise<ChannelResult>;
}
