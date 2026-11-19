// The browser-side connect, countdown and end of a call, driven with Node fakes: no jsdom, no WebRTC.
// Requirements: 3.4, 3.9, 4.1, 4.3, 4.4, 4.5, 5.1, 5.13, 7.4, 8.1
import { describe, expect, it, vi } from "vitest";
import {
  DATA_CHANNEL_LABEL,
  END_URL,
  ENDED_TEXT,
  EXPIRED_TEXT,
  MIC_CONSTRAINTS,
  MIC_ERROR_TEXT,
  END_CALL_FALLBACK_MS,
  SESSION_URL,
  START_ERROR_TEXT,
  TOOL_URL,
  TRANSCRIPT_URL,
  formatCountdown,
  secondsLeft,
  startCallSession,
  type CallSession,
  type CallSessionDeps,
  type CallView,
  type DataChannelLike,
  type FetchLike,
  type PeerConnectionLike,
} from "@/lib/call/call-session";

const TOKEN = "join-token-abc";
const CALL_ID = "11111111-1111-4111-8111-111111111111";
const EPHEMERAL = "ek_test_ephemeral_value";
const CONNECT_URL = "https://api.openai.com/v1/realtime/calls";
const CAP_ENDS_AT = "2026-11-12T05:05:00.000Z";
const CAP_MS = Date.parse(CAP_ENDS_AT);
const OFFER_SDP = "v=0\r\no=- offer";
const ANSWER_SDP = "v=0\r\no=- answer";
const SESSION_OK = {
  ephemeralKey: EPHEMERAL,
  expiresAt: 1_800_000_060,
  voiceCallId: CALL_ID,
  connectUrl: CONNECT_URL,
  capEndsAt: CAP_ENDS_AT,
};

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  keepalive: boolean | undefined;
}

interface Harness {
  deps: CallSessionDeps;
  /** Everything the fakes saw, in order: "play", "getUserMedia", "fetch:<url>", "createPeerConnection". */
  order: string[];
  fetchCalls: FetchCall[];
  views: CallView[];
  track: { stop: ReturnType<typeof vi.fn> };
  audioEl: { srcObject: unknown; play: ReturnType<typeof vi.fn> };
  getUserMedia: ReturnType<typeof vi.fn>;
  pc: FakePeerConnection;
  pcCreated: () => number;
  dc: FakeDataChannel;
  /** The callback registered with the fake `setInterval`. */
  tickCallback: () => (() => void) | null;
  clearedIntervals: unknown[];
  setNow(ms: number): void;
  /** Fake one-shot timers: what the session armed, with its delay. `cleared` is set by clearTimeout. */
  timeouts: { callback: () => void; ms: number; cleared: boolean }[];
}

class FakeDataChannel implements DataChannelLike {
  readyState = "open";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: string[] = [];
  label = "";
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
  sentEvents(): { type: string; [key: string]: unknown }[] {
    return this.sent.map((s) => JSON.parse(s) as { type: string });
  }
}

class FakePeerConnection implements PeerConnectionLike {
  connectionState = "new";
  ontrack: PeerConnectionLike["ontrack"] = null;
  onconnectionstatechange: (() => void) | null = null;
  closed = 0;
  addedTracks: unknown[] = [];
  localDescription: unknown = null;
  remoteDescription: unknown = null;
  readonly channel = new FakeDataChannel();
  addTrack(track: unknown): unknown {
    this.addedTracks.push(track);
    return {};
  }
  createDataChannel(label: string): DataChannelLike {
    this.channel.label = label;
    return this.channel;
  }
  createOffer() {
    return Promise.resolve({ type: "offer", sdp: OFFER_SDP });
  }
  setLocalDescription(description: unknown): Promise<void> {
    this.localDescription = description;
    return Promise.resolve();
  }
  setRemoteDescription(description: unknown): Promise<void> {
    this.remoteDescription = description;
    return Promise.resolve();
  }
  close(): void {
    this.closed++;
  }
}

type Route = (call: FetchCall) => { status?: number; json?: unknown; text?: string } | "network";

interface Options {
  getUserMedia?: () => Promise<unknown>;
  session?: Route;
  sdp?: Route;
  end?: Route;
  tool?: Route;
  transcript?: Route;
  onMessage?: CallSessionDeps["onMessage"];
}

