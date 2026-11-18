import { parseE164 } from "./message-channel";
import type { E164 } from "./message-channel";

/**
 * The Channel_Env values, typed. A value that is missing, blank or malformed is `undefined` (or its
 * group is `null`), so callers test one field to know whether a control or route is switched on
 * (Req 8.4). Holds secrets: it never reaches a client component.
 */
export interface ChannelEnv {
  /** All of SID, token and an E.164 `TWILIO_WHATSAPP_FROM` (without `whatsapp:`) are set, else `null`. */
  twilio: { accountSid: string; authToken: string; from: E164 } | null;
  /** The inbound webhook needs only this and `publicBaseUrl`. */
  twilioAuthToken: string | undefined;
  /** Both keys are set and the key id starts with `rzp_test_` (test mode only), else `null`. */
  razorpay: { keyId: string; keySecret: string } | null;
  razorpayWebhookSecret: string | undefined;
  /** With any trailing `/` removed. */
  publicBaseUrl: string | undefined;
  /** The code only, without the word `join`. */
  sandboxJoinCode: string | undefined;
}

const TEST_KEY_PREFIX = "rzp_test_";

/** The trimmed value, or `undefined` when it is missing or blank. */
function read(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/** Reads the Channel_Env from the given map only (pass `process.env` per request, Req 8.1). Pure. */
export function readChannelEnv(env: Readonly<Record<string, string | undefined>>): ChannelEnv {
  const accountSid = read(env, "TWILIO_ACCOUNT_SID");
  const authToken = read(env, "TWILIO_AUTH_TOKEN");
  const from = parseE164(read(env, "TWILIO_WHATSAPP_FROM"));
  const keyId = read(env, "RAZORPAY_KEY_ID");
  const keySecret = read(env, "RAZORPAY_KEY_SECRET");
  const baseUrl = read(env, "PUBLIC_BASE_URL")?.replace(/\/+$/, "");
  return {
    twilio:
      accountSid !== undefined && authToken !== undefined && from !== null
        ? { accountSid, authToken, from }
        : null,
    twilioAuthToken: authToken,
    razorpay:
      keyId !== undefined && keySecret !== undefined && keyId.startsWith(TEST_KEY_PREFIX)
        ? { keyId, keySecret }
        : null,
    razorpayWebhookSecret: read(env, "RAZORPAY_WEBHOOK_SECRET"),
    publicBaseUrl: baseUrl === "" ? undefined : baseUrl,
    sandboxJoinCode: read(env, "TWILIO_SANDBOX_JOIN_CODE"),
  };
}
