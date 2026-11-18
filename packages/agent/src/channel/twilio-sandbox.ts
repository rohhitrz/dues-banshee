import { z } from "zod";
import type { ChannelErrorKind, ChannelResult, MessageChannel, PollRecord, SendRequest } from "./message-channel";

/** Cap for the create request (Req 1.7). */
export const CREATE_TIMEOUT_MS = 10_000;
/** Cap for one status poll. */
export const POLL_TIMEOUT_MS = 1_000;
/** The `sleep` before poll 2 and before poll 3. Not before poll 1. */
export const POLL_INTERVAL_MS = 2_000;
export const MAX_POLLS = 3;

const API_BASE = "https://api.twilio.com/2010-04-01/Accounts";

/** The `fetch` shape this channel needs. `globalThis.fetch` and the `fakeHttp` fetch both fit. */
export type TwilioFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface TwilioSandboxOptions {
  fetch: TwilioFetch;
  /** Defaults to a `setTimeout` promise. */
  sleep?: (ms: number) => Promise<void>;
  /** Defaults to `AbortSignal.timeout`. */
  timeoutSignal?: (ms: number) => AbortSignal;
  accountSid: string;
  authToken: string;
  /** The sandbox sender number, E.164 without the `whatsapp:` prefix. */
  from: string;
}

/** Twilio error body: `code` is a number, read leniently so a string code also works. */
const ErrorBody = z.object({ code: z.union([z.number(), z.string()]).nullish() });
/** `sid` of a created message. */
const CreatedBody = z.object({ sid: z.string().min(1) });
/** The two fields of the Message resource the polls read. */
const StatusBody = z.object({ status: z.string(), error_code: z.number().nullish() });

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const defaultTimeoutSignal = (ms: number): AbortSignal => AbortSignal.timeout(ms);

/** Twilio 63015 (recipient has not joined the sandbox) and 63016 (outside the 24-hour window). */
function kindForCode(code: string): ChannelErrorKind {
  return code === "63015" || code === "63016" ? "sandbox_window" : "provider_error";
}

function isTimeout(err: unknown): boolean {
  return typeof err === "object" && err !== null && "name" in err && (err.name === "AbortError" || err.name === "TimeoutError");
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function failed(
  errorKind: ChannelErrorKind,
  errorCode: string,
  providerMessageId: string | null,
  polls: readonly PollRecord[],
): ChannelResult {
  return { kind: "failed", errorKind, errorCode, providerMessageId, polls };
}

/**
 * The primary sender: one form-encoded create POST (no retry), then, only after a 2xx with a `sid`, up to
 * three read-only status polls that catch the 63015/63016 errors Twilio usually reports after accepting
 * the message (Req 1.2, 1.3, 1.7). `send` never throws.
 */
export function createTwilioSandbox(options: TwilioSandboxOptions): MessageChannel {
  const { fetch: doFetch, accountSid, authToken, from } = options;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutSignal = options.timeoutSignal ?? defaultTimeoutSignal;
  const authorization = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
  const accountUrl = `${API_BASE}/${encodeURIComponent(accountSid)}`;

  async function poll(sid: string): Promise<{ record: PollRecord; status?: string; errorCode?: string }> {
    try {
      const res = await doFetch(`${accountUrl}/Messages/${encodeURIComponent(sid)}.json`, {
        method: "GET",
        headers: { authorization },
        signal: timeoutSignal(POLL_TIMEOUT_MS),
      });
      if (res.status < 200 || res.status > 299) {
        return { record: { error: "provider_error", httpStatus: res.status } };
      }
      const parsed = StatusBody.safeParse(await readJson(res));
      if (!parsed.success) return { record: { error: "provider_error", httpStatus: res.status } };
      const errorCode = parsed.data.error_code == null ? "" : String(parsed.data.error_code);
      return { record: { status: parsed.data.status, errorCode }, status: parsed.data.status, errorCode };
    } catch (err) {
      return { record: { error: isTimeout(err) ? "timeout" : "network", httpStatus: null } };
    }
  }

  async function sendOnce(req: SendRequest): Promise<ChannelResult> {
    if (req.to === null) return failed("no_recipient", "", null, []);

    let res: Response;
    try {
      res = await doFetch(`${accountUrl}/Messages.json`, {
        method: "POST",
        headers: { authorization, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ From: `whatsapp:${from}`, To: `whatsapp:${req.to}`, Body: req.text }),
        signal: timeoutSignal(CREATE_TIMEOUT_MS),
      });
    } catch (err) {
      return failed(isTimeout(err) ? "timeout" : "network", "", null, []);
    }

    const body = await readJson(res);
    if (res.status < 200 || res.status > 299) {
      const parsed = ErrorBody.safeParse(body);
      const code = parsed.success && parsed.data.code != null ? String(parsed.data.code) : "";
      return failed(kindForCode(code), code, null, []);
    }
    const created = CreatedBody.safeParse(body);
    if (!created.success) return failed("provider_error", "", null, []);
    const sid = created.data.sid;

    const polls: PollRecord[] = [];
    for (let i = 0; i < MAX_POLLS; i++) {
      if (i > 0) await sleep(POLL_INTERVAL_MS);
      const result = await poll(sid);
      polls.push(result.record);
      if (result.status === undefined) break; // a poll error ends polling; the message was accepted
      if (result.status === "failed" || result.status === "undelivered") {
        const code = result.errorCode ?? "";
        return failed(kindForCode(code), code, sid, polls);
      }
    }
    return { kind: "sent", providerMessageId: sid, polls };
  }

  return {
    name: "twilio_sandbox",
    async send(req) {
      try {
        return await sendOnce(req);
      } catch {
        return failed("network", "", null, []);
      }
    },
  };
}
