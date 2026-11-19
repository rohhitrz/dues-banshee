import { describe, expect, it } from "vitest";
import { fakeClock, fakeHttp, type FakeResponseSpec } from "@dues-banshee/agent/testing";
import { createOpenAiRealtime, sessionConfigBody } from "../src/index";
import type { VoiceSessionSpec } from "../src/index";

const URL_SECRETS = "https://api.openai.com/v1/realtime/client_secrets";
const API_KEY = "sk-test-STANDARD-KEY-do-not-leak-0123456789";
const EPHEMERAL = "ek_test_ephemeral_value";

const SPEC: VoiceSessionSpec = {
  instructions: "You are a polite AI assistant calling for a supplier.",
  tools: [
    {
      name: "get_invoice_facts",
      description: "Returns the invoice facts.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "record_promise_to_pay",
      description: "Records a promise.",
      parameters: {
        type: "object",
        properties: { amount_paise: { type: "integer" }, date_iso: { type: "string" } },
        required: ["amount_paise", "date_iso"],
      },
    },
  ],
};

function setup(responses: FakeResponseSpec[], model = "gpt-realtime-2.1-mini") {
  const clock = fakeClock();
  const http = fakeHttp([{ method: "POST", url: URL_SECRETS, responses }], { clock });
  const provider = createOpenAiRealtime({
    fetch: http.fetch,
    apiKey: API_KEY,
    model,
    timeoutSignal: clock.timeoutSignal,
  });
  return { clock, http, provider };
}

const OK: FakeResponseSpec = { json: { value: EPHEMERAL, expires_at: 1_800_000_060 } };

