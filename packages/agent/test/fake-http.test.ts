import { describe, expect, it } from "vitest";
import {
  UnmockedRequestError,
  collectFetchViolations,
  fakeClock,
  fakeHttp,
} from "../src/testing/fake-http";

const TWILIO = "https://api.twilio.com/2010-04-01/Accounts/ACtest";

describe("fakeHttp", () => {
  it("records method, URL, headers and parsed form and JSON bodies", async () => {
    const http = fakeHttp([
      { method: "POST", url: `${TWILIO}/Messages.json`, responses: [{ status: 201, json: { sid: "SM1" } }] },
      { method: "POST", url: "https://api.razorpay.com/v1/payment_links", responses: [{ json: { id: "plink_1" } }] },
    ]);
    const created = await http.fetch(`${TWILIO}/Messages.json`, {
      method: "POST",
      headers: { Authorization: "Basic abc" },
      body: new URLSearchParams({ From: "whatsapp:+14155550100", Body: "hi\nthere" }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ sid: "SM1" });
    await http.fetch("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 100 }),
    });
    expect(http.requests).toEqual([
      {
        method: "POST",
        url: `${TWILIO}/Messages.json`,
        headers: { authorization: "Basic abc" },
        body: { From: "whatsapp:+14155550100", Body: "hi\nthere" },
        rawBody: "From=whatsapp%3A%2B14155550100&Body=hi%0Athere",
      },
      {
        method: "POST",
        url: "https://api.razorpay.com/v1/payment_links",
        headers: { "content-type": "application/json" },
        body: { amount: 100 },
        rawBody: '{"amount":100}',
      },
    ]);
    expect(http.calls("POST", TWILIO)).toHaveLength(1);
    expect(http.unmatched).toEqual([]);
  });

  it("answers a route's responses in order, with statuses and thrown errors", async () => {
    const http = fakeHttp([
      {
        method: "GET",
        url: `${TWILIO}/Messages/SM1.json`,
        responses: [
          { json: { status: "queued", error_code: null } },
          { status: 500, text: "boom" },
          { throws: "network" },
          { throws: "timeout" },
        ],
      },
    ]);
    const url = `${TWILIO}/Messages/SM1.json`;
    expect(await (await http.fetch(url)).json()).toEqual({ status: "queued", error_code: null });
    const failed = await http.fetch(url);
    expect([failed.status, await failed.text()]).toEqual([500, "boom"]);
    await expect(http.fetch(url)).rejects.toThrow(TypeError);
    await expect(http.fetch(url)).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("picks the longest matching URL prefix and matches on method", async () => {
    const http = fakeHttp([
      { method: "GET", url: "https://api.razorpay.com/v1/payment_links", responses: [{ json: { which: "short" } }] },
      {
        method: "GET",
        url: "https://api.razorpay.com/v1/payment_links?reference_id=",
        responses: [{ json: { which: "lookup" } }],
      },
    ]);
    const lookup = await http.fetch("https://api.razorpay.com/v1/payment_links?reference_id=d1");
    expect(await lookup.json()).toEqual({ which: "lookup" });
    expect(await (await http.fetch("https://api.razorpay.com/v1/payment_links/x")).json()).toEqual({ which: "short" });
  });

  it("records a request no route answers, and an exhausted route, as unmatched", async () => {
    const http = fakeHttp([{ method: "GET", url: "https://a.example/one", responses: [{ json: {} }] }]);
    await http.fetch("https://a.example/one");
    await expect(http.fetch("https://a.example/one")).rejects.toThrow(UnmockedRequestError);
    await expect(http.fetch("https://a.example/two", { method: "POST" })).rejects.toThrow(UnmockedRequestError);
    expect(http.unmatched.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET https://a.example/one",
      "POST https://a.example/two",
    ]);
    // Unmatched requests fail the test unless it drains them, as this one does.
    expect(collectFetchViolations()).toEqual([
      "unmatched by fakeHttp: GET https://a.example/one",
      "unmatched by fakeHttp: POST https://a.example/two",
    ]);
  });

  it("builds a response from a function and lets a test hold a request until another starts", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const http = fakeHttp([
      {
        method: "POST",
        url: "https://a.example/send",
        responses: [
          async (req) => {
            await gate;
            return { json: { echoed: req.body } };
          },
        ],
      },
    ]);
    const pending = http.fetch("https://a.example/send", { method: "POST", body: "plain" });
    release();
    expect(await (await pending).json()).toEqual({ echoed: "plain" });
  });

  describe("delayMs with fakeClock", () => {
    it("returns the response at exactly the timeout and rejects one millisecond later", async () => {
      const clock = fakeClock();
      const http = fakeHttp(
        [
          {
            method: "POST",
            url: "https://a.example/create",
            responses: [{ delayMs: 10_000, json: { ok: 1 } }, { delayMs: 10_001, json: { ok: 2 } }],
          },
        ],
        { clock },
      );
      const first = await http.fetch("https://a.example/create", { method: "POST", signal: clock.timeoutSignal(10_000) });
      expect(await first.json()).toEqual({ ok: 1 });
      await expect(
        http.fetch("https://a.example/create", { method: "POST", signal: clock.timeoutSignal(10_000) }),
      ).rejects.toMatchObject({ name: "TimeoutError" });
    });

    it("refuses a delayMs response when no clock was given", async () => {
      const http = fakeHttp([{ method: "GET", url: "https://a.example/x", responses: [{ delayMs: 5 }] }]);
      await expect(http.fetch("https://a.example/x")).rejects.toThrow("needs the clock option");
    });
  });
});

describe("fakeClock", () => {
  it("records sleeps, advances time and aborts a signal only once it is more than ms old", async () => {
    const clock = fakeClock();
    const signal = clock.timeoutSignal(1_000);
    await clock.sleep(2_000);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toMatchObject({ name: "TimeoutError" });
    const later = clock.timeoutSignal(2_000);
    await clock.sleep(2_000);
    expect(later.aborted).toBe(false);
    clock.advance(1);
    expect(later.aborted).toBe(true);
    expect(clock.sleeps).toEqual([2_000, 2_000]);
    expect(clock.now()).toBe(4_001);
  });
});

describe("fetch guard", () => {
  it("throws UnmockedRequestError for a real fetch and reports it", async () => {
    await expect(fetch("https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json", { method: "POST" })).rejects.toThrow(
      UnmockedRequestError,
    );
    expect(collectFetchViolations()).toEqual([
      "reached the fetch guard: POST https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json",
    ]);
    expect(collectFetchViolations()).toEqual([]);
  });

  it("lets data: URLs through, since they never leave the process", async () => {
    const response = await fetch("data:text/plain;base64,aGk=");
    expect(await response.text()).toBe("hi");
    expect(collectFetchViolations()).toEqual([]);
  });
});