function harness(options: Options = {}): Harness {
  const order: string[] = [];
  const fetchCalls: FetchCall[] = [];
  const views: CallView[] = [];
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] };
  const audioEl = {
    srcObject: null as unknown,
    play: vi.fn(() => {
      order.push("play");
      return Promise.resolve();
    }),
  };
  const getUserMedia = vi.fn((constraints: unknown) => {
    void constraints;
    order.push("getUserMedia");
    return options.getUserMedia ? options.getUserMedia() : Promise.resolve(stream);
  });
  const pc = new FakePeerConnection();
  let created = 0;
  let nowMs = CAP_MS - 300_000;
  let intervalCallback: (() => void) | null = null;
  const clearedIntervals: unknown[] = [];
  const timeouts: Harness["timeouts"] = [];

  const fetch: FetchLike = (url, init) => {
    order.push(`fetch:${url}`);
    const call: FetchCall = {
      url,
      method: init.method,
      headers: init.headers ?? {},
      body: init.body,
      keepalive: init.keepalive,
    };
    fetchCalls.push(call);
    const route: Route =
      url === SESSION_URL
        ? (options.session ?? (() => ({ json: SESSION_OK })))
        : url === CONNECT_URL
          ? (options.sdp ?? (() => ({ text: ANSWER_SDP })))
          : url === END_URL
            ? (options.end ?? (() => ({ json: { ok: true } })))
            : url === TOOL_URL
              ? (options.tool ?? (() => ({ json: { ok: true } })))
              : url === TRANSCRIPT_URL
                ? (options.transcript ?? (() => ({ json: { ok: true } })))
                : () => {
                    throw new Error(`unexpected fetch ${url}`);
                  };
    const result = route(call);
    if (result === "network") return Promise.reject(new TypeError("fetch failed"));
    const status = result.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(result.json ?? {}),
      text: () => Promise.resolve(result.text ?? ""),
    });
  };

  const deps: CallSessionDeps = {
    token: TOKEN,
    audioEl,
    getUserMedia: getUserMedia as unknown as CallSessionDeps["getUserMedia"],
    createPeerConnection: () => {
      created++;
      order.push("createPeerConnection");
      return pc;
    },
    fetch,
    setInterval: (callback) => {
      intervalCallback = callback;
      return "timer-1";
    },
    clearInterval: (handle) => {
      clearedIntervals.push(handle);
    },
    setTimeout: (callback, ms) => {
      timeouts.push({ callback, ms, cleared: false });
      return timeouts.length - 1;
    },
    clearTimeout: (handle) => {
      const entry = timeouts[handle as number];
      if (entry) entry.cleared = true;
    },
    now: () => nowMs,
    onChange: (view) => {
      views.push(view);
    },
    ...(options.onMessage ? { onMessage: options.onMessage } : {}),
  };
  return {
    deps,
    order,
    fetchCalls,
    views,
    track,
    audioEl,
    getUserMedia,
    pc,
    pcCreated: () => created,
    dc: pc.channel,
    tickCallback: () => intervalCallback,
    clearedIntervals,
    timeouts,
    setNow: (ms) => {
      nowMs = ms;
    },
  };
}

/** Starts a call and waits for the connect sequence (mic, session, SDP) to finish. */
async function connect(options: Options = {}): Promise<{ h: Harness; session: CallSession }> {
  const h = harness(options);
  const session = startCallSession(h.deps);
  await session.settled;
  return { h, session };
}

/** The data channel opens: the agent speaks first and the countdown starts. */
function open(h: Harness): void {
  h.dc.onopen?.();
}

const endReports = (h: Harness): FetchCall[] => h.fetchCalls.filter((c) => c.url === END_URL);
const lastView = (h: Harness): CallView => h.views[h.views.length - 1]!;

describe("formatCountdown and secondsLeft", () => {
  it.each([
    [300, "5:00"],
    [299, "4:59"],
    [61, "1:01"],
    [60, "1:00"],
    [59, "0:59"],
    [10, "0:10"],
    [9, "0:09"],
    [1, "0:01"],
    [0, "0:00"],
    [-5, "0:00"],
    [299.9, "4:59"],
  ])("formats %s seconds as %s", (seconds, expected) => {
    expect(formatCountdown(seconds)).toBe(expected);
  });

  it("counts whole seconds to the cap instant, rounding up, never below zero", () => {
    expect(secondsLeft(CAP_ENDS_AT, CAP_MS - 300_000)).toBe(300);
    expect(secondsLeft(CAP_ENDS_AT, CAP_MS - 299_001)).toBe(300);
    expect(secondsLeft(CAP_ENDS_AT, CAP_MS - 1_000)).toBe(1);
    expect(secondsLeft(CAP_ENDS_AT, CAP_MS)).toBe(0);
    expect(secondsLeft(CAP_ENDS_AT, CAP_MS + 5_000)).toBe(0);
    expect(secondsLeft("not a date", CAP_MS)).toBe(0);
  });
});

