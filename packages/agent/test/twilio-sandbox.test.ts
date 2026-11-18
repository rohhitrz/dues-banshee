import { describe, expect, it } from "vitest";
import { parseE164, type ChannelResult, type E164 } from "../src/channel/message-channel";
import { createTwilioSandbox, type TwilioFetch } from "../src/channel/twilio-sandbox";
import { fakeClock, fakeHttp, type FakeResponse } from "../src/testing/fake-http";

// Fictional values only: the +1 415 555-01xx range and the +91 900000xxxx test numbers are not real subscribers.
const ACCOUNT_SID = "ACtest0000000000000000000000000001";
const AUTH_TOKEN = "test-auth-token";
const FROM = "+14155550100";
const BASE = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}`;
const CREATE_URL = `${BASE}/Messages.json`;
const SID = "SM00000000000000000000000000000001";
const POLL_URL = `${BASE}/Messages/${SID}.json`;
const BASIC = `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64")}`;
const TEXT = "Namaste Sharma ji,\nPay ₹4,12,000 here: https://rzp.test/x?a=1&b=2\nधन्यवाद";

function number(raw: string): E164 {
  const parsed = parseE164(raw);
  if (parsed === null) throw new Error(`not E.164: ${raw}`);
  return parsed;
}
const TO = number("+919000000001");
const REQUEST = { to: TO, text: TEXT, idempotencyKey: "draft-1" } as const;

const CREATED = { status: 201, json: { sid: SID, status: "queued" } } satisfies FakeResponse;
const QUEUED: FakeResponse = { json: { status: "queued", error_code: null } };
const QUEUED_RECORD = { status: "queued", errorCode: "" };

interface Harness {
  http: ReturnType<typeof fakeHttp>;
  clock: ReturnType<typeof fakeClock>;
  /** The `ms` of every `timeoutSignal` call, in order. */
  timeoutMs: number[];
  /** The signal each request carried, in request order, and the signal `timeoutSignal` issued for it. */
  usedSignals: (AbortSignal | null | undefined)[];
  issuedSignals: AbortSignal[];
  channel: ReturnType<typeof createTwilioSandbox>;
}

function harness(create: readonly FakeResponse[], polls: readonly FakeResponse[] = []): Harness {
  const clock = fakeClock();
  const http = fakeHttp(
    [
      { method: "POST", url: CREATE_URL, responses: create },
      { method: "GET", url: `${BASE}/Messages/`, responses: polls },
    ],
    { clock },
  );
  const timeoutMs: number[] = [];
  const issuedSignals: AbortSignal[] = [];
  const usedSignals: (AbortSignal | null | undefined)[] = [];
  const fetch: TwilioFetch = (input, init) => {
    usedSignals.push(init?.signal);
    return http.fetch(input, init);
  };
  const channel = createTwilioSandbox({
    fetch,
    sleep: clock.sleep,
    timeoutSignal: (ms) => {
      timeoutMs.push(ms);
      const signal = clock.timeoutSignal(ms);
      issuedSignals.push(signal);
      return signal;
    },
    accountSid: ACCOUNT_SID,
    authToken: AUTH_TOKEN,
    from: FROM,
  });
  return { http, clock, timeoutMs, usedSignals, issuedSignals, channel };
}

const gets = (h: Harness) => h.http.calls("GET", BASE);

describe("createTwilioSandbox: create request", () => {
  it("posts one form-encoded message with Basic auth and the exact From, To and Body", async () => {
    const h = harness([CREATED], [QUEUED, QUEUED, QUEUED]);
    await h.channel.send(REQUEST);
    expect(h.http.requests[0]).toEqual({
      method: "POST",
      url: CREATE_URL,
      headers: { authorization: BASIC, "content-type": "application/x-www-form-urlencoded" },
      body: { From: `whatsapp:${FROM}`, To: `whatsapp:${TO}`, Body: TEXT },
      rawBody: new URLSearchParams({ From: `whatsapp:${FROM}`, To: `whatsapp:${TO}`, Body: TEXT }).toString(),
    });
    expect(h.http.calls("POST", BASE)).toHaveLength(1);
  });

  it("names itself twilio_sandbox", () => {
    expect(harness([]).channel.name).toEqual("twilio_sandbox");
  });

  it("caps the create request at timeoutSignal(10_000) and each poll at timeoutSignal(1_000)", async () => {
    const h = harness([CREATED], [QUEUED, QUEUED, QUEUED]);
    await h.channel.send(REQUEST);
    expect(h.timeoutMs).toEqual([10_000, 1_000, 1_000, 1_000]);
    expect(h.usedSignals.map((signal, i) => signal === h.issuedSignals[i])).toEqual([true, true, true, true]);
  });

  it("makes no call and returns failed/no_recipient when to is null", async () => {
    const h = harness([]);
    const result = await h.channel.send({ to: null, text: TEXT, idempotencyKey: "draft-1" });
    expect(result).toEqual({
      kind: "failed",
      errorKind: "no_recipient",
      errorCode: "",
      providerMessageId: null,
      polls: [],
    });
    expect(h.http.requests).toEqual([]);
    expect(h.timeoutMs).toEqual([]);
  });
});

