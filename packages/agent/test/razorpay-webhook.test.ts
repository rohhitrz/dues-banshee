// handleRazorpayWebhook on the Demo_Seed (PGlite, no network): the Razorpay `payment_link.paid` event for
// the Sharma Traders Pay_Link resurrects the tombstone. Exact values for every status, row and outcome.
// The fixture follows Razorpay's sample `payment_link.paid` payload and is signed over the exact raw text.
// Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.8, 6.9, 6.10, 9.6
import { createHmac } from "node:crypto";
import {
  agentRuns,
  getSupplier,
  insertPayLink,
  invoices,
  listGraveyardInvoices,
  paymentLinks,
  webhookEvents,
} from "@dues-banshee/db";
import type { Db } from "@dues-banshee/db";
import type { TestDb } from "@dues-banshee/db/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGraveyard } from "../../../apps/web/lib/graveyard/build-graveyard";
import { readChannelEnv } from "../src/channel/env";
import { loadBankRate } from "../src/load-bank-rate";
import { handleRazorpayWebhook } from "../src/webhooks/razorpay";
import type { RazorpayWebhookRequest } from "../src/webhooks/razorpay";
import type { WebhookResponse } from "../src/webhooks/response";
import {
  CHANNEL_ENV_VALUES,
  DEMO_TODAY,
  MOCK_PAY_LINK_ID,
  MOCK_PAY_LINK_URL,
  SHARMA_AMOUNT_PAISE,
  cloneSendWorld,
  createSendTemplate,
  draftAndApproveSharma,
  toolRowsInOrder,
} from "./helpers/send-fixtures";
import type { SendWorld } from "./helpers/send-fixtures";

const SECRET = CHANNEL_ENV_VALUES.RAZORPAY_WEBHOOK_SECRET;
const EVENT_ID = "evt_PaidSharma0000001";
/** 2026-11-14T08:00:00Z: two days after the link was created, to show the demo Payment_Day is the link's day. */
const PAYMENT_CREATED_AT_SEC = Date.UTC(2026, 10, 14, 8, 0, 0) / 1000;

let template: TestDb;
let prepared: SendWorld;
let payLinkRowId: string;
const open: TestDb[] = [];

beforeAll(async () => {
  template = await createSendTemplate();
  prepared = await cloneSendWorld(template);
  const draftId = await draftAndApproveSharma(prepared);
  const stored = await insertPayLink(prepared.db, {
    invoiceId: prepared.invoiceId,
    draftId,
    link: { providerLinkId: MOCK_PAY_LINK_ID, url: MOCK_PAY_LINK_URL, amountPaise: SHARMA_AMOUNT_PAISE },
    createdOn: DEMO_TODAY,
  });
  expect(stored).toEqual("ok");
  const [row] = await prepared.db.select({ id: paymentLinks.id }).from(paymentLinks);
  if (row === undefined) throw new Error("pay link missing");
  payLinkRowId = row.id;
});

afterAll(async () => {
  await prepared.t.close();
  await template.close();
});

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  errorSpy.mockRestore();
  await Promise.all(open.splice(0).map((t) => t.close()));
});

async function world(): Promise<SendWorld> {
  const w = await cloneSendWorld(prepared.t);
  open.push(w.t);
  return w;
}

// ---------------------------------------------------------------------------
// Fixture, signing and requests
// ---------------------------------------------------------------------------

