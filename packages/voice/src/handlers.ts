import {
  BankRateNotFoundError,
  claimJoin,
  claimToolCall,
  endStaleCalls,
  endVoiceCall,
  findCallByIdAndHash,
  getBankRate,
  getCallContext,
  insertTranscriptLine,
  lockLiveCall,
  logToolCall,
  recordVoicePromise,
  setRequestedOutcome,
  storeToolResult,
} from "@dues-banshee/db";
import type { Db, TranscriptSpeaker } from "@dues-banshee/db";
import type { BankRate, CalendarDate } from "@dues-banshee/engine";
import { agentDate, inPromiseWindow, promiseWindow } from "./dates";
import { buildInvoiceFacts, checkPromiseAmount } from "./invoice-facts";
import { buildPersonaInstructions } from "./persona";
import type { VoiceProvider } from "./provider";
import { paiseToWords } from "./rupee-words";
import { CALL_TOOLS, parseToolArgs } from "./tool-schemas";
import { hashToken } from "./token";

/** Call_Cap: a call lasts at most 300 seconds from `started_at`. */
const CALL_CAP_MS = 300_000;
/** A live call with no End_Report this long after the Call_Cap is ended with `ended_at` = the cap. */
const STALE_GRACE_MS = 60_000;
/** The Realtime `call_id` shape the `voice_tool_calls` check constraint accepts (design open item 3). */
const CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * What a voice handler hands back to its route file. The route turns it into a `Response`
 * (`Cache-Control: no-store`, JSON body). Plain data, same idea as `WebhookResponse` in the agent package.
 */
export interface VoiceHandlerResponse<Body> {
  status: 200 | 404 | 500 | 502 | 503;
  body: Body;
  /** Set when the handler changed what the Debtor_Page shows; the route calls `revalidatePath` for it. */
  revalidateBuyerId?: string;
}

/** The success body of the Session_Endpoint. `ephemeralKey` appears here and nowhere else. */
export interface SessionSuccessBody {
  ephemeralKey: string;
  /** Unix seconds, as returned by the provider. */
  expiresAt: number;
  voiceCallId: string;
  /** Where the browser posts its SDP offer. */
  connectUrl: string;
  /** ISO 8601 instant: `started_at` + 300 s. */
  capEndsAt: string;
}

export type SessionErrorBody =
  | { error: "not_configured" }
  | { error: "expired" }
  | { error: "start_failed" }
  | { error: "internal" };

export type SessionResponse = VoiceHandlerResponse<SessionSuccessBody | SessionErrorBody>;

export interface SessionDeps {
  db: Db;
  provider: VoiceProvider;
  /** The current instant. Route files pass `new Date()`. */
  now: Date;
  /** True when `OPENAI_API_KEY` is set and not empty. Checked first; the row stays unchanged when false. */
  apiKeyConfigured: boolean;
}