describe("the tap: microphone and audio before the first await", () => {
  it("calls play() and getUserMedia synchronously, and sends no request yet", () => {
    const h = harness();
    startCallSession(h.deps);

    // Nothing has been awaited: the test is still in the same synchronous turn.
    expect(h.order).toContain("play");
    expect(h.order).toContain("getUserMedia");
    expect(h.order.filter((entry) => entry.startsWith("fetch:"))).toEqual([]);
    expect(h.order).not.toContain("createPeerConnection");
    expect(h.audioEl.play).toHaveBeenCalledTimes(1);
    expect(h.getUserMedia).toHaveBeenCalledTimes(1);
    expect(h.fetchCalls).toHaveLength(0);
    expect(h.views).toEqual([{ phase: "connecting" }]);
  });

  it("asks for echoCancellation, noiseSuppression and autoGainControl", () => {
    const h = harness();
    startCallSession(h.deps);
    expect(h.getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    expect(MIC_CONSTRAINTS).toEqual({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  });

  it("still asks for the microphone when play() throws synchronously", () => {
    const h = harness();
    h.audioEl.play.mockImplementation(() => {
      throw new Error("NotAllowedError");
    });
    startCallSession(h.deps);
    expect(h.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("sends the join request only after getUserMedia succeeds", async () => {
    const h = harness();
    const session = startCallSession(h.deps);
    await session.settled;
    const firstFetch = h.order.findIndex((entry) => entry.startsWith("fetch:"));
    expect(h.order.indexOf("getUserMedia")).toBeLessThan(firstFetch);
    expect(h.order.indexOf("play")).toBeLessThan(firstFetch);
    expect(h.order[firstFetch]).toBe(`fetch:${SESSION_URL}`);
  });
});

describe("microphone denial", () => {
  it.each([
    ["the buyer denies the permission", () => Promise.reject(new DOMException("denied", "NotAllowedError"))],
    ["there is no microphone", () => Promise.reject(new DOMException("none", "NotFoundError"))],
    [
      "getUserMedia throws synchronously",
      () => {
        throw new TypeError("mediaDevices is undefined");
      },
    ],
  ])("sends no join request when %s", async (_label, getUserMedia) => {
    const h = harness({ getUserMedia });
    const session = startCallSession(h.deps);
    await session.settled;

    expect(h.fetchCalls).toHaveLength(0);
    expect(h.pcCreated()).toBe(0);
    expect(h.views.map((v) => v.phase)).toEqual(["connecting", "mic_error"]);
    expect(MIC_ERROR_TEXT).toBe("Microphone access is needed for the call");
    expect(endReports(h)).toHaveLength(0);
  });

  it("lets the buyer try again with the same token after a denial", async () => {
    const denied = harness({ getUserMedia: () => Promise.reject(new DOMException("denied", "NotAllowedError")) });
    await startCallSession(denied.deps).settled;
    expect(lastView(denied).phase).toBe("mic_error");
    expect(denied.fetchCalls).toHaveLength(0);

    // A second tap is a new session on a new harness with the mic granted. It joins with the same token.
    const retry = harness();
    await startCallSession(retry.deps).settled;
    expect(retry.fetchCalls[0]!.url).toBe(SESSION_URL);
    expect(JSON.parse(retry.fetchCalls[0]!.body!)).toEqual({ token: TOKEN });
  });
});

describe("the join request and the SDP exchange", () => {
  it("posts only the token to the session endpoint", async () => {
    const { h } = await connect();
    const join = h.fetchCalls[0]!;
    expect(join.url).toBe(SESSION_URL);
    expect(join.method).toBe("POST");
    expect(join.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(join.body!)).toEqual({ token: TOKEN });
  });

  it("posts the SDP offer to connectUrl with the ephemeral key as Bearer and Content-Type application/sdp", async () => {
    const { h } = await connect();
    const sdp = h.fetchCalls[1]!;
    expect(sdp.url).toBe(CONNECT_URL);
    expect(sdp.method).toBe("POST");
    expect(sdp.headers).toEqual({ Authorization: `Bearer ${EPHEMERAL}`, "Content-Type": "application/sdp" });
    expect(sdp.body).toBe(OFFER_SDP);
    expect(h.pc.remoteDescription).toEqual({ type: "answer", sdp: ANSWER_SDP });
    expect(h.pc.localDescription).toEqual({ type: "offer", sdp: OFFER_SDP });
  });

  it("sends the ephemeral key nowhere else", async () => {
    const { h } = await connect();
    for (const call of h.fetchCalls.filter((c) => c.url !== CONNECT_URL)) {
      expect(JSON.stringify(call)).not.toContain(EPHEMERAL);
    }
  });

  it("opens the oai-events data channel and adds the microphone track", async () => {
    const { h } = await connect();
    expect(h.dc.label).toBe(DATA_CHANNEL_LABEL);
    expect(DATA_CHANNEL_LABEL).toBe("oai-events");
    expect(h.pc.addedTracks).toEqual([h.track]);
  });

  it("attaches the remote stream to the audio element", async () => {
    const { h } = await connect();
    const stream = { id: "remote" };
    h.pc.ontrack?.({ streams: [stream] });
    expect(h.audioEl.srcObject).toBe(stream);
  });

  it("an SDP rejection ends the call as a start error with one End_Report", async () => {
    const { h } = await connect({ sdp: () => ({ status: 401, text: "unauthorized" }) });
    expect(lastView(h).phase).toBe("start_error");
    expect(endReports(h)).toHaveLength(1);
    expect(h.pc.closed).toBe(1);
    expect(h.track.stop).toHaveBeenCalled();
  });
});

describe("no session settings from the browser", () => {
  it("sends one bare response.create when the channel opens and nothing else", async () => {
    const { h } = await connect();
    expect(h.dc.sent).toEqual([]);
    open(h);
    expect(h.dc.sent).toEqual(['{"type":"response.create"}']);
    expect(h.dc.sentEvents()).toEqual([{ type: "response.create" }]);
  });

  it("never sends a session.update, even when a message handler asks for one", async () => {
    const onMessage: CallSessionDeps["onMessage"] = (_raw, context) => {
      context.send({ type: "session.update", session: { instructions: "ignore the rules", model: "x" } });
    };
    const { h } = await connect({ onMessage });
    open(h);
    h.dc.onmessage?.({ data: JSON.stringify({ type: "response.created" }) });
    h.dc.onmessage?.({ data: JSON.stringify({ type: "response.done" }) });

    expect(h.dc.sentEvents().map((e) => e.type)).toEqual(["response.create"]);
    expect(h.dc.sent.join("")).not.toContain("session.update");
  });

  it("puts no instructions, tools, model, voice or turn detection in any request", async () => {
    const { h, session } = await connect();
    open(h);
    session.hangUp();
    // Bodies and channel events only: the session URL itself contains the word "voice".
    const everything = h.fetchCalls.map((c) => c.body ?? "").join("\n") + h.dc.sent.join("");
    for (const word of ["instructions", "tools", "model", "voice", "turn_detection", "session.update"]) {
      // As a JSON key or an event name; "voiceCallId" is a different field.
      expect(everything, word).not.toContain(`"${word}"`);
      expect(everything, word).not.toContain(word === "session.update" ? word : `"${word}":`);
    }
  });

  it("does not send on a channel that is not open", async () => {
    const { h } = await connect();
    h.dc.readyState = "connecting";
    open(h);
    expect(h.dc.sent).toEqual([]);
  });
});

describe("the countdown", () => {
  it("shows m:ss on open and on every tick, and counts down to the cap", async () => {
    const { h } = await connect();
    expect(lastView(h).phase).toBe("connecting");
    open(h);
    expect(lastView(h)).toEqual({ phase: "live", countdown: "5:00" });

    h.setNow(CAP_MS - 245_000);
    h.tickCallback()!();
    expect(lastView(h)).toEqual({ phase: "live", countdown: "4:05" });

    h.setNow(CAP_MS - 9_000);
    h.tickCallback()!();
    expect(lastView(h)).toEqual({ phase: "live", countdown: "0:09" });

    h.setNow(CAP_MS - 1);
    h.tickCallback()!();
    expect(lastView(h)).toEqual({ phase: "live", countdown: "0:01" });
    expect(endReports(h)).toHaveLength(0);
  });

  it("starts exactly one one-second timer", async () => {
    const setInterval = vi.fn(() => "timer-1");
    const h = harness();
    h.deps.setInterval = setInterval;
    await startCallSession(h.deps).settled;
    open(h);
    expect(setInterval).toHaveBeenCalledTimes(1);
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 1000);
  });
});

describe("ending the call", () => {
  it("hang-up closes the connection, stops the microphone, sends one End_Report and shows the ended text", async () => {
    const { h, session } = await connect();
    open(h);
    session.hangUp();

    expect(h.pc.closed).toBe(1);
    expect(h.track.stop).toHaveBeenCalledTimes(1);
    expect(h.clearedIntervals).toEqual(["timer-1"]);
    const reports = endReports(h);
    expect(reports).toHaveLength(1);
    const report = reports[0]!;
    expect(report.method).toBe("POST");
    expect(report.keepalive).toBe(true);
    expect(report.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(report.body!)).toEqual({ voiceCallId: CALL_ID, token: TOKEN });
    expect(Object.keys(JSON.parse(report.body!)).sort()).toEqual(["token", "voiceCallId"]);
    expect(report.body).not.toContain("outcome");
    expect(lastView(h)).toEqual({ phase: "ended" });
    expect(ENDED_TEXT).toBe("The call has ended");
  });

  it("the countdown reaching 0:00 ends the call with one End_Report", async () => {
    const { h } = await connect();
    open(h);
    h.setNow(CAP_MS);
    h.tickCallback()!();

    expect(endReports(h)).toHaveLength(1);
    expect(endReports(h)[0]!.keepalive).toBe(true);
    expect(JSON.parse(endReports(h)[0]!.body!)).toEqual({ voiceCallId: CALL_ID, token: TOKEN });
    expect(h.pc.closed).toBe(1);
    expect(h.track.stop).toHaveBeenCalledTimes(1);
    expect(lastView(h)).toEqual({ phase: "ended" });
  });

  it("repeated end triggers send no second End_Report", async () => {
    const { h, session } = await connect();
    open(h);
    session.hangUp();
    session.hangUp();
    h.setNow(CAP_MS + 1_000);
    h.tickCallback()!();
    h.dc.onclose?.();
    h.pc.connectionState = "failed";
    h.pc.onconnectionstatechange?.();
    h.pc.connectionState = "closed";
    h.pc.onconnectionstatechange?.();

    expect(endReports(h)).toHaveLength(1);
    expect(h.pc.closed).toBe(1);
    expect(h.track.stop).toHaveBeenCalledTimes(1);
    expect(h.views.filter((v) => v.phase === "ended")).toHaveLength(1);
  });

  it("a countdown end followed by a hang-up sends one End_Report", async () => {
    const { h, session } = await connect();
    open(h);
    h.setNow(CAP_MS);
    h.tickCallback()!();
    session.hangUp();
    expect(endReports(h)).toHaveLength(1);
  });

  it("a hang-up before the data channel opens still sends one End_Report", async () => {
    const { h, session } = await connect();
    session.hangUp();
    session.hangUp();
    expect(endReports(h)).toHaveLength(1);
    expect(h.dc.sent).toEqual([]);
  });

  it("ends once with an End_Report when the peer connection fails", async () => {
    const { h } = await connect();
    open(h);
    h.pc.connectionState = "failed";
    h.pc.onconnectionstatechange?.();
    expect(endReports(h)).toHaveLength(1);
    expect(lastView(h).phase).toBe("ended");
  });

  it("ends once with an End_Report when the data channel closes by itself", async () => {
    const { h } = await connect();
    open(h);
    h.dc.onclose?.();
    expect(endReports(h)).toHaveLength(1);
  });

  it("does not fail the buyer's screen when the End_Report request is rejected", async () => {
    const { h, session } = await connect({ end: () => "network" });
    open(h);
    expect(() => session.hangUp()).not.toThrow();
    await Promise.resolve();
    expect(lastView(h)).toEqual({ phase: "ended" });
  });
});

describe("the join request fails", () => {
  it("shows the expired text for a 404 and sends no End_Report and no SDP", async () => {
    const { h } = await connect({ session: () => ({ status: 404, json: { error: "expired" } }) });
    expect(h.views.map((v) => v.phase)).toEqual(["connecting", "expired"]);
    expect(EXPIRED_TEXT).toBe("This call link has expired or was already used");
    expect(h.pcCreated()).toBe(0);
    expect(h.fetchCalls.map((c) => c.url)).toEqual([SESSION_URL]);
    expect(h.track.stop).toHaveBeenCalled();
  });

  it.each([503, 502, 500])("shows the could-not-start text for a %i", async (status) => {
    const { h } = await connect({ session: () => ({ status, json: { error: "x" } }) });
    expect(h.views.map((v) => v.phase)).toEqual(["connecting", "start_error"]);
    expect(START_ERROR_TEXT).toBe("The call could not start. Please try again later.");
    expect(h.pcCreated()).toBe(0);
    expect(h.fetchCalls.map((c) => c.url)).toEqual([SESSION_URL]);
    expect(h.track.stop).toHaveBeenCalled();
  });

  it("shows the could-not-start text when the request fails at the network level", async () => {
    const { h } = await connect({ session: () => "network" });
    expect(lastView(h).phase).toBe("start_error");
    expect(h.pcCreated()).toBe(0);
  });

  it("shows the could-not-start text for a success body without an ephemeral key", async () => {
    const { h } = await connect({ session: () => ({ json: { voiceCallId: CALL_ID } }) });
    expect(lastView(h).phase).toBe("start_error");
    expect(h.pcCreated()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Tool loop (task 5.3): forward function calls, send the output item then response.create, end_call,
// error / call_time_up / 404 endings. Requirements 5.1, 5.13, 7.4, 8.1, 3.4.
// ---------------------------------------------------------------------------------------------

const FACTS_RESULT = { ok: true, buyer_name: "Sharma Traders", total_due: "₹4,17,127.94" };

const functionCall = (callId: string, name: string, args = "{}") => ({
  type: "response.function_call_arguments.done",
  call_id: callId,
  name,
  arguments: args,
  item_id: `item_${callId}`,
});

/** Delivers one Realtime server event on the data channel. */
function deliver(h: Harness, event: unknown): void {
  h.dc.onmessage?.({ data: typeof event === "string" ? event : JSON.stringify(event) });
}

/** Lets pending promise chains (fetch, json, send) finish. No timers are involved. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const toolCalls = (h: Harness): FetchCall[] => h.fetchCalls.filter((c) => c.url === TOOL_URL);
const transcriptCalls = (h: Harness): FetchCall[] => h.fetchCalls.filter((c) => c.url === TRANSCRIPT_URL);

/** A connected call whose channel is open; `sent` holds only what the tool loop adds after the first response.create. */
async function liveCall(options: Options = {}): Promise<{ h: Harness; session: CallSession }> {
  const c = await connect(options);
  open(c.h);
  return c;
}

describe("the tool loop: output item, then response.create", () => {
  it("forwards the call to the tool endpoint with only the call fields", async () => {
    const { h } = await liveCall({ tool: () => ({ json: FACTS_RESULT }) });
    deliver(h, functionCall("call_abc", "get_invoice_facts", "{}"));
    await flush();

    const calls = toolCalls(h);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      voiceCallId: CALL_ID,
      token: TOKEN,
      callId: "call_abc",
      name: "get_invoice_facts",
      arguments: "{}",
    });
    expect(calls[0]!.body).not.toContain(EPHEMERAL);
  });

  it("sends the function_call_output item first and response.create second", async () => {
    const { h } = await liveCall({ tool: () => ({ json: FACTS_RESULT }) });
    deliver(h, functionCall("call_abc", "get_invoice_facts"));
    await flush();

    expect(h.dc.sentEvents()).toEqual([
      { type: "response.create" },
      {
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: "call_abc", output: JSON.stringify(FACTS_RESULT) },
      },
      { type: "response.create" },
    ]);
  });

  it("sends the raw arguments string of a record_promise_to_pay call and returns its error result as output", async () => {
    const args = '{"amount_paise":0,"date_iso":"2026-11-20","spoken_text":"haan"}';
    const error = { ok: false, error: "amount_out_of_range", message: "x", total_due: "₹4,17,127.94" };
    const { h } = await liveCall({ tool: () => ({ json: error }) });
    deliver(h, functionCall("call_p1", "record_promise_to_pay", args));
    await flush();

    expect(JSON.parse(toolCalls(h)[0]!.body!)).toMatchObject({ name: "record_promise_to_pay", arguments: args });
    const events = h.dc.sentEvents();
    expect(events[1]).toEqual({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: "call_p1", output: JSON.stringify(error) },
    });
    expect(events[2]).toEqual({ type: "response.create" });
    expect(endReports(h)).toHaveLength(0);
  });

  it("treats a call without an arguments string as empty arguments", async () => {
    const { h } = await liveCall({ tool: () => ({ json: FACTS_RESULT }) });
    deliver(h, { type: "response.function_call_arguments.done", call_id: "call_n", name: "get_invoice_facts" });
    await flush();
    expect(JSON.parse(toolCalls(h)[0]!.body!)).toMatchObject({ callId: "call_n", arguments: "" });
  });

  it("answers each of two function calls with its own output item and call_id", async () => {
    const { h } = await liveCall({
      tool: (call) => ({ json: { ok: true, echoed: (JSON.parse(call.body!) as { callId: string }).callId } }),
    });
    deliver(h, functionCall("call_1", "get_invoice_facts"));
    deliver(h, functionCall("call_2", "get_invoice_facts"));
    await flush();

    const outputs = h.dc
      .sentEvents()
      .filter((e) => e.type === "conversation.item.create")
      .map((e) => (e as unknown as { item: { call_id: string; output: string } }).item);
    expect(outputs).toEqual([
      { type: "function_call_output", call_id: "call_1", output: '{"ok":true,"echoed":"call_1"}' },
      { type: "function_call_output", call_id: "call_2", output: '{"ok":true,"echoed":"call_2"}' },
    ]);
  });

  it("sends nothing and keeps the call live when the tool request fails with 500 or at the network level", async () => {
    for (const tool of [() => ({ status: 500, json: { error: "internal" } }), () => "network" as const]) {
      const { h } = await liveCall({ tool });
      deliver(h, functionCall("call_abc", "get_invoice_facts"));
      await flush();
      expect(h.dc.sentEvents()).toEqual([{ type: "response.create" }]);
      expect(endReports(h)).toHaveLength(0);
      expect(lastView(h).phase).toBe("live");
    }
  });

  it("sends no output when the call ended while the tool request was in flight", async () => {
    const { h, session } = await liveCall({ tool: () => ({ json: FACTS_RESULT }) });
    deliver(h, functionCall("call_abc", "get_invoice_facts"));
    session.hangUp();
    await flush();
    expect(h.dc.sentEvents()).toEqual([{ type: "response.create" }]);
    expect(endReports(h)).toHaveLength(1);
  });
});

describe("end_call: ends on the next output_audio_buffer.stopped or after 10 seconds", () => {
  const OK_RESULT = { json: { ok: true } };
  const endCall = (callId = "call_end") => functionCall(callId, "end_call", '{"outcome":"dispute"}');

  it("does not end the call when the output is sent, only on the next output_audio_buffer.stopped", async () => {
    const { h } = await liveCall({ tool: () => OK_RESULT });
    deliver(h, endCall());
    await flush();
    expect(h.dc.sentEvents().map((e) => e.type)).toEqual([
      "response.create",
      "conversation.item.create",
      "response.create",
    ]);
    expect(endReports(h)).toHaveLength(0);
    expect(lastView(h).phase).toBe("live");

    deliver(h, { type: "output_audio_buffer.stopped" });
    expect(endReports(h)).toHaveLength(1);
    expect(JSON.parse(endReports(h)[0]!.body!)).toEqual({ voiceCallId: CALL_ID, token: TOKEN });
    expect(h.pc.closed).toBe(1);
    expect(h.track.stop).toHaveBeenCalledTimes(1);
    expect(lastView(h)).toEqual({ phase: "ended" });
  });

  it("arms one 10-second timer when the output is sent, and clears it when output_audio_buffer.stopped ends the call", async () => {
    const { h } = await liveCall({ tool: () => OK_RESULT });
    expect(END_CALL_FALLBACK_MS).toBe(10_000);
    expect(h.timeouts).toEqual([]);
    deliver(h, endCall());
    await flush();
    expect(h.timeouts).toEqual([{ callback: expect.any(Function), ms: 10_000, cleared: false }]);

    deliver(h, { type: "output_audio_buffer.stopped" });
    expect(h.timeouts[0]!.cleared).toBe(true);
  });

  it("ends after 10 seconds when no output_audio_buffer.stopped arrives", async () => {
    const { h } = await liveCall({ tool: () => OK_RESULT });
    deliver(h, endCall());
    await flush();
    expect(endReports(h)).toHaveLength(0);

    h.timeouts[0]!.callback();
    expect(endReports(h)).toHaveLength(1);
    expect(lastView(h)).toEqual({ phase: "ended" });
    expect(h.pc.closed).toBe(1);

    // An output_audio_buffer.stopped after the timer end sends no second End_Report.
    deliver(h, { type: "output_audio_buffer.stopped" });
    expect(endReports(h)).toHaveLength(1);
  });

  it("ignores an output_audio_buffer.stopped that arrives before the end_call output is sent", async () => {
    const { h } = await liveCall({ tool: () => OK_RESULT });
    deliver(h, endCall());
    // The response that held the function call finishes before the tool round trip is back.
    deliver(h, { type: "output_audio_buffer.stopped" });
    expect(endReports(h)).toHaveLength(0);
    await flush();
    expect(endReports(h)).toHaveLength(0);
    deliver(h, { type: "output_audio_buffer.stopped" });
    expect(endReports(h)).toHaveLength(1);
  });

  it("does not end on output_audio_buffer.stopped or arm a timer for other tools or for a failed end_call", async () => {
    const { h } = await liveCall({ tool: () => ({ json: { ok: false, error: "invalid_arguments" } }) });
    deliver(h, functionCall("call_x", "end_call", "{}"));
    deliver(h, functionCall("call_y", "get_invoice_facts"));
    await flush();
    deliver(h, { type: "output_audio_buffer.stopped" });
    expect(h.timeouts).toEqual([]);
    expect(endReports(h)).toHaveLength(0);
    expect(lastView(h).phase).toBe("live");
  });

  it("sends one End_Report when output_audio_buffer.stopped, the timer and a hang-up all fire", async () => {
    const { h, session } = await liveCall({ tool: () => OK_RESULT });
    deliver(h, endCall());
    await flush();
    deliver(h, { type: "output_audio_buffer.stopped" });
    h.timeouts[0]!.callback();
    session.hangUp();
    expect(endReports(h)).toHaveLength(1);
  });
  it("does not end the call on response.done alone, even after the end_call output is sent", async () => {
    const { h } = await liveCall({ tool: () => OK_RESULT });
    deliver(h, endCall());
    await flush();
    deliver(h, { type: "response.done" });
    deliver(h, { type: "response.done" });
    expect(endReports(h)).toHaveLength(0);
    expect(h.pc.closed).toBe(0);
    expect(lastView(h).phase).toBe("live");
    deliver(h, { type: "output_audio_buffer.stopped" });
    expect(endReports(h)).toHaveLength(1);
    expect(lastView(h)).toEqual({ phase: "ended" });
  });
  it("still ends after 10 seconds when only response.done arrives", async () => {
    const { h } = await liveCall({ tool: () => OK_RESULT });
    deliver(h, endCall());
    await flush();
    deliver(h, { type: "response.done" });
    expect(endReports(h)).toHaveLength(0);
    expect(h.timeouts).toEqual([{ callback: expect.any(Function), ms: END_CALL_FALLBACK_MS, cleared: false }]);
    h.timeouts[0]!.callback();
    expect(endReports(h)).toHaveLength(1);
    expect(lastView(h)).toEqual({ phase: "ended" });
  });
});

describe("ending on errors", () => {
  it("a Realtime error event ends the call with one End_Report", async () => {
    const { h } = await liveCall();
    deliver(h, { type: "error", error: { type: "server_error", message: "boom" } });
    expect(endReports(h)).toHaveLength(1);
    expect(h.pc.closed).toBe(1);
    expect(h.track.stop).toHaveBeenCalledTimes(1);
    expect(lastView(h)).toEqual({ phase: "ended" });
    // Nothing else is sent to the model and a second error changes nothing.
    deliver(h, { type: "error" });
    expect(endReports(h)).toHaveLength(1);
    expect(h.dc.sentEvents()).toEqual([{ type: "response.create" }]);
  });

  it("a call_time_up result ends the call and sends no output item", async () => {
    const result = { ok: false, error: "call_time_up", message: "The call time is over." };
    const { h } = await liveCall({ tool: () => ({ json: result }) });
    deliver(h, functionCall("call_abc", "get_invoice_facts"));
    await flush();
    expect(endReports(h)).toHaveLength(1);
    expect(lastView(h)).toEqual({ phase: "ended" });
    expect(h.dc.sentEvents()).toEqual([{ type: "response.create" }]);
    expect(h.pc.closed).toBe(1);
  });

  it("a 404 from the tool endpoint ends the call and sends no output item", async () => {
    const { h } = await liveCall({ tool: () => ({ status: 404, json: { error: "not_found" } }) });
    deliver(h, functionCall("call_abc", "record_promise_to_pay", "{}"));
    await flush();
    expect(endReports(h)).toHaveLength(1);
    expect(lastView(h)).toEqual({ phase: "ended" });
    expect(h.dc.sentEvents()).toEqual([{ type: "response.create" }]);
  });

  it("sends exactly one End_Report when several end triggers follow each other", async () => {
    const { h, session } = await liveCall({ tool: () => ({ json: { ok: false, error: "call_time_up" } }) });
    deliver(h, functionCall("call_1", "get_invoice_facts"));
    deliver(h, functionCall("call_2", "get_invoice_facts"));
    await flush();
    deliver(h, { type: "error" });
    h.setNow(CAP_MS);
    h.tickCallback()!();
    h.dc.onclose?.();
    session.hangUp();
    expect(endReports(h)).toHaveLength(1);
    expect(h.views.filter((v) => v.phase === "ended")).toHaveLength(1);
  });
});

describe("transcript lines and the rest of the data channel", () => {
  it("posts buyer and agent transcript lines with the item id and skips blank text", async () => {
    const { h } = await liveCall();
    deliver(h, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_b1",
      transcript: "Haan ji, Friday tak",
    });
    deliver(h, { type: "response.output_audio_transcript.done", item_id: "item_a1", transcript: "Shukriya Sharma ji" });
    deliver(h, { type: "response.output_audio_transcript.done", item_id: "item_a2", transcript: "   " });
    await flush();

    expect(transcriptCalls(h).map((c) => JSON.parse(c.body!))).toEqual([
      { voiceCallId: CALL_ID, token: TOKEN, speaker: "buyer", itemId: "item_b1", text: "Haan ji, Friday tak" },
      { voiceCallId: CALL_ID, token: TOKEN, speaker: "agent", itemId: "item_a1", text: "Shukriya Sharma ji" },
    ]);
  });

  it("ignores messages that are not JSON, not strings or not known events", async () => {
    const { h } = await liveCall();
    deliver(h, "not json {");
    h.dc.onmessage?.({ data: 42 });
    deliver(h, { type: "response.created" });
    deliver(h, null);
    await flush();
    expect(toolCalls(h)).toEqual([]);
    expect(transcriptCalls(h)).toEqual([]);
    expect(endReports(h)).toHaveLength(0);
    expect(lastView(h).phase).toBe("live");
  });

  it("never sends a session.update during a whole call: tool call, transcripts, end_call and hang-up", async () => {
    const { h, session } = await liveCall({ tool: () => ({ json: { ok: true } }) });
    deliver(h, functionCall("call_1", "get_invoice_facts"));
    deliver(h, functionCall("call_2", "record_promise_to_pay", "{}"));
    deliver(h, { type: "response.output_audio_transcript.done", item_id: "a1", transcript: "Namaste" });
    deliver(h, functionCall("call_3", "end_call", '{"outcome":"no_promise"}'));
    await flush();
    deliver(h, { type: "response.done" });
    session.hangUp();

    expect(h.dc.sentEvents().map((e) => e.type)).not.toContain("session.update");
    expect(h.dc.sent.join("")).not.toContain("session.update");
    const requestBodies = h.fetchCalls.map((c) => c.body ?? "").join("\n");
    expect(requestBodies).not.toContain("session.update");
    // Every event the client sent is one of the two kinds the design allows.
    const kinds = new Set(h.dc.sentEvents().map((e) => e.type));
    expect([...kinds].sort()).toEqual(["conversation.item.create", "response.create"]);
  });
});