/** Razorpay's sample `payment_link.paid` event, with the link id, amounts and type set per test. */
function paidEvent(over: { event?: string; linkId?: string; amountPaid?: number } = {}): unknown {
  const linkId = over.linkId ?? MOCK_PAY_LINK_ID;
  const amountPaid = over.amountPaid ?? SHARMA_AMOUNT_PAISE;
  return {
    entity: "event",
    account_id: "acc_BFQ7uQEaa7j2z7",
    event: over.event ?? "payment_link.paid",
    contains: ["payment_link", "order", "payment"],
    payload: {
      payment_link: {
        entity: {
          accept_partial: false,
          amount: SHARMA_AMOUNT_PAISE,
          amount_paid: amountPaid,
          cancelled_at: 0,
          created_at: Date.UTC(2026, 10, 12, 4, 0, 0) / 1000,
          currency: "INR",
          customer: {},
          description: "",
          expire_by: 0,
          expired_at: 0,
          first_min_partial_amount: 0,
          id: linkId,
          notes: { invoice_id: "demo" },
          notify: { email: false, sms: false },
          order_id: "order_Pv0Qh0000000001",
          payments: [
            {
              amount: amountPaid,
              created_at: PAYMENT_CREATED_AT_SEC,
              method: "upi",
              payment_id: "pay_Pv0Qj0000000001",
              status: "captured",
            },
          ],
          reference_id: "",
          reminder_enable: false,
          short_url: MOCK_PAY_LINK_URL,
          status: "paid",
          updated_at: PAYMENT_CREATED_AT_SEC,
          user_id: "",
        },
      },
      order: {
        entity: {
          id: "order_Pv0Qh0000000001",
          entity: "order",
          amount: SHARMA_AMOUNT_PAISE,
          amount_paid: amountPaid,
          currency: "INR",
          status: "paid",
          created_at: PAYMENT_CREATED_AT_SEC,
        },
      },
      payment: {
        entity: {
          id: "pay_Pv0Qj0000000001",
          entity: "payment",
          amount: amountPaid,
          currency: "INR",
          status: "captured",
          order_id: "order_Pv0Qh0000000001",
          method: "upi",
          created_at: PAYMENT_CREATED_AT_SEC,
        },
      },
    },
    created_at: PAYMENT_CREATED_AT_SEC,
  };
}

function sign(raw: string, secret: string = SECRET): string {
  return createHmac("sha256", secret).update(raw).digest("hex");
}

/** A signed delivery over the exact raw text (indented, with a trailing newline, as a proxy might send it). */
function signedRequest(event: unknown, eventId: string | null = EVENT_ID): RazorpayWebhookRequest {
  const rawBody = `${JSON.stringify(event, null, 2)}\n`;
  return { rawBody, signature: sign(rawBody), eventId };
}

function deps(w: SendWorld, over: { db?: Db; secret?: string | undefined } = {}) {
  const secret = "secret" in over ? over.secret : SECRET;
  return {
    db: over.db ?? w.db,
    env: readChannelEnv({ ...CHANNEL_ENV_VALUES, RAZORPAY_WEBHOOK_SECRET: secret }),
    isDemoSupplier: (supplierId: string) => supplierId === w.supplierId,
  };
}

/** The webhook-relevant rows, read back as plain data for before/after comparison. */
async function snapshot(w: SendWorld) {
  const links = await w.db.select().from(paymentLinks);
  const inv = await w.db.select({ id: invoices.id, paidOn: invoices.paidOn }).from(invoices);
  const events = await w.db.select({ provider: webhookEvents.provider, eventId: webhookEvents.eventId }).from(webhookEvents);
  const logs = await w.db.select().from(agentRuns);
  return {
    links: links.sort((a, b) => a.id.localeCompare(b.id)),
    invoices: inv.sort((a, b) => a.id.localeCompare(b.id)),
    events: events.sort((a, b) => a.eventId.localeCompare(b.eventId)),
    logs: logs.map((l) => l.id).sort(),
  };
}

async function webhookRows(w: SendWorld) {
  return w.db.select({ provider: webhookEvents.provider, eventId: webhookEvents.eventId }).from(webhookEvents);
}

async function razorpayLogs(w: SendWorld) {
  return (await toolRowsInOrder(w.t))
    .filter((r) => r.tool === "razorpay_webhook")
    .map((r) => ({ invoiceId: r.invoiceId, input: r.input, output: r.output }));
}

async function sharmaPaidOn(w: SendWorld): Promise<string | null> {
  const rows = await w.db.select({ id: invoices.id, paidOn: invoices.paidOn }).from(invoices);
  return rows.find((r) => r.id === w.invoiceId)?.paidOn ?? null;
}

async function linkStatus(w: SendWorld): Promise<string> {
  const [row] = await w.db.select({ status: paymentLinks.status }).from(paymentLinks);
  return row?.status ?? "missing";
}

async function sharmaTombstoneState(w: SendWorld): Promise<string | undefined> {
  const view = buildGraveyard(
    await getSupplier(w.db, w.supplierId),
    await listGraveyardInvoices(w.db, w.supplierId, DEMO_TODAY),
    await loadBankRate(w.db, DEMO_TODAY),
    DEMO_TODAY,
  );
  return view.tombstones.find((t) => t.id === w.invoiceId)?.state;
}