describe("createTwilioSandbox: a failed create does not poll", () => {
  const cases: { name: string; create: FakeResponse; expected: ChannelResult }[] = [
    {
      name: "63015 (recipient has not joined the sandbox)",
      create: { status: 400, json: { code: 63015, message: "not joined", status: 400 } },
      expected: { kind: "failed", errorKind: "sandbox_window", errorCode: "63015", providerMessageId: null, polls: [] },
    },
    {
      name: "63016 (outside the 24-hour window)",
      create: { status: 400, json: { code: 63016, message: "outside window", status: 400 } },
      expected: { kind: "failed", errorKind: "sandbox_window", errorCode: "63016", providerMessageId: null, polls: [] },
    },
    {
      name: "a 401 with code 20003",
      create: { status: 401, json: { code: 20003, message: "Authenticate", status: 401 } },
      expected: { kind: "failed", errorKind: "provider_error", errorCode: "20003", providerMessageId: null, polls: [] },
    },
    {
      name: "a create timeout thrown by fetch",
      create: { throws: "timeout" },
      expected: { kind: "failed", errorKind: "timeout", errorCode: "", providerMessageId: null, polls: [] },
    },
    {
      name: "a network throw",
      create: { throws: "network" },
      expected: { kind: "failed", errorKind: "network", errorCode: "", providerMessageId: null, polls: [] },
    },
  ];

  it.each(cases)("$name gives the exact failed result with zero GETs", async ({ create, expected }) => {
    const h = harness([create]);
    expect(await h.channel.send(REQUEST)).toEqual(expected);
    expect(h.http.requests).toHaveLength(1);
    expect(gets(h)).toEqual([]);
    expect(h.clock.sleeps).toEqual([]);
  });

  it("returns failed/timeout when the create response arrives after 10,001 ms, with zero GETs", async () => {
    const h = harness([{ ...CREATED, delayMs: 10_001 }]);
    expect(await h.channel.send(REQUEST)).toEqual({
      kind: "failed",
      errorKind: "timeout",
      errorCode: "",
      providerMessageId: null,
      polls: [],
    });
    expect(gets(h)).toEqual([]);
  });

  it("still polls when the create response arrives after exactly 10,000 ms", async () => {
    const h = harness([{ ...CREATED, delayMs: 10_000 }], [QUEUED, QUEUED, QUEUED]);
    expect(await h.channel.send(REQUEST)).toEqual({
      kind: "sent",
      providerMessageId: SID,
      polls: [QUEUED_RECORD, QUEUED_RECORD, QUEUED_RECORD],
    });
    expect(gets(h)).toHaveLength(3);
  });
});

