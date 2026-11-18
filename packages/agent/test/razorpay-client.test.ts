import { describe, expect, it } from "vitest";
import {
  RAZORPAY_TIMEOUT_MS,
  createRazorpayClient,
  type CreateLinkBody,
  type RazorpayResult,
} from "../src/channel/razorpay";
import { fakeHttp, type FakeResponseSpec } from "../src/testing/fake-http";

const BASE = "https://api.razorpay.com/v1/payment_links";
const KEY_ID = "rzp_test_abc123";
const KEY_SECRET = "test_secret_xyz";
const AUTHORIZATION = `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64")}`;
const DRAFT_ID = "5b1f0c1e-7d3a-4c55-9a52-0d6f1f9b2a11";
const OTHER_DRAFT_ID = "9c2e4d6f-1a3b-4c5d-8e7f-0a1b2c3d4e5f";
const LOOKUP_URL = `${BASE}?reference_id=${DRAFT_ID}`;

const BODY: CreateLinkBody = {
  amount: 41200000,
  currency: "INR",
  accept_partial: false,
  reference_id: DRAFT_ID,
  notes: { invoice_id: "0f8fad5b-d9cb-469f-a165-70867728950e" },
  notify: { sms: false, email: false },
};

const LINK = { id: "plink_Test0000000001", short_url: "https://rzp.io/i/test0001", amount: 41200000 };

function clientFor(method: "GET" | "POST", ...responses: FakeResponseSpec[]) {
  const http = fakeHttp([{ method, url: BASE, responses }]);
  const client = createRazorpayClient({ fetch: http.fetch, keyId: KEY_ID, keySecret: KEY_SECRET });
  return { http, client };
}

