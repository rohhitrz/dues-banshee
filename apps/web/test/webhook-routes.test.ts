import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Feature: whatsapp-channel, Req 6.7, 6.11, 8.4, 8.6, 8.7, 9.15: the webhook routes.
// `vi.mock` is hoisted above the imports, so the mocks' state has to be hoisted with it.
const mocks = vi.hoisted(() => ({
  db: { sentinel: "db" } as const,
  close: undefined as unknown as ReturnType<typeof vi.fn>,
  getDb: undefined as unknown as ReturnType<typeof vi.fn>,
  revalidatePath: undefined as unknown as ReturnType<typeof vi.fn>,
  findSupplierIdByUdyam: undefined as unknown as ReturnType<typeof vi.fn>,
  razorpay: undefined as unknown as ReturnType<typeof vi.fn>,
  twilio: undefined as unknown as ReturnType<typeof vi.fn>,
  order: [] as string[],
  actual: undefined as unknown as typeof import("@dues-banshee/agent"),
}));

// The sentinel db is never queried: the real handlers answer 503 before they touch it.
vi.mock("@/lib/db", () => {
  mocks.close = vi.fn(async () => {});
  mocks.getDb = vi.fn(() => ({ db: mocks.db, close: mocks.close }));
  return { getDb: mocks.getDb };
});

vi.mock("next/cache", () => {
  mocks.revalidatePath = vi.fn((path: string) => {
    mocks.order.push(`revalidate:${path}`);
  });
  return { revalidatePath: mocks.revalidatePath };
});

vi.mock("@dues-banshee/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dues-banshee/db")>();
  mocks.findSupplierIdByUdyam = vi.fn(async () => "supplier-demo");
  return { ...actual, findSupplierIdByUdyam: mocks.findSupplierIdByUdyam };
});

// Wrap the real handlers: they run unchanged unless a test overrides the implementation.
vi.mock("@dues-banshee/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dues-banshee/agent")>();
  mocks.actual = actual;
  mocks.razorpay = vi.fn(actual.handleRazorpayWebhook);
  mocks.twilio = vi.fn(actual.handleTwilioInbound);
  return { ...actual, handleRazorpayWebhook: mocks.razorpay, handleTwilioInbound: mocks.twilio };
});

import * as razorpayRoute from "@/app/api/webhooks/razorpay/route";
import * as twilioRoute from "@/app/api/webhooks/twilio/route";

const RAZORPAY_URL = "http://localhost/api/webhooks/razorpay";
const TWILIO_URL = "http://localhost/api/webhooks/twilio";
const BUYER_ID = "22222222-2222-4222-8222-222222222222";

// Whitespace-sensitive and non-ASCII: any parse-and-reserialise would change these bytes.
const RAW_BODY = '{ "event" :  "payment_link.paid",\n\t"note": "₹4,12,000 भुगतान — Sharma ji",  "amount_paid":41200000 }  \n';

const razorpayRequest = (headers: Record<string, string> = {}, body: string = RAW_BODY): Request =>
  new Request(RAZORPAY_URL, { method: "POST", headers, body });

const twilioRequest = (fields: Record<string, string>, headers: Record<string, string> = {}): Request => {
  const form = new URLSearchParams(fields);
  return new Request(TWILIO_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: form.toString(),
  });
};