/** Req 6.8: no body holds the secret, a stack trace or SQL text. */
function expectCleanBody(res: WebhookResponse): void {
  expect(res.contentType).toEqual("application/json");
  expect(res.body).not.toContain(SECRET);
  expect(res.body).not.toMatch(/\bat \S+ \(|stack|node_modules|select |insert |update |from "|boom/i);
}

function bodyOf(res: WebhookResponse): unknown {
  return JSON.parse(res.body) as unknown;
}

// ---------------------------------------------------------------------------
// Rejected before any write
// ---------------------------------------------------------------------------

describe("handleRazorpayWebhook: rejected before any write", () => {
  it("answers 503 and changes nothing when the webhook secret is unset", async () => {
    const w = await world();
    const before = await snapshot(w);
    const req = signedRequest(paidEvent());

    const res = await handleRazorpayWebhook(deps(w, { secret: undefined }), req);

    expect(res).toEqual<WebhookResponse>({
      status: 503,
      body: JSON.stringify({ error: "not_configured" }),
      contentType: "application/json",
      revalidateBuyerId: null,
    });
    expectCleanBody(res);
    expect(await snapshot(w)).toEqual(before);
  });

  it("answers 503 for a blank webhook secret", async () => {
    const w = await world();
    const before = await snapshot(w);
    const res = await handleRazorpayWebhook(deps(w, { secret: "   " }), signedRequest(paidEvent()));
    expect(res.status).toEqual(503);
    expect(await snapshot(w)).toEqual(before);
  });

  it("answers 401 and changes nothing for a missing signature", async () => {
    const w = await world();
    const before = await snapshot(w);
    const req: RazorpayWebhookRequest = { ...signedRequest(paidEvent()), signature: null };

    const res = await handleRazorpayWebhook(deps(w), req);

    expect(res).toEqual<WebhookResponse>({
      status: 401,
      body: JSON.stringify({ error: "invalid_signature" }),
      contentType: "application/json",
      revalidateBuyerId: null,
    });
    expectCleanBody(res);
    expect(await snapshot(w)).toEqual(before);
  });

  it("answers 401 and changes nothing for a wrong signature", async () => {
    const w = await world();
    const before = await snapshot(w);
    const base = signedRequest(paidEvent());
    const wrongKey = { ...base, signature: sign(base.rawBody, "some-other-secret") };
    // Signed over a re-serialised body, not the exact raw text that was sent.
    const reserialised = { ...base, signature: sign(JSON.stringify(JSON.parse(base.rawBody))) };

    for (const req of [wrongKey, reserialised, { ...base, signature: "" }]) {
      const res = await handleRazorpayWebhook(deps(w), req);
      expect(res.status).toEqual(401);
      expect(res.body).toEqual(JSON.stringify({ error: "invalid_signature" }));
      expectCleanBody(res);
    }
    expect(await snapshot(w)).toEqual(before);
  });
});

describe("handleRazorpayWebhook: isDemoSupplier is lazy", () => {
  it("is not called for an unset secret, a missing or wrong signature", async () => {
    const w = await world();
    const isDemoSupplier = vi.fn(() => true);
    const base = signedRequest(paidEvent());
    const cases = [
      { d: deps(w, { secret: undefined }), req: base, status: 503 },
      { d: deps(w), req: { ...base, signature: null }, status: 401 },
      { d: deps(w), req: { ...base, signature: sign(base.rawBody, "some-other-secret") }, status: 401 },
    ];
    for (const c of cases) {
      const res = await handleRazorpayWebhook({ ...c.d, isDemoSupplier }, c.req);
      expect(res.status).toEqual(c.status);
    }
    expect(isDemoSupplier).not.toHaveBeenCalled();
  });
  it("is awaited, with the matching supplier id, when a signed paid event is applied", async () => {
    const w = await world();
    const isDemoSupplier = vi.fn(async (supplierId: string) => supplierId === w.supplierId);
    const res = await handleRazorpayWebhook({ ...deps(w), isDemoSupplier }, signedRequest(paidEvent()));
    expect(res.status).toEqual(200);
    expect(isDemoSupplier.mock.calls).toEqual([[w.supplierId]]);
    expect(await sharmaPaidOn(w)).toEqual("2026-11-12");
  });
});
// ---------------------------------------------------------------------------
// The paid event
// ---------------------------------------------------------------------------

describe("handleRazorpayWebhook: payment_link.paid for the Sharma Pay_Link", () => {
  it("marks the link paid, sets paid_on to the link's day and resurrects the tombstone", async () => {
    const w = await world();
    expect(await sharmaTombstoneState(w)).toEqual("armed");
    expect(await sharmaPaidOn(w)).toEqual(null);
    expect(await linkStatus(w)).toEqual("created");

    const res = await handleRazorpayWebhook(deps(w), signedRequest(paidEvent()));

    expect(res).toEqual<WebhookResponse>({
      status: 200,
      body: JSON.stringify({ status: "ok" }),
      contentType: "application/json",
      revalidateBuyerId: w.buyerId,
    });
    expectCleanBody(res);
    expect(await linkStatus(w)).toEqual("paid");
    expect(await sharmaPaidOn(w)).toEqual("2026-11-12");
    expect(await webhookRows(w)).toEqual([{ provider: "razorpay", eventId: EVENT_ID }]);
    expect(await razorpayLogs(w)).toEqual([
      {
        invoiceId: w.invoiceId,
        input: { eventId: EVENT_ID, eventType: "payment_link.paid" },
        output: { payLinkId: payLinkRowId, amountPaid: SHARMA_AMOUNT_PAISE, outcome: "paid" },
      },
    ]);
    expect(await sharmaTombstoneState(w)).toEqual("resurrected");
  });

  it("applies one change for a repeated event id, sequentially", async () => {
    const w = await world();
    const req = signedRequest(paidEvent());

    const first = await handleRazorpayWebhook(deps(w), req);
    const afterFirst = await snapshot(w);
    const second = await handleRazorpayWebhook(deps(w), req);

    expect(first.status).toEqual(200);
    expect(first.revalidateBuyerId).toEqual(w.buyerId);
    expect(second).toEqual<WebhookResponse>({
      status: 200,
      body: JSON.stringify({ status: "ok" }),
      contentType: "application/json",
      revalidateBuyerId: null,
    });
    const after = await snapshot(w);
    expect({ ...after, logs: undefined }).toEqual({ ...afterFirst, logs: undefined });
    expect(await webhookRows(w)).toEqual([{ provider: "razorpay", eventId: EVENT_ID }]);
    expect(await sharmaPaidOn(w)).toEqual("2026-11-12");
    expect((await razorpayLogs(w)).map((r) => (r.output as { outcome: string }).outcome)).toEqual(["paid", "duplicate"]);
  });

  it("applies one change for a repeated event id delivered at the same time", async () => {
    const w = await world();
    const req = signedRequest(paidEvent());

    const [a, b] = await Promise.all([
      handleRazorpayWebhook(deps(w), req),
      handleRazorpayWebhook(deps(w), req),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body, b.body]).toEqual([JSON.stringify({ status: "ok" }), JSON.stringify({ status: "ok" })]);
    // Exactly one delivery committed the change and asks for the revalidation.
    expect([a.revalidateBuyerId, b.revalidateBuyerId].filter((id) => id !== null)).toEqual([w.buyerId]);
    expect(await webhookRows(w)).toEqual([{ provider: "razorpay", eventId: EVENT_ID }]);
    expect(await linkStatus(w)).toEqual("paid");
    expect(await sharmaPaidOn(w)).toEqual("2026-11-12");
    const outcomes = (await razorpayLogs(w)).map((r) => (r.output as { outcome: string }).outcome).sort();
    expect(outcomes).toEqual(["duplicate", "paid"]);
    expect(await sharmaTombstoneState(w)).toEqual("resurrected");
  });
});

// ---------------------------------------------------------------------------
// Recorded and ignored
// ---------------------------------------------------------------------------

describe("handleRazorpayWebhook: events that change nothing", () => {
  const cases: {
    name: string;
    event: () => unknown;
    outcome: string;
    linked: boolean;
    amountPaid: number | null;
    eventType: string;
  }[] = [
    {
      name: "an amount that differs from the Pay_Amount",
      event: () => paidEvent({ amountPaid: SHARMA_AMOUNT_PAISE - 1 }),
      outcome: "amount_mismatch",
      linked: true,
      amountPaid: SHARMA_AMOUNT_PAISE - 1,
      eventType: "payment_link.paid",
    },
    {
      name: "a payment link id that matches no stored Pay_Link",
      event: () => paidEvent({ linkId: "plink_unknown0000001" }),
      outcome: "unknown_link",
      linked: false,
      amountPaid: SHARMA_AMOUNT_PAISE,
      eventType: "payment_link.paid",
    },
    {
      name: "an event type other than payment_link.paid",
      event: () => paidEvent({ event: "payment_link.expired" }),
      outcome: "ignored_event_type",
      linked: false,
      amountPaid: null,
      eventType: "payment_link.expired",
    },
  ];

  for (const c of cases) {
    it(`records the event id, writes one tool row and changes nothing for ${c.name}`, async () => {
      const w = await world();
      const before = await snapshot(w);

      const res = await handleRazorpayWebhook(deps(w), signedRequest(c.event()));

      expect(res).toEqual<WebhookResponse>({
        status: 200,
        body: JSON.stringify({ status: "ok" }),
        contentType: "application/json",
        revalidateBuyerId: null,
      });
      expectCleanBody(res);
      expect(await webhookRows(w)).toEqual([{ provider: "razorpay", eventId: EVENT_ID }]);
      expect(await razorpayLogs(w)).toEqual([
        {
          invoiceId: c.linked ? w.invoiceId : null,
          input: { eventId: EVENT_ID, eventType: c.eventType },
          output: { payLinkId: c.linked ? payLinkRowId : null, amountPaid: c.amountPaid, outcome: c.outcome },
        },
      ]);
      const after = await snapshot(w);
      expect(after.links).toEqual(before.links);
      expect(after.invoices).toEqual(before.invoices);
      expect(await linkStatus(w)).toEqual("created");
      expect(await sharmaPaidOn(w)).toEqual(null);
      expect(await sharmaTombstoneState(w)).toEqual("armed");
    });
  }

  it("keeps an existing paid_on, marks the link paid and asks for no revalidation when the invoice is already paid", async () => {
    const w = await world();
    await w.t.pglite.query("update invoices set paid_on = $1 where id = $2", ["2026-11-05", w.invoiceId]);

    const res = await handleRazorpayWebhook(deps(w), signedRequest(paidEvent()));

    expect(res).toEqual<WebhookResponse>({
      status: 200,
      body: JSON.stringify({ status: "ok" }),
      contentType: "application/json",
      revalidateBuyerId: null,
    });
    expect(await sharmaPaidOn(w)).toEqual("2026-11-05");
    expect(await linkStatus(w)).toEqual("paid");
    expect(await webhookRows(w)).toEqual([{ provider: "razorpay", eventId: EVENT_ID }]);
    expect(await razorpayLogs(w)).toEqual([
      {
        invoiceId: w.invoiceId,
        input: { eventId: EVENT_ID, eventType: "payment_link.paid" },
        output: { payLinkId: payLinkRowId, amountPaid: SHARMA_AMOUNT_PAISE, outcome: "already_paid" },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Bad requests and failures
// ---------------------------------------------------------------------------

describe("handleRazorpayWebhook: bad requests", () => {
  it("answers 400 with no webhook_events row for a signed body that is not JSON", async () => {
    const w = await world();
    const before = await snapshot(w);
    const rawBody = "{ this is not json";

    const res = await handleRazorpayWebhook(deps(w), { rawBody, signature: sign(rawBody), eventId: EVENT_ID });

    expect(res).toEqual<WebhookResponse>({
      status: 400,
      body: JSON.stringify({ error: "bad_request" }),
      contentType: "application/json",
      revalidateBuyerId: null,
    });
    expectCleanBody(res);
    expect(await webhookRows(w)).toEqual([]);
    const after = await snapshot(w);
    expect(after.links).toEqual(before.links);
    expect(after.invoices).toEqual(before.invoices);
    // The implementation logs the verified delivery with the outcome `invalid_payload` (Req 6.8).
    expect(await razorpayLogs(w)).toEqual([
      {
        invoiceId: null,
        input: { eventId: EVENT_ID, eventType: null },
        output: { payLinkId: null, amountPaid: null, outcome: "invalid_payload" },
      },
    ]);
  });

  it("answers 400 with no webhook_events row when the event id header is missing or blank", async () => {
    const w = await world();
    const before = await snapshot(w);

    for (const eventId of [null, "", "   "]) {
      const res = await handleRazorpayWebhook(deps(w), signedRequest(paidEvent(), eventId));
      expect(res).toEqual<WebhookResponse>({
        status: 400,
        body: JSON.stringify({ error: "bad_request" }),
        contentType: "application/json",
        revalidateBuyerId: null,
      });
      expectCleanBody(res);
    }
    expect(await webhookRows(w)).toEqual([]);
    const after = await snapshot(w);
    expect(after.links).toEqual(before.links);
    expect(after.invoices).toEqual(before.invoices);
    expect((await razorpayLogs(w)).map((r) => (r.output as { outcome: string }).outcome)).toEqual([
      "invalid_payload",
      "invalid_payload",
      "invalid_payload",
    ]);
    expect(await sharmaTombstoneState(w)).toEqual("armed");
  });

  it("records a payment_link.paid event with missing fields as invalid_payload and changes nothing", async () => {
    const w = await world();
    const before = await snapshot(w);
    const broken = { event: "payment_link.paid", payload: { payment_link: { entity: { id: MOCK_PAY_LINK_ID } } } };

    const res = await handleRazorpayWebhook(deps(w), signedRequest(broken));

    expect(res.status).toEqual(200);
    expect(await webhookRows(w)).toEqual([{ provider: "razorpay", eventId: EVENT_ID }]);
    expect(await razorpayLogs(w)).toEqual([
      {
        invoiceId: null,
        input: { eventId: EVENT_ID, eventType: "payment_link.paid" },
        output: { payLinkId: null, amountPaid: null, outcome: "invalid_payload" },
      },
    ]);
    const after = await snapshot(w);
    expect(after.links).toEqual(before.links);
    expect(after.invoices).toEqual(before.invoices);
  });
});

describe("handleRazorpayWebhook: a failing transaction", () => {
  /** A `Db` whose transactions run the real handler body and then throw, so the real rollback happens. */
  function failingAfterWork(db: Db): Db {
    return new Proxy(db, {
      get(target, prop) {
        if (prop === "transaction") {
          return (cb: (tx: Db) => Promise<unknown>, config?: unknown) =>
            (target.transaction as (cb: (tx: Db) => Promise<unknown>, config?: unknown) => Promise<unknown>)(
              async (tx) => {
                await cb(tx);
                throw new Error('boom: insert into "webhook_events" values ($1, $2)');
              },
              config,
            );
        }
        return Reflect.get(target, prop, target) as unknown;
      },
    });
  }

  it("rolls back everything, answers 500 with no detail, and processes a retry of the event id as new", async () => {
    const w = await world();
    const before = await snapshot(w);
    const req = signedRequest(paidEvent());

    const failed = await handleRazorpayWebhook(deps(w, { db: failingAfterWork(w.db) }), req);

    expect(failed).toEqual<WebhookResponse>({
      status: 500,
      body: JSON.stringify({ error: "internal" }),
      contentType: "application/json",
      revalidateBuyerId: null,
    });
    expectCleanBody(failed);
    expect(bodyOf(failed)).toEqual({ error: "internal" });
    expect(await snapshot(w)).toEqual(before);
    expect(await webhookRows(w)).toEqual([]);
    expect(await razorpayLogs(w)).toEqual([]);
    expect(await linkStatus(w)).toEqual("created");
    expect(await sharmaPaidOn(w)).toEqual(null);
    // Only the error's name is logged: its message can carry SQL.
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("insert into");

    const retry = await handleRazorpayWebhook(deps(w), req);

    expect(retry).toEqual<WebhookResponse>({
      status: 200,
      body: JSON.stringify({ status: "ok" }),
      contentType: "application/json",
      revalidateBuyerId: w.buyerId,
    });
    expect(await webhookRows(w)).toEqual([{ provider: "razorpay", eventId: EVENT_ID }]);
    expect(await linkStatus(w)).toEqual("paid");
    expect(await sharmaPaidOn(w)).toEqual("2026-11-12");
    expect((await razorpayLogs(w)).map((r) => (r.output as { outcome: string }).outcome)).toEqual(["paid"]);
  });
});
