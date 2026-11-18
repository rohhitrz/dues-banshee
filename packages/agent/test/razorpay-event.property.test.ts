// Feature: whatsapp-channel, Property 7: Webhook outcome and Payment_Day
// Validates: Requirements 6.3, 6.5, 6.6
import type { CalendarDate } from "@dues-banshee/engine";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  classifyRazorpayEvent,
  PAYMENT_LINK_PAID,
  parseRazorpayEvent,
  paymentDay,
  type RazorpayOutcome,
  type StoredPayLink,
} from "../src/webhooks/razorpay-event";

const NUM_RUNS = 200;
const OUTCOMES: readonly RazorpayOutcome[] = [
  "paid",
  "already_paid",
  "ignored_event_type",
  "unknown_link",
  "amount_mismatch",
  "invalid_payload",
];

// ---------- generators ----------

const arbDate = fc
  .date({ min: new Date("2000-01-01T00:00:00Z"), max: new Date("2099-12-31T00:00:00Z"), noInvalidDate: true })
  .map((d) => d.toISOString().slice(0, 10) as CalendarDate);

const arbPaise = fc.integer({ min: 0, max: 2_000_000_000 });
/** Unix seconds from 1970 to about 2096, so the independent Intl computation stays in range. */
const arbSeconds = fc.integer({ min: 0, max: 4_000_000_000 });

const arbOtherType = fc.oneof(
  fc.constantFrom(
    "payment.captured",
    "payment_link.expired",
    "payment_link.cancelled",
    "payment_link.partially_paid",
    "payment.failed",
    "PAYMENT_LINK.PAID",
    "payment_link.paid ",
    "",
  ),
  fc.string({ maxLength: 30 }),
).filter((t) => t !== PAYMENT_LINK_PAID);

interface PaidFields {
  id: string;
  amount: number;
  createdAt: number;
}

const arbPaidFields: fc.Arbitrary<PaidFields> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 30 }),
  amount: arbPaise,
  createdAt: arbSeconds,
});

function paidBody(f: PaidFields): Record<string, unknown> {
  return {
    event: PAYMENT_LINK_PAID,
    payload: {
      payment_link: { entity: { id: f.id, amount_paid: f.amount, status: "paid" } },
      payment: { entity: { created_at: f.createdAt, method: "upi" } },
    },
  };
}

/** Each mutator turns a valid `payment_link.paid` body into one the schema must reject. */
const MALFORMERS: ReadonlyArray<(body: Record<string, unknown>) => unknown> = [
  (b) => ({ event: b.event }),
  (b) => ({ event: b.event, payload: null }),
  (b) => ({ event: b.event, payload: {} }),
  (b) => ({ event: b.event, payload: { payment_link: { entity: { id: "x", amount_paid: 1 } } } }),
  (b) => ({ event: b.event, payload: { payment: { entity: { created_at: 1 } } } }),
  (b) => ({ event: b.event, payload: { payment_link: {}, payment: { entity: { created_at: 1 } } } }),
  (b) => withPath(b, "payment_link", { id: "", amount_paid: 100 }),
  (b) => withPath(b, "payment_link", { amount_paid: 100 }),
  (b) => withPath(b, "payment_link", { id: 42, amount_paid: 100 }),
  (b) => withPath(b, "payment_link", { id: "plink_1", amount_paid: -1 }),
  (b) => withPath(b, "payment_link", { id: "plink_1", amount_paid: 10.5 }),
  (b) => withPath(b, "payment_link", { id: "plink_1", amount_paid: "100" }),
  (b) => withPath(b, "payment_link", { id: "plink_1", amount_paid: null }),
  (b) => withPath(b, "payment_link", { id: "plink_1" }),
  (b) => withPath(b, "payment", { created_at: -5 }),
  (b) => withPath(b, "payment", { created_at: 1.5 }),
  (b) => withPath(b, "payment", { created_at: "1700000000" }),
  (b) => withPath(b, "payment", { created_at: Number.MAX_SAFE_INTEGER }),
  (b) => withPath(b, "payment", {}),
];

function withPath(body: Record<string, unknown>, key: "payment_link" | "payment", entity: unknown): unknown {
  const payload = { ...(body.payload as Record<string, unknown>), [key]: { entity } };
  return { ...body, payload };
}

type Case =
  | { kind: "ignored_event_type"; json: unknown }
  | { kind: "invalid_payload"; json: unknown }
  | { kind: "paid_event"; fields: PaidFields; json: unknown };

const arbIgnored: fc.Arbitrary<Case> = fc
  .tuple(arbOtherType, arbPaidFields, fc.boolean())
  .map(([type, f, keepPayload]) => ({
    kind: "ignored_event_type" as const,
    json: keepPayload ? { ...paidBody(f), event: type } : { event: type },
  }));

const arbInvalid: fc.Arbitrary<Case> = fc.oneof(
  // Malformed payment_link.paid events.
  fc
    .tuple(arbPaidFields, fc.constantFrom(...MALFORMERS))
    .map(([f, mutate]) => ({ kind: "invalid_payload" as const, json: mutate(paidBody(f)) })),
  // Bodies with no string `event`.
  fc
    .constantFrom<unknown>(null, undefined, 0, 7, "payment_link.paid", true, [], [PAYMENT_LINK_PAID], {}, { event: null }, {
      event: 5,
    }, { event: { a: 1 } }, { Event: PAYMENT_LINK_PAID })
    .map((json) => ({ kind: "invalid_payload" as const, json })),
);