describe("razorpay client: create", () => {
  it("sends one POST with Basic auth and the exact JSON body", async () => {
    const { http, client } = clientFor("POST", { status: 200, json: { ...LINK, reference_id: DRAFT_ID } });

    const result = await client.create(BODY);

    expect(result).toEqual({
      ok: true,
      value: { providerLinkId: "plink_Test0000000001", url: "https://rzp.io/i/test0001", amountPaise: 41200000 },
    });
    expect(http.requests).toEqual([
      {
        method: "POST",
        url: BASE,
        headers: {
          authorization: AUTHORIZATION,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: {
          amount: 41200000,
          currency: "INR",
          accept_partial: false,
          reference_id: DRAFT_ID,
          notes: { invoice_id: "0f8fad5b-d9cb-469f-a165-70867728950e" },
          notify: { sms: false, email: false },
        },
        rawBody: JSON.stringify(BODY),
      },
    ]);
  });

  it("maps HTTP 400 with the reference id already attempted to already_attempted", async () => {
    const { client } = clientFor("POST", {
      status: 400,
      json: { error: { code: "BAD_REQUEST_ERROR", description: "Payment link reference id already attempted" } },
    });
    expect(await client.create(BODY)).toEqual({ ok: false, errorKind: "already_attempted", httpStatus: 400 });
  });

  it.each<[string, FakeResponseSpec, RazorpayResult<never>]>([
    [
      "another 400",
      { status: 400, json: { error: { code: "BAD_REQUEST_ERROR", description: "The amount must be at least 100" } } },
      { ok: false, errorKind: "provider_error", httpStatus: 400 },
    ],
    [
      "a 400 whose body is not JSON",
      { status: 400, text: "<html>bad request</html>" },
      { ok: false, errorKind: "provider_error", httpStatus: 400 },
    ],
    ["a 500", { status: 500, json: { error: { description: "Server error" } } }, { ok: false, errorKind: "provider_error", httpStatus: 500 }],
    ["a 2xx body that is not JSON", { status: 200, text: "not json" }, { ok: false, errorKind: "provider_error", httpStatus: 200 }],
    ["a 2xx body without short_url", { status: 200, json: { id: "plink_1", amount: 100 } }, { ok: false, errorKind: "provider_error", httpStatus: 200 }],
    ["a timeout", { throws: "timeout" }, { ok: false, errorKind: "timeout", httpStatus: null }],
    ["a network throw", { throws: "network" }, { ok: false, errorKind: "network", httpStatus: null }],
  ])("returns the exact error result for %s", async (_name, response, expected) => {
    const { client } = clientFor("POST", response);
    expect(await client.create(BODY)).toEqual(expected);
  });

  it("does not throw and makes one call only, with no retry", async () => {
    const { http, client } = clientFor("POST", { status: 500 });
    await client.create(BODY);
    expect(http.calls("POST", BASE)).toHaveLength(1);
  });
});

describe("razorpay client: findByReference", () => {
  it("sends one GET with Basic auth and the Draft id in the query", async () => {
    const { http, client } = clientFor("GET", { json: { payment_links: [] } });

    await client.findByReference(DRAFT_ID);

    expect(http.requests).toEqual([
      {
        method: "GET",
        url: LOOKUP_URL,
        headers: { authorization: AUTHORIZATION, accept: "application/json" },
        body: null,
        rawBody: null,
      },
    ]);
  });

  it("returns the link whose reference_id is the Draft id", async () => {
    const { client } = clientFor("GET", {
      json: { payment_links: [{ ...LINK, reference_id: DRAFT_ID, status: "created" }] },
    });
    expect(await client.findByReference(DRAFT_ID)).toEqual({
      ok: true,
      value: { providerLinkId: "plink_Test0000000001", url: "https://rzp.io/i/test0001", amountPaise: 41200000 },
    });
  });

  it("returns null for an empty list", async () => {
    const { client } = clientFor("GET", { json: { payment_links: [] } });
    expect(await client.findByReference(DRAFT_ID)).toEqual({ ok: true, value: null });
  });

  it("returns null when every entry has another reference_id", async () => {
    const { client } = clientFor("GET", {
      json: {
        payment_links: [
          { ...LINK, reference_id: OTHER_DRAFT_ID },
          { ...LINK, id: "plink_Test0000000002", reference_id: null },
          { ...LINK, id: "plink_Test0000000003" },
        ],
      },
    });
    expect(await client.findByReference(DRAFT_ID)).toEqual({ ok: true, value: null });
  });

  it("skips entries with another reference_id and returns the first match", async () => {
    const { client } = clientFor("GET", {
      json: {
        payment_links: [
          { ...LINK, id: "plink_Other", reference_id: OTHER_DRAFT_ID },
          { ...LINK, id: "plink_First", short_url: "https://rzp.io/i/first", reference_id: DRAFT_ID },
          { ...LINK, id: "plink_Second", short_url: "https://rzp.io/i/second", reference_id: DRAFT_ID },
        ],
      },
    });
    expect(await client.findByReference(DRAFT_ID)).toEqual({
      ok: true,
      value: { providerLinkId: "plink_First", url: "https://rzp.io/i/first", amountPaise: 41200000 },
    });
  });

  it("percent-encodes the Draft id in the query", async () => {
    const { http, client } = clientFor("GET", { json: { payment_links: [] } });
    await client.findByReference("a b&c=d");
    expect(http.requests[0]?.url).toEqual(`${BASE}?reference_id=a%20b%26c%3Dd`);
  });

  it.each<[string, FakeResponseSpec, RazorpayResult<never>]>([
    ["a 500", { status: 500, json: { error: { description: "Server error" } } }, { ok: false, errorKind: "provider_error", httpStatus: 500 }],
    [
      "a 400",
      { status: 400, json: { error: { description: "The api key provided is invalid" } } },
      { ok: false, errorKind: "provider_error", httpStatus: 400 },
    ],
    ["a body that is not JSON", { status: 200, text: "oops" }, { ok: false, errorKind: "provider_error", httpStatus: 200 }],
    ["a body without payment_links", { status: 200, json: { items: [] } }, { ok: false, errorKind: "provider_error", httpStatus: 200 }],
    [
      "a matching entry without short_url",
      { status: 200, json: { payment_links: [{ id: "plink_1", amount: 100, reference_id: DRAFT_ID }] } },
      { ok: false, errorKind: "provider_error", httpStatus: 200 },
    ],
    ["a timeout", { throws: "timeout" }, { ok: false, errorKind: "timeout", httpStatus: null }],
    ["a network throw", { throws: "network" }, { ok: false, errorKind: "network", httpStatus: null }],
  ])("returns the exact error result for %s", async (_name, response, expected) => {
    const { client } = clientFor("GET", response);
    expect(await client.findByReference(DRAFT_ID)).toEqual(expected);
  });
});

describe("razorpay client: timeout", () => {
  it("caps every request at 10 seconds", () => {
    expect(RAZORPAY_TIMEOUT_MS).toEqual(10_000);
  });
});
