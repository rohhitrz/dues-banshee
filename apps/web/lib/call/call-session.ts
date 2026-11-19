/**
 * Browser side of a buyer call: mic, join request, WebRTC connect, countdown and the one guarded end.
 *
 * This file runs in the buyer's browser. It must not import server-only code (@dues-banshee/voice,
 * @dues-banshee/db, @dues-banshee/agent). Everything it touches (mic, peer connection, fetch, timers,
 * clock, audio element) is injected, so Node tests drive it with fakes: no jsdom, no WebRTC.
 *
 * The client never sends session settings (no `session.update`, instructions, tools, model, voice or
 * turn detection). The server put all of that into the ephemeral key. The only event it sends on its own
 * is one bare `response.create`, so the agent speaks first.
 */

import { routeRealtimeEvent } from "./realtime-events";

export const SESSION_URL = "/api/voice/session";
export const END_URL = "/api/voice/end";
export const TOOL_URL = "/api/voice/tool";
export const TRANSCRIPT_URL = "/api/voice/transcript";
export const DATA_CHANNEL_LABEL = "oai-events";
/** After a successful `end_call` output, the call ends on the next `response.done` or after this long. */
export const END_CALL_FALLBACK_MS = 10_000;

export const MIC_ERROR_TEXT = "Microphone access is needed for the call";
export const EXPIRED_TEXT = "This call link has expired or was already used";
export const START_ERROR_TEXT = "The call could not start. Please try again later.";
export const ENDED_TEXT = "The call has ended";

export const MIC_CONSTRAINTS = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
} as const;

/* Minimal structural shapes of the browser objects we use. The real ones satisfy them at runtime. */

export interface TrackLike {
  stop(): void;
}
export interface MediaStreamLike {
  getTracks(): TrackLike[];
}
export interface DataChannelLike {
  readyState: string;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}
export interface SessionDescriptionLike {
  type?: string;
  sdp?: string | undefined;
}
export interface PeerConnectionLike {
  connectionState: string;
  ontrack: ((event: { streams: readonly unknown[] }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  addTrack(track: TrackLike, stream: MediaStreamLike): unknown;
  createDataChannel(label: string): DataChannelLike;
  createOffer(): Promise<SessionDescriptionLike>;
  setLocalDescription(description: SessionDescriptionLike): Promise<void>;
  setRemoteDescription(description: { type: "answer"; sdp: string }): Promise<void>;
  close(): void;
}
export interface AudioElementLike {
  srcObject: unknown;
  play(): Promise<void> | void;
}
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
    keepalive?: boolean;
  },
) => Promise<FetchResponseLike>;

/** What the UI shows. `countdown` is set only while `live`. */
export type CallPhase = "connecting" | "live" | "ended" | "mic_error" | "expired" | "start_error";
export interface CallView {
  phase: CallPhase;
  /** `m:ss` time left to the call cap. */
  countdown?: string;
}

/**
 * What an extra data-channel message observer may do (`CallSessionDeps.onMessage`). The tool loop, the
 * transcript routing and the `end_call` arming are built into the session and do not need it.
 */
export interface CallContext {
  voiceCallId: string;
  token: string;
  fetch: FetchLike;
  /** Sends one JSON event on the data channel. Dropped if the channel is not open. */
  send(event: { type: string; [key: string]: unknown }): void;
  /** Runs the one guarded end (End_Report included). */
  end(): void;
}

export interface CallSessionDeps {
  token: string;
  audioEl: AudioElementLike;
  getUserMedia(constraints: typeof MIC_CONSTRAINTS): Promise<MediaStreamLike>;
  createPeerConnection(): PeerConnectionLike;
  fetch: FetchLike;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** Wall clock in ms. Used for the countdown only. */
  now(): number;
  onChange(view: CallView): void;
  /** Optional one-shot timer for the `end_call` fallback. Defaults to the global `setTimeout`. */
  setTimeout?(callback: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
  /** Optional observer, called for every data-channel message before the built-in routing. */
  onMessage?: (raw: string, context: CallContext) => void;
}

export interface CallSession {
  /** The user hung up. Runs the guarded end. */
  hangUp(): void;
  /** Settles when the connect sequence is over (live, failed or ended). Never rejects. */
  settled: Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `m:ss` for a number of seconds, never negative. */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(s / 60);
  const seconds = s % 60;
  return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
}

/** Whole seconds left until `capEndsAt` (ISO 8601). An unreadable instant counts as already over. */
export function secondsLeft(capEndsAt: string, nowMs: number): number {
  const capMs = Date.parse(capEndsAt);
  if (!Number.isFinite(capMs)) return 0;
  return Math.max(0, Math.ceil((capMs - nowMs) / 1000));
}

interface SessionResponse {
  ephemeralKey: string;
  voiceCallId: string;
  connectUrl: string;
  capEndsAt: string;
}

function parseSessionResponse(value: unknown): SessionResponse | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const { ephemeralKey, voiceCallId, connectUrl, capEndsAt } = v;
  if (
    typeof ephemeralKey !== "string" ||
    typeof voiceCallId !== "string" ||
    typeof connectUrl !== "string" ||
    typeof capEndsAt !== "string" ||
    !ephemeralKey ||
    !voiceCallId ||
    !connectUrl
  ) {
    return null;
  }
  return { ephemeralKey, voiceCallId, connectUrl, capEndsAt };
}