const arbPaidEvent: fc.Arbitrary<Case> = arbPaidFields.map((fields) => ({
  kind: "paid_event" as const,
  fields,
  json: paidBody(fields),
}));

type LinkState = "none" | "matching" | "unmatching";

const arbLink = (amountPaid: number) =>
  fc
    .tuple(
      fc.constantFrom<LinkState>("none", "matching", "unmatching"),
      fc.integer({ min: 1, max: 2_000_000_000 }),
      fc.option(arbDate, { nil: null }),
    )
    .map(([state, delta, paidOn]) => {
      const link: StoredPayLink | null =
        state === "none"
          ? null
          : { amountPaise: state === "matching" ? amountPaid : amountPaid + delta, paidOn };
      return { state, link, paidOn };
    });

// ---------- independent oracle ----------

/** IST calendar date of Unix seconds, computed by Intl (tz database), not by the engine's arithmetic. */
function istDateViaIntl(seconds: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(seconds * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// ---------- properties ----------

describe("Property 7: Webhook outcome and Payment_Day", () => {
  it("classifies every event and link state into exactly the outcome the design's order dictates", () => {
    const arbScenario = fc.oneof(arbIgnored, arbInvalid, arbPaidEvent).chain((c) =>
      arbLink(c.kind === "paid_event" ? c.fields.amount : 0).map((l) => ({ c, l })),
    );
    fc.assert(
      fc.property(arbScenario, ({ c, l }) => {
        const event = parseRazorpayEvent(c.json);
        const outcome = classifyRazorpayEvent(event, l.link);
        expect(OUTCOMES).toContain(outcome);

        let expected: RazorpayOutcome;
        if (c.kind === "ignored_event_type") expected = "ignored_event_type";
        else if (c.kind === "invalid_payload") expected = "invalid_payload";
        else if (l.state === "none") expected = "unknown_link";
        else if (l.state === "unmatching") expected = "amount_mismatch";
        else if (l.paidOn !== null) expected = "already_paid";
        else expected = "paid";
        expect(outcome).toEqual(expected);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("ignores a non-paid event type whatever the link state, and never reads the link for invalid payloads", () => {
    fc.assert(
      fc.property(
        fc.oneof(arbIgnored, arbInvalid),
        fc.option(fc.record({ amountPaise: arbPaise, paidOn: fc.option(arbDate, { nil: null }) }), { nil: null }),
        (c, link) => {
          const outcome = classifyRazorpayEvent(parseRazorpayEvent(c.json), link);
          expect(outcome).toEqual(c.kind);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("parses a valid payment_link.paid body into exactly its three fields", () => {
    fc.assert(
      fc.property(arbPaidFields, (f) => {
        expect(parseRazorpayEvent(paidBody(f))).toEqual({
          type: PAYMENT_LINK_PAID,
          paid: { linkId: f.id, amountPaidPaise: f.amount, paymentCreatedAtSec: f.createdAt },
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("never throws on arbitrary JSON and returns one known outcome", () => {
    fc.assert(
      fc.property(fc.anything(), fc.option(fc.record({ amountPaise: arbPaise, paidOn: fc.constant(null) }), { nil: null }), (json, link) => {
        const event = parseRazorpayEvent(json);
        expect(OUTCOMES).toContain(classifyRazorpayEvent(event, link));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("paymentDay is the link's created_on for the demo supplier, whatever the payment time", () => {
    fc.assert(
      fc.property(arbDate, arbSeconds, (createdOn, sec) => {
        expect(paymentDay(true, createdOn, sec)).toEqual(createdOn);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("paymentDay for other suppliers equals the Asia/Kolkata calendar date of the payment time, whatever created_on is", () => {
    fc.assert(
      fc.property(arbDate, arbSeconds, (createdOn, sec) => {
        expect(paymentDay(false, createdOn, sec)).toEqual(istDateViaIntl(sec));
      }),
      { numRuns: 500 },
    );
  });

  it("paymentDay flips at 18:30:00 UTC (IST midnight), with exact boundary examples", () => {
    const sec = (iso: string) => Date.parse(iso) / 1000;
    const any: CalendarDate = "2026-01-01";
    expect(paymentDay(false, any, sec("2026-11-11T18:29:59.000Z"))).toEqual("2026-11-11");
    expect(paymentDay(false, any, sec("2026-11-11T18:30:00.000Z"))).toEqual("2026-11-12");
    expect(paymentDay(false, any, sec("2026-11-11T00:00:00.000Z"))).toEqual("2026-11-11");
    expect(paymentDay(false, any, sec("2026-11-11T23:59:59.000Z"))).toEqual("2026-11-12");
    // Financial-year end: 31 March 18:29:59 UTC is still 31 March in IST, 18:30 UTC is 1 April.
    expect(paymentDay(false, any, sec("2027-03-31T18:29:59.000Z"))).toEqual("2027-03-31");
    expect(paymentDay(false, any, sec("2027-03-31T18:30:00.000Z"))).toEqual("2027-04-01");
    // Year end and leap day.
    expect(paymentDay(false, any, sec("2026-12-31T18:30:00.000Z"))).toEqual("2027-01-01");
    expect(paymentDay(false, any, sec("2028-02-28T18:30:00.000Z"))).toEqual("2028-02-29");
    // Unix epoch is 05:30 on 1 Jan 1970 in IST.
    expect(paymentDay(false, any, 0)).toEqual("1970-01-01");
    // Demo supplier ignores the payment time.
    expect(paymentDay(true, "2026-11-12", sec("2027-03-31T18:30:00.000Z"))).toEqual("2026-11-12");
  });
});
