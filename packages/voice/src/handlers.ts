import { claimJoin, endVoiceCall, getCallContext } from "@dues-banshee/db";
import type { Db } from "@dues-banshee/db";
import { buildPersonaInstructions } from "./persona";
import type { VoiceProvider } from "./provider";
import { CALL_TOOLS } from "./tool-schemas";
import { hashToken } from "./token";

/** Call_Cap: a call lasts at most 300 seconds from `started_at`. */
const CALL_CAP_MS = 300_000;

/**
 * What a voice handler hands back to its route file. The route turns it into a `Response`
 * (`Cache-Control: no-store`, JSON body). Plain data, same idea as `WebhookResponse` in the agent package.
 */
export interface VoiceHandlerResponse<Body> {
  status: 200 | 404 | 500 | 502 | 503;
  body: Body;
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