describe("createOpenAiRealtime", () => {
  it("exposes the provider name and the SDP connect URL", () => {
    const { provider } = setup([]);
    expect(provider.name).toBe("openai_realtime");
    expect(provider.connectUrl).toBe("https://api.openai.com/v1/realtime/calls");
  });

  it("sends exactly one POST to client_secrets with a Bearer header and the Session_Config body", async () => {
    const { http, provider } = setup([OK]);
    await provider.mintKey(SPEC);

    expect(http.requests).toHaveLength(1);
    const req = http.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(URL_SECRETS);
    expect(req.headers["authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(req.headers["content-type"]).toContain("application/json");
    expect(req.body).toEqual({
      expires_after: { anchor: "created_at", seconds: 60 },
      session: {
        type: "realtime",
        model: "gpt-realtime-2.1-mini",
        instructions: SPEC.instructions,
        audio: {
          input: {
            transcription: { model: "gpt-live-transcribe" },
            turn_detection: { type: "semantic_vad" },
          },
          output: { voice: "marin" },
        },
        tools: [
          {
            type: "function",
            name: "get_invoice_facts",
            description: "Returns the invoice facts.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
          {
            type: "function",
            name: "record_promise_to_pay",
            description: "Records a promise.",
            parameters: SPEC.tools[1]!.parameters,
          },
        ],
        tool_choice: "auto",
      },
    });
  });

  it("puts the configured model in the body", async () => {
    const { http, provider } = setup([OK], "gpt-realtime-2.1");
    await provider.mintKey(SPEC);
    expect((http.requests[0]!.body as { session: { model: string } }).session.model).toBe("gpt-realtime-2.1");
  });

  it("keeps the API key out of the request body", async () => {
    const { http, provider } = setup([OK]);
    await provider.mintKey(SPEC);
    expect(http.requests[0]!.rawBody).not.toContain(API_KEY);
  });

  it("returns the ephemeral key and its expiry on success", async () => {
    const { provider } = setup([OK]);
    const result = await provider.mintKey(SPEC);
    expect(result).toEqual({ ok: true, value: EPHEMERAL, expiresAt: 1_800_000_060 });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it.each([400, 401, 429, 500, 503])("maps HTTP %i to a typed http failure with the status", async (status) => {
    const { http, provider } = setup([{ status, json: { error: { message: `bad key ${API_KEY}` } } }]);
    const result = await provider.mintKey(SPEC);
    expect(result).toEqual({ ok: false, error: "http", httpStatus: status });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(http.requests).toHaveLength(1);
  });

  it("maps a network error to network", async () => {
    const { http, provider } = setup([{ throws: "network" }]);
    const result = await provider.mintKey(SPEC);
    expect(result).toEqual({ ok: false, error: "network", httpStatus: null });
    expect(http.requests).toHaveLength(1);
  });

  it("maps a thrown TimeoutError to timeout", async () => {
    const { provider } = setup([{ throws: "timeout" }]);
    expect(await provider.mintKey(SPEC)).toEqual({ ok: false, error: "timeout", httpStatus: null });
  });

  it("maps an aborted fake-clock signal (10 s elapsed) to timeout", async () => {
    const { clock, http, provider } = setup([{ delayMs: 10_001, json: { value: EPHEMERAL, expires_at: 1 } }]);
    const result = await provider.mintKey(SPEC);
    expect(result).toEqual({ ok: false, error: "timeout", httpStatus: null });
    expect(clock.now()).toBe(10_001);
    expect(http.requests).toHaveLength(1);
  });

  it("does not time out a response that arrives within 10 s", async () => {
    const { provider } = setup([{ delayMs: 9_000, json: { value: EPHEMERAL, expires_at: 5 } }]);
    expect(await provider.mintKey(SPEC)).toEqual({ ok: true, value: EPHEMERAL, expiresAt: 5 });
  });

  it.each<[string, FakeResponseSpec]>([
    ["not JSON", { text: "<html>gateway</html>" }],
    ["empty body", { text: "" }],
    ["JSON null", { text: "null" }],
    ["missing value", { json: { expires_at: 1 } }],
    ["missing expires_at", { json: { value: EPHEMERAL } }],
    ["value not a string", { json: { value: 123, expires_at: 1 } }],
    ["expires_at not a number", { json: { value: EPHEMERAL, expires_at: "soon" } }],
    ["array body", { json: [EPHEMERAL] }],
  ])("maps a 200 with %s to bad_response", async (_label, response) => {
    const { provider } = setup([response]);
    const result = await provider.mintKey(SPEC);
    expect(result).toEqual({ ok: false, error: "bad_response", httpStatus: 200 });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("never throws, even when fetch throws a non-Error value", async () => {
    const provider = createOpenAiRealtime({
      fetch: () => Promise.reject("boom"),
      apiKey: API_KEY,
      model: "gpt-realtime-2.1-mini",
    });
    const result = await provider.mintKey(SPEC);
    expect(result).toEqual({ ok: false, error: "network", httpStatus: null });
  });

  it("never echoes the API key when the error body or the thrown error contains it", async () => {
    const throwing = createOpenAiRealtime({
      fetch: () => Promise.reject(new Error(`connect failed for ${API_KEY}`)),
      apiKey: API_KEY,
      model: "gpt-realtime-2.1-mini",
    });
    expect(JSON.stringify(await throwing.mintKey(SPEC))).not.toContain(API_KEY);

    const { provider } = setup([{ text: `not json ${API_KEY}` }]);
    expect(JSON.stringify(await provider.mintKey(SPEC))).not.toContain(API_KEY);
  });

  it("makes exactly one request per mintKey call", async () => {
    const { http, provider } = setup([OK, OK]);
    await provider.mintKey(SPEC);
    expect(http.requests).toHaveLength(1);
    await provider.mintKey(SPEC);
    expect(http.requests).toHaveLength(2);
  });
});

describe("sessionConfigBody", () => {
  it("builds the same body the provider sends", () => {
    const body = sessionConfigBody("gpt-realtime-2.1", SPEC) as {
      expires_after: unknown;
      session: { model: string; tool_choice: string };
    };
    expect(body.expires_after).toEqual({ anchor: "created_at", seconds: 60 });
    expect(body.session.model).toBe("gpt-realtime-2.1");
    expect(body.session.tool_choice).toBe("auto");
  });

  it("sends an empty tools array when the spec has no tools", () => {
    const body = sessionConfigBody("gpt-realtime-2.1-mini", { instructions: "x", tools: [] }) as {
      session: { tools: unknown[] };
    };
    expect(body.session.tools).toEqual([]);
  });
});