function fail<B extends SessionErrorBody>(status: SessionResponse["status"], body: B): SessionResponse {
  return { status, body };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

/**
 * Handles one join (Req 2.4, 2.5, 3.1, 3.5). Order: key configured (503, no write), atomic
 * `claimJoin` (404 when it claims nothing, no mint), persona from the stored row, one `mintKey`.
 * A mint failure ends the call as `incomplete` and returns 502. Never logs or returns the standard
 * key, and the Ephemeral_Key only in the success body.
 */
export async function handleSession(deps: SessionDeps, req: { token: string }): Promise<SessionResponse> {
  if (!deps.apiKeyConfigured) return fail(503, { error: "not_configured" });
  if (req.token === "") return fail(404, { error: "expired" });

  try {
    const claim = await claimJoin(deps.db, hashToken(req.token), deps.now);
    if (claim === null) return fail(404, { error: "expired" });

    const ctx = await getCallContext(deps.db, claim.voiceCallId);
    if (ctx === null) {
      await endVoiceCall(deps.db, claim.voiceCallId, deps.now);
      return fail(502, { error: "start_failed" });
    }

    const instructions = buildPersonaInstructions({
      supplierName: ctx.supplierName,
      buyerName: ctx.buyerName,
      invoiceNumber: ctx.invoiceNumber,
      callToday: ctx.callToday,
    });
    const minted = await deps.provider.mintKey({ instructions, tools: CALL_TOOLS });
    if (!minted.ok) {
      await endVoiceCall(deps.db, claim.voiceCallId, deps.now);
      return fail(502, { error: "start_failed" });
    }

    const startedAt = ctx.startedAt ?? deps.now;
    return {
      status: 200,
      body: {
        ephemeralKey: minted.value,
        expiresAt: minted.expiresAt,
        voiceCallId: claim.voiceCallId,
        connectUrl: deps.provider.connectUrl,
        capEndsAt: new Date(startedAt.getTime() + CALL_CAP_MS).toISOString(),
      },
    };
  } catch (error) {
    // Name only: driver errors can carry SQL text and parameters.
    console.error("voice session: failed", errorName(error));
    return fail(500, { error: "internal" });
  }
}

// ---------------------------------------------------------------------------------------------
// Tool, transcript and end handlers (Req 5, 7, 8)
// ---------------------------------------------------------------------------------------------

/** The JSON a Call_Tool returns to the model (`ok` plus data, or `ok: false` plus `error` and `message`). */
export type ToolResult = Record<string, unknown>;

export type ToolErrorBody = { error: "not_found" } | { error: "internal" };
export type ToolResponse = VoiceHandlerResponse<ToolResult | ToolErrorBody>;

export interface ToolDeps {
  db: Db;
  /** The current instant. Route files pass `new Date()`. */
  now: Date;
}

/**
 * One tool request. Only these fields are read: the invoice, supplier and `call_today` come from
 * the Voice_Call row, so anything else a client sends is dropped before it gets here.
 */
export interface ToolRequest {
  voiceCallId: string;
  token: string;
  callId: string;
  name: string;
  /** The raw arguments string of the function call. */
  arguments: string;
}

async function bankRateOrNull(db: Db, day: CalendarDate): Promise<BankRate | null> {
  try {
    return await getBankRate(db, day);
  } catch (error) {
    if (error instanceof BankRateNotFoundError) return null;
    throw error;
  }
}

/**
 * Runs one Call_Tool in one transaction, checks in the order of Req 5 C3: live call match (404, no
 * Tool_Log), Call_Cap, repeated `call_id`, tool name and schema, then the tool itself. Every request
 * past the 404 check writes one Tool_Log row, including rejected, repeated and `call_time_up` ones.
 * A failure rolls the whole request back (claim included), so the client can retry the `call_id`.
 */
export async function runCallTool(deps: ToolDeps, req: ToolRequest): Promise<ToolResponse> {
  const { db, now } = deps;
  try {
    return await db.transaction(async (tx): Promise<ToolResponse> => {
      const live = await lockLiveCall(tx, req.voiceCallId, hashToken(req.token));
      if (live === null) return { status: 404, body: { error: "not_found" } };

      const finish = async (result: ToolResult, revalidateBuyerId?: string): Promise<ToolResponse> => {
        await logToolCall(tx, {
          tool: req.name,
          invoiceId: live.invoiceId,
          input: { voiceCallId: live.voiceCallId, callId: req.callId, arguments: req.arguments },
          output: result,
        });
        return revalidateBuyerId === undefined
          ? { status: 200, body: result }
          : { status: 200, body: result, revalidateBuyerId };
      };

      // Call_Cap: at or after started_at + 300 s run no tool and end the call. Past the 60 s stale
      // grace the end time is the cap itself, as the stale rule says.
      const capEnd = live.startedAt.getTime() + CALL_CAP_MS;
      if (now.getTime() >= capEnd) {
        const endedAt = now.getTime() < capEnd + STALE_GRACE_MS ? now : new Date(capEnd);
        await endVoiceCall(tx, live.voiceCallId, endedAt);
        return finish(
          { ok: false, error: "call_time_up", message: "The call time is over. Say goodbye and end the call." },
          live.buyerId,
        );
      }

      if (!CALL_ID_PATTERN.test(req.callId)) {
        return finish({ ok: false, error: "invalid_arguments", message: "The call_id is not valid." });
      }

      const claim = await claimToolCall(tx, {
        voiceCallId: live.voiceCallId,
        callId: req.callId,
        tool: req.name,
        arguments: req.arguments,
        now,
      });
      if (claim.kind === "repeat") {
        if (typeof claim.result !== "object" || claim.result === null || Array.isArray(claim.result)) {
          throw new Error("runCallTool: repeated call_id has no stored result");
        }
        return finish(claim.result as ToolResult);
      }

      // A tool without arguments (get_invoice_facts) may arrive with an empty string.
      const raw = req.arguments.trim() === "" ? "{}" : req.arguments;
      const parsed = parseToolArgs(req.name, raw);

      let result: ToolResult;
      let revalidateBuyerId: string | undefined;
      if (!parsed.ok) {
        result =
          parsed.error === "unknown_tool"
            ? { ok: false, error: "unknown_tool", message: "There is no tool with that name." }
            : { ok: false, error: "invalid_arguments", message: "The arguments do not match the tool's schema." };
      } else if (parsed.name === "end_call") {
        await setRequestedOutcome(tx, live.voiceCallId, parsed.args.outcome);
        result = { ok: true };
      } else {
        // get_invoice_facts and record_promise_to_pay both need the facts of the stored invoice.
        const ctx = await getCallContext(tx, live.voiceCallId);
        if (ctx === null) throw new Error("runCallTool: live call has no context");
        const built = buildInvoiceFacts({
          invoice: ctx.invoice,
          bankRate: await bankRateOrNull(tx, live.callToday),
          callToday: live.callToday,
          buyerName: ctx.buyerName,
          supplierName: ctx.supplierName,
          invoiceNumber: ctx.invoiceNumber,
        });

        if (!built.ok) {
          result = {
            ok: false,
            error: "bank_rate_missing",
            message: "The interest figure is not available right now. Do not state interest or a total.",
            ...(parsed.name === "get_invoice_facts" ? built.facts : {}),
          };
        } else if (parsed.name === "get_invoice_facts") {
          result = { ok: true, ...built.facts };
        } else {
          const { amount_paise, date_iso, spoken_text } = parsed.args;
          const amount = checkPromiseAmount(amount_paise, built.totalDuePaise);
          if (!amount.ok) {
            result = {
              ok: false,
              error: "amount_out_of_range",
              message: "The amount must be more than zero and at most the total due.",
              total_due_words: built.facts.total_due_words,
              total_due_paise: built.totalDuePaise,
            };
          } else if (!inPromiseWindow(date_iso, live.callToday)) {
            const window = promiseWindow(live.callToday);
            result = {
              ok: false,
              error: "date_out_of_range",
              message: "The date must be one of the allowed dates.",
              first_date: agentDate(window.first),
              last_date: agentDate(window.last),
            };
          } else {
            await recordVoicePromise(tx, {
              voiceCallId: live.voiceCallId,
              invoiceId: live.invoiceId,
              callToday: live.callToday,
              promisedDate: date_iso,
              amountPaise: amount_paise,
              spokenText: spoken_text,
              isPartial: amount.isPartial,
              now,
            });
            result = {
              ok: true,
              amount_words: paiseToWords(amount_paise),
              date: agentDate(date_iso),
              is_partial: amount.isPartial,
            };
            revalidateBuyerId = live.buyerId;
          }
        }
      }

      await storeToolResult(tx, live.voiceCallId, req.callId, result);
      return finish(result, revalidateBuyerId);
    });
  } catch (error) {
    console.error("voice tool: failed", errorName(error));
    return { status: 500, body: { error: "internal" } };
  }
}

export interface CallReportDeps {
  db: Db;
  now: Date;
}

export type CallReportBody = { ok: true } | { error: "not_found" } | { error: "internal" };
export type CallReportResponse = VoiceHandlerResponse<CallReportBody>;

export interface TranscriptRequest {
  voiceCallId: string;
  token: string;
  /** The Realtime item id; one line is stored per id. */
  itemId: string;
  speaker: TranscriptSpeaker;
  text: string;
}

/**
 * Stores one Transcript_Line for a `live` call matched by id and token hash (else 404, nothing
 * stored). A stale call is ended first. Blank text answers 200 and stores nothing; longer text is cut
 * to 2,000 characters; a repeated item id is dropped (still 200). Text is stored as data only.
 */
export async function handleTranscript(deps: CallReportDeps, req: TranscriptRequest): Promise<CallReportResponse> {
  const { db, now } = deps;
  try {
    const staleBuyerIds = await endStaleCalls(db, now, { voiceCallId: req.voiceCallId });
    const revalidate = staleBuyerIds[0] === undefined ? {} : { revalidateBuyerId: staleBuyerIds[0] };

    const stored = await db.transaction(async (tx) => {
      const live = await lockLiveCall(tx, req.voiceCallId, hashToken(req.token));
      if (live === null) return false;
      await insertTranscriptLine(tx, {
        voiceCallId: live.voiceCallId,
        speaker: req.speaker,
        itemId: req.itemId,
        text: req.text,
        now,
      });
      return true;
    });
    if (!stored) return { status: 404, body: { error: "not_found" }, ...revalidate };
    return { status: 200, body: { ok: true }, ...revalidate };
  } catch (error) {
    console.error("voice transcript: failed", errorName(error));
    return { status: 500, body: { error: "internal" } };
  }
}

export interface EndRequest {
  voiceCallId: string;
  token: string;
}

/**
 * Handles an End_Report. A stale call is ended first (with `ended_at` = the cap). Then a `live` call
 * ends now; any other status answers 200 and changes nothing; no id + token-hash match answers 404.
 * The outcome is computed on the server by `endVoiceCall`; a client-sent outcome has no way in here.
 */
export async function handleEnd(deps: CallReportDeps, req: EndRequest): Promise<CallReportResponse> {
  const { db, now } = deps;
  try {
    const staleBuyerIds = await endStaleCalls(db, now, { voiceCallId: req.voiceCallId });
    let revalidateBuyerId = staleBuyerIds[0];

    const call = await findCallByIdAndHash(db, req.voiceCallId, hashToken(req.token));
    if (call === null) {
      return { status: 404, body: { error: "not_found" }, ...(revalidateBuyerId === undefined ? {} : { revalidateBuyerId }) };
    }
    if (call.status === "live") {
      const ended = await endVoiceCall(db, call.voiceCallId, now);
      if (ended !== null) revalidateBuyerId = ended.buyerId;
    }
    return { status: 200, body: { ok: true }, ...(revalidateBuyerId === undefined ? {} : { revalidateBuyerId }) };
  } catch (error) {
    console.error("voice end: failed", errorName(error));
    return { status: 500, body: { error: "internal" } };
  }
}
