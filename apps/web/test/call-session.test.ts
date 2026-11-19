// The browser-side connect, countdown and end of a call, driven with Node fakes: no jsdom, no WebRTC.
// Requirements: 3.4, 3.9, 4.1, 4.3, 4.4, 4.5, 7.4
import { describe, expect, it, vi } from "vitest";
import {
  DATA_CHANNEL_LABEL,
  END_URL,
  ENDED_TEXT,
  EXPIRED_TEXT,
  MIC_CONSTRAINTS,
  MIC_ERROR_TEXT,
  SESSION_URL,
  START_ERROR_TEXT,
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