beforeEach(() => {
  mocks.order.length = 0;
  for (const name of [
    "RAZORPAY_WEBHOOK_SECRET",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_WHATSAPP_FROM",
    "RAZORPAY_KEY_ID",
    "RAZORPAY_KEY_SECRET",
    "PUBLIC_BASE_URL",
  ]) {
    vi.stubEnv(name, "");
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  mocks.close.mockClear();
  mocks.getDb.mockClear();
  mocks.getDb.mockReset();
  mocks.getDb.mockImplementation(() => ({ db: mocks.db, close: mocks.close }));
  mocks.revalidatePath.mockClear();
  mocks.findSupplierIdByUdyam.mockClear();
  mocks.razorpay.mockReset();
  mocks.razorpay.mockImplementation(mocks.actual.handleRazorpayWebhook);
  mocks.twilio.mockReset();
  mocks.twilio.mockImplementation(mocks.actual.handleTwilioInbound);
});

describe("webhook routes: runtime", () => {
  it("runs the Razorpay route on the nodejs runtime", () => {
    expect(razorpayRoute.runtime).toBe("nodejs");
  });

  it("runs the Twilio route on the nodejs runtime", () => {
    expect(twilioRoute.runtime).toBe("nodejs");
  });
});

describe("POST /api/webhooks/razorpay", () => {
  it("answers 503, never 500, when RAZORPAY_WEBHOOK_SECRET is unset", async () => {
    const res = await razorpayRoute.POST(razorpayRequest({ "x-razorpay-signature": "abc", "x-razorpay-event-id": "evt_1" }));

    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ error: "not_configured" });
    expect(mocks.findSupplierIdByUdyam).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("passes the req.text() string unchanged to the handler", async () => {
    vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "whsec-for-tests");
    mocks.razorpay.mockResolvedValue({ status: 200, body: "{}", contentType: "application/json", revalidateBuyerId: null });

    const res = await razorpayRoute.POST(razorpayRequest({ "x-razorpay-signature": "sig-1", "x-razorpay-event-id": "evt_42" }));

    expect(res.status).toBe(200);
    expect(mocks.razorpay).toHaveBeenCalledTimes(1);
    const [deps, input] = mocks.razorpay.mock.calls[0] as [
      { db: unknown; env: { razorpayWebhookSecret?: string }; isDemoSupplier: (id: string) => boolean },
      { rawBody: string; signature: string | null; eventId: string | null },
    ];
    expect(input).toEqual({ rawBody: RAW_BODY, signature: "sig-1", eventId: "evt_42" });
    expect(input.rawBody).toBe(RAW_BODY);
    expect(deps.db).toBe(mocks.db);
    expect(deps.env.razorpayWebhookSecret).toBe("whsec-for-tests");
    // Lazy: nothing is looked up until the handler asks, and then once for any number of asks.
    expect(mocks.findSupplierIdByUdyam).not.toHaveBeenCalled();
    expect(await deps.isDemoSupplier("supplier-demo")).toBe(true);
    expect(await deps.isDemoSupplier("supplier-other")).toBe(false);
    expect(mocks.findSupplierIdByUdyam).toHaveBeenCalledTimes(1);
    expect(mocks.findSupplierIdByUdyam.mock.calls[0]?.[0]).toBe(mocks.db);
  });
  it("makes zero db queries for an unsigned or wrong-signature POST", async () => {
    vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "whsec-for-tests");
    const touched: string[] = [];
    const watched = new Proxy(
      {},
      {
        get: (_target, prop) => {
          touched.push(String(prop));
          throw new Error("db must not be used before the signature check");
        },
      },
    );
    const wrongSignature = createHmac("sha256", "some-other-secret").update(RAW_BODY).digest("hex");
    for (const headers of [
      { "x-razorpay-event-id": "evt_1" },
      { "x-razorpay-signature": "abc", "x-razorpay-event-id": "evt_1" },
      { "x-razorpay-signature": wrongSignature, "x-razorpay-event-id": "evt_1" },
    ]) {
      mocks.getDb.mockReturnValueOnce({ db: watched, close: mocks.close });
      const res = await razorpayRoute.POST(razorpayRequest(headers));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_signature" });
    }
    expect(touched).toEqual([]);
    expect(mocks.findSupplierIdByUdyam).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("passes null for missing signature and event id headers", async () => {
    vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "whsec-for-tests");
    mocks.razorpay.mockResolvedValue({ status: 401, body: "{}", contentType: "application/json", revalidateBuyerId: null });

    await razorpayRoute.POST(razorpayRequest());

    expect(mocks.razorpay.mock.calls[0]?.[1]).toEqual({ rawBody: RAW_BODY, signature: null, eventId: null });
  });

  it("revalidates / and /debtors/<id> before the response is returned for a paid result", async () => {
    vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "whsec-for-tests");
    mocks.razorpay.mockImplementation(async () => {
      mocks.order.push("handler");
      return { status: 200, body: '{"ok":true}', contentType: "application/json", revalidateBuyerId: BUYER_ID };
    });

    const res = await razorpayRoute.POST(razorpayRequest({ "x-razorpay-signature": "s", "x-razorpay-event-id": "evt_paid" }));
    mocks.order.push("response");

    expect(mocks.revalidatePath.mock.calls).toEqual([["/"], [`/debtors/${BUYER_ID}`]]);
    expect(mocks.order).toEqual(["handler", "revalidate:/", `revalidate:/debtors/${BUYER_ID}`, "response"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe('{"ok":true}');
  });

  it("does not revalidate when no invoice changed", async () => {
    vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "whsec-for-tests");
    mocks.razorpay.mockResolvedValue({ status: 200, body: "{}", contentType: "application/json", revalidateBuyerId: null });

    await razorpayRoute.POST(razorpayRequest({ "x-razorpay-signature": "s", "x-razorpay-event-id": "evt_dup" }));

    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("still answers the handler's 200 when the cache purge throws (the payment is committed)", async () => {
    vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "whsec-for-tests");
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.razorpay.mockResolvedValue({ status: 200, body: "{}", contentType: "application/json", revalidateBuyerId: BUYER_ID });
    mocks.revalidatePath.mockImplementationOnce(() => {
      throw new Error("purge failed");
    });

    const res = await razorpayRoute.POST(razorpayRequest({ "x-razorpay-signature": "s", "x-razorpay-event-id": "evt_x" }));

    expect(res.status).toBe(200);
  });

  it("answers 500 with only { error: internal } when the handler throws", async () => {
    vi.stubEnv("RAZORPAY_WEBHOOK_SECRET", "whsec-for-tests");
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.razorpay.mockRejectedValue(new Error("connection string postgres://user:pw@host/db"));

    const res = await razorpayRoute.POST(razorpayRequest({ "x-razorpay-signature": "s", "x-razorpay-event-id": "evt_x" }));

    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"internal"}');
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/webhooks/twilio", () => {
  it("answers 503, never 500, when TWILIO_AUTH_TOKEN and PUBLIC_BASE_URL are unset", async () => {
    const res = await twilioRoute.POST(twilioRequest({ MessageSid: "SM1", From: "whatsapp:+919000000001", Body: "ok" }, { "x-twilio-signature": "abc" }));

    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ error: "not_configured" });
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("answers 503 when only the auth token is set", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "twilio-token-for-tests");

    const res = await twilioRoute.POST(twilioRequest({ MessageSid: "SM1" }, { "x-twilio-signature": "abc" }));

    expect(res.status).toBe(503);
  });

  it("passes string-only form params and the signature header to the handler", async () => {
    mocks.twilio.mockResolvedValue({ status: 200, body: "<Response/>", contentType: "text/xml", revalidateBuyerId: null });

    const res = await twilioRoute.POST(
      twilioRequest({ MessageSid: "SM1", From: "whatsapp:+919000000001", Body: "हाँ, कल भेजता हूँ" }, { "x-twilio-signature": "sig-t" }),
    );

    expect(mocks.twilio).toHaveBeenCalledTimes(1);
    const [deps, input] = mocks.twilio.mock.calls[0] as [{ db: unknown }, { params: Record<string, string>; signature: string | null }];
    expect(deps.db).toBe(mocks.db);
    expect(input).toEqual({
      params: { MessageSid: "SM1", From: "whatsapp:+919000000001", Body: "हाँ, कल भेजता हूँ" },
      signature: "sig-t",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/xml");
    expect(await res.text()).toBe("<Response/>");
  });

  it("hands an unparsable body to the handler as empty params with a null signature", async () => {
    mocks.twilio.mockResolvedValue({ status: 503, body: "{}", contentType: "application/json", revalidateBuyerId: null });

    await twilioRoute.POST(new Request(TWILIO_URL, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));

    expect(mocks.twilio.mock.calls[0]?.[1]).toEqual({ params: {}, signature: null });
  });

  it("answers 500 with only { error: internal } when the handler throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.twilio.mockRejectedValue(new Error("boom"));

    const res = await twilioRoute.POST(twilioRequest({ MessageSid: "SM1" }));

    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"internal"}');
  });
});