describe("createTwilioSandbox: status polls", () => {
  it("three queued polls end as sent after 3 GETs with sleeps [2000, 2000]", async () => {
    const h = harness([CREATED], [QUEUED, QUEUED, QUEUED]);
    expect(await h.channel.send(REQUEST)).toEqual({
      kind: "sent",
      providerMessageId: SID,
      polls: [QUEUED_RECORD, QUEUED_RECORD, QUEUED_RECORD],
    });
    expect(gets(h).map((r) => [r.method, r.url, r.headers])).toEqual([
      ["GET", POLL_URL, { authorization: BASIC }],
      ["GET", POLL_URL, { authorization: BASIC }],
      ["GET", POLL_URL, { authorization: BASIC }],
    ]);
    expect(h.clock.sleeps).toEqual([2000, 2000]);
  });

  it("poll 1 failed with 63015 gives failed/sandbox_window with the SID, 1 GET and no sleep", async () => {
    const h = harness([CREATED], [{ json: { status: "failed", error_code: 63015 } }]);
    expect(await h.channel.send(REQUEST)).toEqual({
      kind: "failed",
      errorKind: "sandbox_window",
      errorCode: "63015",
      providerMessageId: SID,
      polls: [{ status: "failed", errorCode: "63015" }],
    });
    expect(gets(h)).toHaveLength(1);
    expect(h.clock.sleeps).toEqual([]);
  });

  it("queued, queued, undelivered 30008 gives failed/provider_error with code 30008 and the SID", async () => {
    const h = harness([CREATED], [QUEUED, QUEUED, { json: { status: "undelivered", error_code: 30008 } }]);
    expect(await h.channel.send(REQUEST)).toEqual({
      kind: "failed",
      errorKind: "provider_error",
      errorCode: "30008",
      providerMessageId: SID,
      polls: [QUEUED_RECORD, QUEUED_RECORD, { status: "undelivered", errorCode: "30008" }],
    });
    expect(gets(h)).toHaveLength(3);
    expect(h.clock.sleeps).toEqual([2000, 2000]);
  });

  it("a network error on poll 1 ends polling and the message counts as sent, after 1 GET", async () => {
    const h = harness([CREATED], [{ throws: "network" }]);
    expect(await h.channel.send(REQUEST)).toEqual({
      kind: "sent",
      providerMessageId: SID,
      polls: [{ error: "network", httpStatus: null }],
    });
    expect(gets(h)).toHaveLength(1);
    expect(h.clock.sleeps).toEqual([]);
  });

  it("a poll answered after 1,001 ms is a timeout record, polling stops and the message counts as sent", async () => {
    const h = harness([CREATED], [{ json: { status: "queued", error_code: null }, delayMs: 1_001 }]);
    expect(await h.channel.send(REQUEST)).toEqual({
      kind: "sent",
      providerMessageId: SID,
      polls: [{ error: "timeout", httpStatus: null }],
    });
    expect(gets(h)).toHaveLength(1);
    expect(h.clock.sleeps).toEqual([]);
  });

  it("a poll answered after exactly 1,000 ms is read normally and polling continues", async () => {
    const h = harness([CREATED], [{ json: { status: "queued", error_code: null }, delayMs: 1_000 }, QUEUED, QUEUED]);
    expect(await h.channel.send(REQUEST)).toEqual({
      kind: "sent",
      providerMessageId: SID,
      polls: [QUEUED_RECORD, QUEUED_RECORD, QUEUED_RECORD],
    });
    expect(gets(h)).toHaveLength(3);
  });

  it("a non-2xx poll is recorded with its HTTP status, polling stops and the message counts as sent", async () => {
    const h = harness([CREATED], [{ status: 500, text: "boom" }]);
    expect(await h.channel.send(REQUEST)).toEqual({
      kind: "sent",
      providerMessageId: SID,
      polls: [{ error: "provider_error", httpStatus: 500 }],
    });
    expect(gets(h)).toHaveLength(1);
  });
});

describe("createTwilioSandbox: never throws", () => {
  it("turns a non-Error rejection from fetch into failed/network", async () => {
    const channel = createTwilioSandbox({
      fetch: () => Promise.reject("socket closed"),
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      from: FROM,
    });
    await expect(channel.send(REQUEST)).resolves.toEqual({
      kind: "failed",
      errorKind: "network",
      errorCode: "",
      providerMessageId: null,
      polls: [],
    });
  });

  it("turns a fetch that throws synchronously into failed/network", async () => {
    const channel = createTwilioSandbox({
      fetch: () => {
        throw new Error("boom");
      },
      accountSid: ACCOUNT_SID,
      authToken: AUTH_TOKEN,
      from: FROM,
    });
    await expect(channel.send(REQUEST)).resolves.toEqual({
      kind: "failed",
      errorKind: "network",
      errorCode: "",
      providerMessageId: null,
      polls: [],
    });
  });

  it("turns a 2xx create with no usable sid into failed/provider_error and does not poll", async () => {
    const h = harness([{ status: 201, text: "not json" }]);
    await expect(h.channel.send(REQUEST)).resolves.toEqual({
      kind: "failed",
      errorKind: "provider_error",
      errorCode: "",
      providerMessageId: null,
      polls: [],
    });
    expect(gets(h)).toEqual([]);
  });
});