/**
 * Starts a call from the tap handler. Everything up to the first `await` runs synchronously in the tap:
 * the mic request and `play()` on the remote audio element, so mobile browsers allow both.
 * Returns at once; the connect sequence continues in the background and reports through `onChange`.
 */
export function startCallSession(deps: CallSessionDeps): CallSession {
  const { token, audioEl } = deps;

  let ended = false;
  let voiceCallId: string | null = null;
  let stream: MediaStreamLike | null = null;
  let pc: PeerConnectionLike | null = null;
  let channel: DataChannelLike | null = null;
  let timer: unknown = null;
  /** Set once a successful `end_call` output went out: the next `response.done` ends the call. */
  let endArmed = false;
  let armedTimer: unknown = null;

  // --- Synchronous part of the tap: audio unlock and mic request, before any await. ---
  deps.onChange({ phase: "connecting" });
  try {
    Promise.resolve(audioEl.play()).catch(() => {});
  } catch {
    // play() failing is not fatal: the remote stream is attached later.
  }
  let micRequest: Promise<MediaStreamLike>;
  try {
    micRequest = deps.getUserMedia(MIC_CONSTRAINTS);
  } catch (error) {
    micRequest = Promise.reject(error);
  }

  const stopMic = (): void => {
    for (const track of stream?.getTracks() ?? []) {
      try {
        track.stop();
      } catch {
        // Already stopped.
      }
    }
  };

  const stopTimer = (): void => {
    if (timer !== null) deps.clearInterval(timer);
    timer = null;
  };

  const clearArmedTimer = (): void => {
    if (armedTimer !== null) (deps.clearTimeout ?? globalThis.clearTimeout)(armedTimer as never);
    armedTimer = null;
  };

  /** The one guarded end. Runs once, whatever triggers it. The client never sends an outcome. */
  const end = (finalPhase: "ended" | "start_error" = "ended"): void => {
    if (ended) return;
    ended = true;
    stopTimer();
    clearArmedTimer();
    try {
      pc?.close();
    } catch {
      // Already closed.
    }
    stopMic();
    if (voiceCallId !== null) {
      // End_Report. keepalive lets it survive a page that is closing. Failure is not the buyer's problem:
      // the server ends a call that is never reported (stale rule).
      deps
        .fetch(END_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voiceCallId, token }),
          keepalive: true,
        })
        .catch(() => {});
    }
    deps.onChange({ phase: finalPhase });
  };

  const send = (event: { type: string; [key: string]: unknown }): void => {
    // Session settings come from the server only (Req 3 C4). Never forward a session.update.
    if (event.type === "session.update") return;
    if (!channel || channel.readyState !== "open") return;
    channel.send(JSON.stringify(event));
  };

  const tick = (capEndsAt: string): void => {
    const left = secondsLeft(capEndsAt, deps.now());
    if (left <= 0) {
      end();
      return;
    }
    deps.onChange({ phase: "live", countdown: formatCountdown(left) });
  };

  const postJson = (url: string, body: unknown): Promise<FetchResponseLike> =>
    deps.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  /** A successful `end_call` output went out: end on the next `response.done`, or after 10 s. */
  const armEnd = (): void => {
    if (ended || endArmed) return;
    endArmed = true;
    armedTimer = (deps.setTimeout ?? globalThis.setTimeout)(() => end(), END_CALL_FALLBACK_MS);
  };

  /**
   * Forwards one function call to the server, which takes the invoice from its own Voice_Call row.
   * 200: send the result back as a `function_call_output` item, then `response.create` so the model
   * continues. 404 or `call_time_up`: the call is over, end it. Any other failure sends nothing (the
   * server rolled back, so the model may retry the call).
   */
  const forwardToolCall = async (call: { callId: string; name: string; arguments: string }): Promise<void> => {
    const id = voiceCallId;
    if (id === null) return;
    try {
      const response = await postJson(TOOL_URL, {
        voiceCallId: id,
        token,
        callId: call.callId,
        name: call.name,
        arguments: call.arguments,
      });
      if (ended) return;
      if (response.status === 404) {
        end();
        return;
      }
      if (response.status !== 200) return;
      const result: unknown = await response.json();
      if (ended) return;
      if (isRecord(result) && result.error === "call_time_up") {
        end();
        return;
      }
      send({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: call.callId, output: JSON.stringify(result) },
      });
      send({ type: "response.create" });
      if (call.name === "end_call" && isRecord(result) && result.ok === true) armEnd();
    } catch {
      // Network or parse failure: nothing is sent; the cap and the buyer's hang-up still end the call.
    }
  };

  const postTranscript = (line: { speaker: "buyer" | "agent"; itemId: string; text: string }): void => {
    const id = voiceCallId;
    if (id === null) return;
    // Send only the declared fields: `line` is the routed action and also carries `kind`.
    postJson(TRANSCRIPT_URL, {
      voiceCallId: id,
      token,
      speaker: line.speaker,
      itemId: line.itemId,
      text: line.text,
    }).catch(() => {});
  };

  /** Built-in routing of one data-channel message (the table in the design's Call_Client section). */
  const handleRealtimeMessage = (raw: string): void => {
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    const action = routeRealtimeEvent(event);
    switch (action.kind) {
      case "tool_call":
        void forwardToolCall(action);
        break;
      case "transcript":
        postTranscript(action);
        break;
      case "response_done":
        if (endArmed) end();
        break;
      case "error":
        end();
        break;
      case "ignore":
        break;
    }
  };

  const fail = (phase: "mic_error" | "expired" | "start_error"): void => {
    ended = true;
    stopTimer();
    stopMic();
    deps.onChange({ phase });
  };

  const run = async (): Promise<void> => {
    // 1. Mic. No join request unless this succeeds, so a denied mic leaves the Voice_Call `created`.
    try {
      stream = await micRequest;
    } catch {
      fail("mic_error");
      return;
    }
    if (ended) {
      stopMic();
      return;
    }

    // 2. Join: the server marks the call live and mints the ephemeral key.
    let session: SessionResponse;
    try {
      const response = await deps.fetch(SESSION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (response.status === 404) {
        fail("expired");
        return;
      }
      if (!response.ok) {
        fail("start_error");
        return;
      }
      const parsed = parseSessionResponse(await response.json());
      if (!parsed) {
        fail("start_error");
        return;
      }
      session = parsed;
    } catch {
      fail("start_error");
      return;
    }
    if (ended) {
      stopMic();
      return;
    }
    voiceCallId = session.voiceCallId;

    // 3. WebRTC. Any failure from here on is reported to the server (End_Report).
    try {
      const connection = deps.createPeerConnection();
      pc = connection;
      connection.ontrack = (event) => {
        audioEl.srcObject = event.streams[0] ?? null;
      };
      connection.onconnectionstatechange = () => {
        if (connection.connectionState === "failed" || connection.connectionState === "closed") end();
      };
      for (const track of stream.getTracks()) connection.addTrack(track, stream);

      const dc = connection.createDataChannel(DATA_CHANNEL_LABEL);
      channel = dc;
      dc.onopen = () => {
        if (ended) return;
        // Agent speaks first. Bare event: no session settings of any kind.
        send({ type: "response.create" });
        tick(session.capEndsAt);
        if (!ended) timer = deps.setInterval(() => tick(session.capEndsAt), 1000);
      };
      dc.onclose = () => end();
      dc.onmessage = (event) => {
        if (ended || typeof event.data !== "string") return;
        deps.onMessage?.(event.data, {
          voiceCallId: session.voiceCallId,
          token,
          fetch: deps.fetch,
          send,
          end: () => end(),
        });
        if (!ended) handleRealtimeMessage(event.data);
      };

      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      if (!offer.sdp) throw new Error("no offer sdp");
      const answer = await deps.fetch(session.connectUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.ephemeralKey}`, "Content-Type": "application/sdp" },
        body: offer.sdp,
      });
      if (!answer.ok) throw new Error(`sdp exchange failed: ${answer.status}`);
      const sdp = await answer.text();
      if (ended) return;
      await connection.setRemoteDescription({ type: "answer", sdp });
    } catch {
      end("start_error");
    }
  };

  const settled = run().catch(() => {
    // run() handles its own failures; this only guards against a bug turning into an unhandled rejection.
    end("start_error");
  });

  return { hangUp: () => end(), settled };
}
