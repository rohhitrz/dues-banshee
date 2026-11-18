// The send server actions (`sendPayLink`, `openInWhatsApp`) on a real in-memory Postgres (PGlite) with the
// Demo_Seed. Replaced: the session (`@/auth`), `next/navigation`, `next/cache`, the database handle
// (`@/lib/db`, which returns the PGlite clone) and `fetch` (`fakeHttp` through `vi.stubGlobal`). The send
// flow, the supplier scoping and the Twilio and Razorpay clients are the real code; no request leaves the
// process. Every phone number, key and SID here is fictional.
//
// Every Twilio send in this file ends at status poll 1 (a failed poll or a terminal error), so the clients'
// real two-second sleeps between polls are never reached and no test waits for them.
// Requirements: 1.3, 2.1, 2.7, 2.10, 4.6, 8.2, 9.4, 9.11
import { approveDraft } from "@dues-banshee/agent";
import { fakeHttp, type FakeHttp, type FakeResponse, type FakeRoute } from "@dues-banshee/agent/testing";
import {
  DEMO_SUPPLIER,
  agentRuns,
  buyers,
  escalationEvents,
  findSupplierIdByUdyam,
  insertDraft,
  invoices,
  messages,
  paymentLinks,
  promises,
  seed,
  suppliers,
  type Db,
} from "@dues-banshee/db";
import { cloneTestDb, createTestDb, type TestDb } from "@dues-banshee/db/testing";
import { formatINR } from "@dues-banshee/engine";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  redirect: vi.fn((url: string) => {
    // Next's redirect() never returns: it throws to navigate.
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  revalidatePath: vi.fn(),
  getDb: vi.fn(),
  close: vi.fn(),
  fault: { error: null as Error | null },
}));

vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
// The real `sendDraft`, except when a test sets `mocks.fault.error`: that is how an unexpected error
// (one the send flow does not turn into an outcome) reaches the action.
vi.mock("@dues-banshee/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dues-banshee/agent")>();
  return {
    ...actual,
    sendDraft: async (...args: Parameters<typeof actual.sendDraft>) => {
      if (mocks.fault.error !== null) throw mocks.fault.error;
      return actual.sendDraft(...args);
    },
  };
});

import { openInWhatsApp, sendPayLink, type SendView } from "@/app/(debtor)/debtors/[id]/send-actions";

const TODAY = "2026-11-12";
// 2026-11-12 11:30 IST.
const NOW = Date.parse("2026-11-12T06:00:00Z");
const STALE_URL = "/signin?error=SessionExpired";
const UNKNOWN_ID = "00000000-0000-4000-8000-0000000000aa";
const STALE_SUPPLIER_ID = "00000000-0000-4000-8000-0000000000ff";
const SHARMA_INVOICE_NUMBER = "LPC/26-27/0412";
/** Fictional numbers (+91 900000xxxx is not a real subscriber range). */
const BUYER_NUMBER = "+919000000001";
const FORGED_NUMBER = "+919000000099";

const CHANNEL_ENV = {
  TWILIO_ACCOUNT_SID: "ACdemo0000000000000000000000SENTINEL",
  TWILIO_AUTH_TOKEN: "twilio-auth-token-SENTINEL-61c2e9",
  TWILIO_WHATSAPP_FROM: "+14155550100",
  RAZORPAY_KEY_ID: "rzp_test_SENTINELKEYID",
  RAZORPAY_KEY_SECRET: "razorpay-key-secret-SENTINEL-8d40b7",
  RAZORPAY_WEBHOOK_SECRET: "razorpay-webhook-secret-SENTINEL-3a9f15",
  PUBLIC_BASE_URL: "https://banshee-sentinel.example.test",
  TWILIO_SANDBOX_JOIN_CODE: "orange-tiger",
} as const satisfies Record<string, string>;
type EnvKey = keyof typeof CHANNEL_ENV;
/** The join code is shown to the owner by design (Req 1.3); every other value is a secret or internal. */
const NEVER_RETURNED = Object.entries(CHANNEL_ENV)
  .filter(([key]) => key !== "TWILIO_SANDBOX_JOIN_CODE")
  .map(([, value]) => value);

const TWILIO_BASE = `https://api.twilio.com/2010-04-01/Accounts/${CHANNEL_ENV.TWILIO_ACCOUNT_SID}`;
const TWILIO_CREATE_URL = `${TWILIO_BASE}/Messages.json`;
const TWILIO_SID = "SM0000000000000000000000000000d1";
const RAZORPAY_LINKS_URL = "https://api.razorpay.com/v1/payment_links";
const PAY_LINK_URL = "https://rzp.io/i/demoSharma0412";

const BODY = "Namaste Sharma ji, yeh ek vinamra reminder hai.";
const BASIS = "Basis: MSMED-15 (MSMED Act 2006, s.15); MSMED-16 (MSMED Act 2006, s.16)";
const DISCLAIMER = "Reminders a supplier sends to its own buyers. Not legal advice.";

/** The Outbound_Text for a plain body (no marker) of the Sharma invoice, ₹4,12,000 via formatINR. */
function outboundText(body: string): string {
  return `${body}\n\nPay ${formatINR(41_200_000, "full")} here: ${PAY_LINK_URL}\n\n${BASIS}\n${DISCLAIMER}`;
}

const SANDBOX_HEAD =
  "This number hasn't joined the WhatsApp sandbox in the last 3 days, or its 24-hour window has closed. ";

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

interface World {
  t: TestDb;
  db: Db;
  supplierId: string;
  invoiceId: string;
  buyerId: string;
}

interface ApprovedDraft {
  draftId: string;
  invoiceId: string;
  buyerId: string;
}

let template: TestDb;
let world: World;
let http: FakeHttp;

beforeAll(async () => {
  template = await createTestDb();
  await seed(template.db, { demoBuyerWhatsapp: BUYER_NUMBER });
});

afterAll(async () => {
  await template.close();
});

beforeEach(async () => {
  const t = await cloneTestDb(template);
  const supplierId = await findSupplierIdByUdyam(t.db, DEMO_SUPPLIER.udyamNumber);
  if (supplierId === null) throw new Error("test setup: demo supplier missing after seed");
  const sharma = (await t.db.select().from(invoices)).find((i) => i.invoiceNumber === SHARMA_INVOICE_NUMBER);
  if (sharma === undefined) throw new Error("test setup: Sharma invoice missing after seed");
  world = { t, db: t.db, supplierId, invoiceId: sharma.id, buyerId: sharma.buyerId };

  mocks.auth.mockReset().mockResolvedValue({ supplierId });
  mocks.redirect.mockClear();
  mocks.revalidatePath.mockReset();
  mocks.close.mockReset().mockResolvedValue(undefined);
  mocks.getDb.mockReset().mockReturnValue({ db: t.db, close: mocks.close });
  mocks.fault.error = null;
  useEnv({});
  useHttp([]);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await world.t.close();
});

/** Sets Channel_Env for this test. A value of `""` turns that variable off (it reads as unset). */
function useEnv(over: Partial<Record<EnvKey, string>>): void {
  for (const [key, value] of Object.entries({ ...CHANNEL_ENV, ...over })) vi.stubEnv(key, value);
}

/** Replaces `fetch` for this test. An unrouted request is recorded as unmatched and fails the test. */
function useHttp(routes: readonly FakeRoute[]): FakeHttp {
  http = fakeHttp(routes);
  vi.stubGlobal("fetch", http.fetch);
  return http;
}

interface Responses {
  lookup?: readonly FakeResponse[];
  create?: readonly FakeResponse[];
  twilioCreate?: readonly FakeResponse[];
  twilioPolls?: readonly FakeResponse[];
}

/**
 * The four provider routes. By default: no link yet, one created link for `amountPaise` (it must equal the
 * invoice's, or the send path refuses it), a Twilio SID, then a failed first poll.
 */
function useProviders(draftId: string, over: Responses = {}, amountPaise = 41_200_000): FakeHttp {
  return useHttp([
    {
      method: "GET",
      url: `${RAZORPAY_LINKS_URL}?reference_id=`,
      responses: over.lookup ?? [{ json: { count: 0, payment_links: [] } }],
    },
    {
      method: "POST",
      url: RAZORPAY_LINKS_URL,
      responses: over.create ?? [
        {
          json: { id: "plink_demo0000000001", short_url: PAY_LINK_URL, amount: amountPaise, reference_id: draftId },
        },
      ],
    },
    {
      method: "POST",
      url: TWILIO_CREATE_URL,
      responses: over.twilioCreate ?? [{ status: 201, json: { sid: TWILIO_SID, status: "queued" } }],
    },
    {
      method: "GET",
      url: `${TWILIO_BASE}/Messages/`,
      // A status read that fails keeps the message `sent` after one poll, with no sleep.
      responses: over.twilioPolls ?? [{ throws: "network" }],
    },
  ]);
}

function requestLines(): string[] {
  return http.requests.map((r) => `${r.method} ${r.url}`);
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

type Action = typeof sendPayLink;

/**
 * Runs an action at 2026-11-12 11:30 IST. Every returned view is also checked here: no Channel_Env secret
 * in it, and a `url` only on the WaMe_Link handoff of `openInWhatsApp` (Req 2.10, 4.6, 8.2).
 */
async function act(action: Action, fields: Record<string, string>): Promise<SendView> {
  const spy = vi.spyOn(Date, "now").mockReturnValue(NOW);
  try {
    const view = await action(null, form(fields));
    const serial = JSON.stringify(view);
    for (const secret of NEVER_RETURNED) expect(serial).not.toContain(secret);
    if (action === sendPayLink) expect(view.url).toBeUndefined();
    else expect(view.url !== undefined).toBe(view.text === "Opened in WhatsApp. Tap Send on your phone.");
    return view;
  } finally {
    spy.mockRestore();
  }
}

/** The URL a mocked `redirect` was called with (it throws, as Next's redirect does). */
async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    const match = /^NEXT_REDIRECT (.*)$/.exec((err as Error).message);
    if (match !== null) return match[1]!;
    throw err;
  }
  throw new Error("the action did not redirect");
}

async function snapshot(db: Db) {
  const events = await db.select().from(escalationEvents);
  return {
    messages: (await db.select().from(messages)).length,
    payLinks: (await db.select().from(paymentLinks)).length,
    sentEvents: events.filter((e) => e.action === "sent").length,
    toolRows: (await db.select().from(agentRuns)).length,
  };
}

/** Stores a `whatsapp_nudge` Draft for `invoiceId` and approves it on `TODAY` through the real `approveDraft`. */
async function approvedDraft(
  w: { db: Db; supplierId: string },
  invoiceId: string,
  buyerId: string,
  bodyText = BODY,
): Promise<ApprovedDraft> {
  const stored = await insertDraft(
    w.db,
    {
      invoiceId,
      step: "whatsapp_nudge",
      language: "hinglish",
      bodyText,
      finalText: bodyText,
      ruleIds: ["MSMED-15", "MSMED-16"],
      modelId: "mock-haiku",
      decision: {
        action: "advance",
        applicable: true,
        step: "whatsapp_nudge",
        rank: 1,
        requiresApproval: false,
        ruleIds: ["MSMED-15"],
      },
      document: null,
    },
    TODAY,
  );
  if (stored.kind !== "ok") throw new Error("test setup: a pending draft already exists");
  const approved = await approveDraft({ db: w.db }, w.supplierId, stored.draftId, TODAY);
  if (approved.kind !== "ok") throw new Error(`test setup: approveDraft gave ${approved.kind}`);
  return { draftId: stored.draftId, invoiceId, buyerId };
}

function sharmaDraft(bodyText = BODY): Promise<ApprovedDraft> {
  return approvedDraft(world, world.invoiceId, world.buyerId, bodyText);
}

/** A second, non-demo supplier with one overdue invoice, a buyer without a WhatsApp number and an approved Draft. */
async function otherSupplier(): Promise<ApprovedDraft & { supplierId: string }> {
  const { db } = world;
  const [supplier] = await db
    .insert(suppliers)
    .values({
      name: "Other Supplier",
      udyamNumber: "UDYAM-XX-00-0000001",
      supplierCategory: "micro",
      supplierActivity: "manufacturing",
      udyamRegisteredOn: "2024-04-15",
    })
    .returning({ id: suppliers.id });
  const [buyer] = await db
    .insert(buyers)
    .values({ supplierId: supplier!.id, name: "Other Buyer", nameKey: "other buyer" })
    .returning({ id: buyers.id });
  const [invoice] = await db
    .insert(invoices)
    .values({
      supplierId: supplier!.id,
      buyerId: buyer!.id,
      invoiceNumber: "OS/001",
      invoiceNumberKey: "os/001",
      invoiceDate: "2026-07-01",
      acceptedOn: "2026-07-01",
      amountPaise: 1_000_000,
      supplierCategory: "micro",
      supplierActivity: "manufacturing",
    })
    .returning({ id: invoices.id });
  const draft = await approvedDraft({ db, supplierId: supplier!.id }, invoice!.id, buyer!.id);
  return { ...draft, supplierId: supplier!.id };
}

const ACTIONS: readonly [string, Action][] = [
  ["sendPayLink", sendPayLink],
  ["openInWhatsApp", openInWhatsApp],
];

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

describe("no session", () => {
  for (const [name, action] of ACTIONS) {
    for (const [label, session] of [
      ["null", null],
      ["without a supplierId", {}],
      ["with an empty supplierId", { supplierId: "" }],
    ] as const) {
      it(`${name} with a session ${label} redirects to /signin, calls nothing and writes nothing`, async () => {
        const draft = await sharmaDraft();
        const before = await snapshot(world.db);
        mocks.auth.mockResolvedValue(session);
        useProviders(draft.draftId);

        expect(await redirectOf(() => action(null, form({ draftId: draft.draftId })))).toBe("/signin");

        expect(mocks.redirect.mock.calls).toEqual([["/signin"]]);
        expect(mocks.getDb).not.toHaveBeenCalled();
        expect(http.requests).toEqual([]);
        expect(mocks.revalidatePath).not.toHaveBeenCalled();
        expect(await snapshot(world.db)).toEqual(before);
      });
    }
  }
});

describe("stale session (the supplier row is gone)", () => {
  for (const [name, action] of ACTIONS) {
    it(`${name} redirects exactly once to /signin?error=SessionExpired and never throws a 500`, async () => {
      const draft = await sharmaDraft();
      const before = await snapshot(world.db);
      mocks.auth.mockResolvedValue({ supplierId: STALE_SUPPLIER_ID });
      useProviders(draft.draftId);

      expect(await redirectOf(() => action(null, form({ draftId: draft.draftId })))).toBe(STALE_URL);

      expect(mocks.redirect.mock.calls).toEqual([[STALE_URL]]);
      expect(mocks.close).toHaveBeenCalledTimes(1);
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
      expect(http.requests).toEqual([]);
      expect(await snapshot(world.db)).toEqual(before);
    });
  }
});

// ---------------------------------------------------------------------------
// Forged fields
// ---------------------------------------------------------------------------

describe("forged form fields are ignored", () => {
  it("a forged supplierId, amount, text and phone number change nothing: the stored values are sent", async () => {
    const draft = await sharmaDraft();
    useProviders(draft.draftId);

    const view = await act(sendPayLink, {
      draftId: draft.draftId,
      supplierId: UNKNOWN_ID,
      buyerId: UNKNOWN_ID,
      amount: "1",
      amountPaise: "1",
      text: "FORGED TEXT",
      body: "FORGED TEXT",
      to: FORGED_NUMBER,
      phone: FORGED_NUMBER,
      whatsappNumber: FORGED_NUMBER,
    });

    expect(view).toEqual({
      invoiceId: world.invoiceId,
      text: "Queued with Twilio. Delivery is not tracked.",
      role: "status",
    });
    expect(requestLines()).toEqual([
      `GET ${RAZORPAY_LINKS_URL}?reference_id=${draft.draftId}`,
      `POST ${RAZORPAY_LINKS_URL}`,
      `POST ${TWILIO_CREATE_URL}`,
      `GET ${TWILIO_BASE}/Messages/${TWILIO_SID}.json`,
    ]);
    expect(http.calls("POST", RAZORPAY_LINKS_URL)[0]?.body).toEqual({
      amount: 41_200_000,
      currency: "INR",
      accept_partial: false,
      reference_id: draft.draftId,
      notes: { invoice_id: world.invoiceId },
      notify: { sms: false, email: false },
    });
    expect(http.calls("POST", TWILIO_CREATE_URL)[0]?.body).toEqual({
      From: "whatsapp:+14155550100",
      To: `whatsapp:${BUYER_NUMBER}`,
      Body: outboundText(BODY),
    });
    const stored = await world.db.select().from(messages);
    expect(stored.map((m) => ({ invoiceId: m.invoiceId, body: m.body, status: m.status }))).toEqual([
      { invoiceId: world.invoiceId, body: outboundText(BODY), status: "sent" },
    ]);
    expect(JSON.stringify(http.requests)).not.toContain(FORGED_NUMBER);
    expect(mocks.revalidatePath.mock.calls).toEqual([[`/debtors/${world.buyerId}`]]);
  });

  it("another supplier's session cannot send the demo supplier's Draft, whatever supplierId the form carries", async () => {
    const draft = await sharmaDraft();
    const other = await otherSupplier();
    mocks.auth.mockResolvedValue({ supplierId: other.supplierId });
    useProviders(draft.draftId);
    const before = await snapshot(world.db);

    for (const [, action] of ACTIONS) {
      const view = await act(action, { draftId: draft.draftId, supplierId: world.supplierId });
      expect(view).toEqual({ invoiceId: "", text: "Draft not found", role: "alert" });
    }

    expect(http.requests).toEqual([]);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    expect(await snapshot(world.db)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Demo_Override
// ---------------------------------------------------------------------------

describe("the today override applies only to the demo supplier", () => {
  it("the demo supplier's override moves Today: a Draft approved on 12 Nov 2026 is refused on 10 Mar 2027", async () => {
    const draft = await sharmaDraft();
    useProviders(draft.draftId);
    const before = await snapshot(world.db);

    const view = await act(sendPayLink, { draftId: draft.draftId, today: "2027-03-10" });

    expect(view).toEqual({
      invoiceId: world.invoiceId,
      text: "This draft was approved on 12 Nov 2026. Approve a fresh draft to send today.",
      role: "alert",
    });
    expect(http.requests).toEqual([]);
    expect(await snapshot(world.db)).toEqual(before);
  });

  it("another supplier's override is ignored: Today is the real IST date and the Draft is handed off", async () => {
    const other = await otherSupplier();
    mocks.auth.mockResolvedValue({ supplierId: other.supplierId });
    useProviders(other.draftId, {}, 1_000_000);

    const view = await act(openInWhatsApp, { draftId: other.draftId, today: "2027-03-10" });

    // With the override honoured this would be the `approved_on` text above.
    const text = `${BODY}\n\nPay ${formatINR(1_000_000, "full")} here: ${PAY_LINK_URL}\n\n${BASIS}\n${DISCLAIMER}`;
    expect(view).toEqual({
      invoiceId: other.invoiceId,
      text: "Opened in WhatsApp. Tap Send on your phone.",
      role: "status",
      url: `https://wa.me/?text=${encodeURIComponent(text)}`,
    });
    expect(mocks.revalidatePath.mock.calls).toEqual([[`/debtors/${other.buyerId}`]]);
  });
});

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

describe("each outcome gives its exact text and role", () => {
  it("sent: Queued with Twilio, a status, no url", async () => {
    const draft = await sharmaDraft();
    useProviders(draft.draftId);

    const view = await act(sendPayLink, { draftId: draft.draftId });

    expect(view).toEqual({
      invoiceId: world.invoiceId,
      text: "Queued with Twilio. Delivery is not tracked.",
      role: "status",
    });
    expect(Object.keys(view).sort()).toEqual(["invoiceId", "role", "text"]);
  });

  it("handed_off: openInWhatsApp returns the WaMe_Link URL for the stored number and text", async () => {
    const draft = await sharmaDraft();
    useProviders(draft.draftId);

    const view = await act(openInWhatsApp, { draftId: draft.draftId });

    expect(view).toEqual({
      invoiceId: world.invoiceId,
      text: "Opened in WhatsApp. Tap Send on your phone.",
      role: "status",
      url: `https://wa.me/919000000001?text=${encodeURIComponent(outboundText(BODY))}`,
    });
    // No Twilio call: the owner sends it from their own phone.
    expect(requestLines()).toEqual([
      `GET ${RAZORPAY_LINKS_URL}?reference_id=${draft.draftId}`,
      `POST ${RAZORPAY_LINKS_URL}`,
    ]);
    const stored = await world.db.select().from(messages);
    expect(stored.map((m) => ({ channel: m.channel, status: m.status }))).toEqual([
      { channel: "wa_me", status: "handed_off" },
    ]);
  });

  it("handed_off: writes one wa_me handed_off Message_Row and one sent Escalation_Event, and no Twilio call", async () => {
    const draft = await sharmaDraft();
    useProviders(draft.draftId);

    await act(openInWhatsApp, { draftId: draft.draftId });

    const rows = await world.db.select().from(messages);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect({
      invoiceId: row.invoiceId,
      channel: row.channel,
      direction: row.direction,
      body: row.body,
      status: row.status,
      draftId: row.draftId,
      providerMessageId: row.providerMessageId,
      errorCode: row.errorCode,
    }).toEqual({
      invoiceId: world.invoiceId,
      channel: "wa_me",
      direction: "outbound",
      body: outboundText(BODY),
      status: "handed_off",
      draftId: draft.draftId,
      providerMessageId: null,
      errorCode: null,
    });
    const sent = (await world.db.select().from(escalationEvents)).filter((e) => e.action === "sent");
    expect(sent.map((e) => ({ invoiceId: e.invoiceId, step: e.step, occurredOn: e.occurredOn, draftId: e.draftId, detail: e.detail }))).toEqual([
      {
        invoiceId: world.invoiceId,
        step: "whatsapp_nudge",
        occurredOn: TODAY,
        draftId: draft.draftId,
        detail: { channel: "wa_me", messageRowId: row.id },
      },
    ]);
    expect(http.calls("POST", TWILIO_CREATE_URL)).toEqual([]);
  });

  it("not_found: an unknown id, a non-uuid and a missing field all give Draft not found with no invoice", async () => {
    const draft = await sharmaDraft();
    useProviders(draft.draftId);

    for (const fields of [{ draftId: UNKNOWN_ID }, { draftId: "1; drop table drafts" }, { draftId: "" }, {}]) {
      for (const [, action] of ACTIONS) {
        expect(await act(action, fields)).toEqual({ invoiceId: "", text: "Draft not found", role: "alert" });
      }
    }
    expect(http.requests).toEqual([]);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("cannot_send: a second send of a sent Draft is refused and revalidates nothing more", async () => {
    const draft = await sharmaDraft();
    useProviders(draft.draftId);
    await act(sendPayLink, { draftId: draft.draftId });
    const requestsAfterFirst = http.requests.length;

    const second = await act(sendPayLink, { draftId: draft.draftId });
    const viaWaMe = await act(openInWhatsApp, { draftId: draft.draftId });

    for (const view of [second, viaWaMe]) {
      expect(view).toEqual({ invoiceId: world.invoiceId, text: "This draft can't be sent", role: "alert" });
    }
    expect(http.requests).toHaveLength(requestsAfterFirst);
    expect(mocks.revalidatePath.mock.calls).toEqual([[`/debtors/${world.buyerId}`]]);
    expect((await world.db.select().from(messages)).length).toBe(1);
  });

  it("send_check_failed: a promise recorded after approval gives Not sent with the wait reason", async () => {
    const draft = await sharmaDraft();
    await world.db
      .insert(promises)
      .values({ invoiceId: world.invoiceId, promisedDate: "2026-11-20", amountPaise: 41_200_000, recordedOn: TODAY });
    useProviders(draft.draftId);
    const before = await snapshot(world.db);

    const view = await act(sendPayLink, { draftId: draft.draftId });

    expect(view).toEqual({
      invoiceId: world.invoiceId,
      text: "Not sent: Promise to pay active",
      role: "alert",
    });
    expect(http.requests).toEqual([]);
    // The Send_Check itself writes its one Tool_Log row; nothing else changes.
    expect(await snapshot(world.db)).toEqual({ ...before, toolRows: before.toolRows + 1 });
  });

  it("payments_not_configured: no Razorpay key, and a live key, both give Payments are not configured", async () => {
    const draft = await sharmaDraft();
    for (const over of [{ RAZORPAY_KEY_ID: "" }, { RAZORPAY_KEY_ID: "rzp_live_SENTINELKEYID" }] as const) {
      useEnv(over);
      useProviders(draft.draftId);

      const view = await act(sendPayLink, { draftId: draft.draftId });

      expect(view).toEqual({
        invoiceId: world.invoiceId,
        text: "Payments are not configured",
        role: "alert",
      });
      expect(http.requests).toEqual([]);
    }
  });

  it("pay_link_failed: a failing Razorpay lookup gives the retry text, calls no Twilio and stores no link", async () => {
    const draft = await sharmaDraft();
    useProviders(draft.draftId, { lookup: [{ status: 500, json: { error: { description: "SECRET-PROVIDER-DETAIL" } } }] });

    const view = await act(sendPayLink, { draftId: draft.draftId });

    expect(view).toEqual({
      invoiceId: world.invoiceId,
      text: "The payment link could not be created. Try again.",
      role: "alert",
    });
    expect(JSON.stringify(view)).not.toContain("SECRET-PROVIDER-DETAIL");
    expect(requestLines()).toEqual([`GET ${RAZORPAY_LINKS_URL}?reference_id=${draft.draftId}`]);
    expect((await snapshot(world.db)).payLinks).toBe(0);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("no_buyer_number: a buyer without a WhatsApp number cannot be sent to through Twilio", async () => {
    const other = await otherSupplier();
    mocks.auth.mockResolvedValue({ supplierId: other.supplierId });
    useProviders(other.draftId);

    const view = await act(sendPayLink, { draftId: other.draftId });

    expect(view).toEqual({ invoiceId: other.invoiceId, text: "No WhatsApp number for this buyer", role: "alert" });
    expect(http.requests).toEqual([]);
  });

  it("sender_not_configured: an unset Twilio SID gives WhatsApp sender not configured", async () => {
    const draft = await sharmaDraft();
    useEnv({ TWILIO_ACCOUNT_SID: "" });
    useProviders(draft.draftId);

    const view = await act(sendPayLink, { draftId: draft.draftId });

    expect(view).toEqual({ invoiceId: world.invoiceId, text: "WhatsApp sender not configured", role: "alert" });
    expect(http.requests).toEqual([]);
  });

  it("too_long: a 1,601-character text gives the length message through Twilio but opens through wa.me", async () => {
    const body = "a".repeat(1_601);
    const draft = await sharmaDraft(body);
    useProviders(draft.draftId);

    const view = await act(sendPayLink, { draftId: draft.draftId });

    expect(view).toEqual({
      invoiceId: world.invoiceId,
      text: "Message too long for WhatsApp (max 1,600 characters)",
      role: "alert",
    });
    expect(http.calls("POST", TWILIO_CREATE_URL)).toEqual([]);
    // The link was created and stays stored; the page is refreshed.
    expect((await snapshot(world.db)).payLinks).toBe(1);
    expect(mocks.revalidatePath.mock.calls).toEqual([[`/debtors/${world.buyerId}`]]);

    const viaWaMe = await act(openInWhatsApp, { draftId: draft.draftId });
    expect(viaWaMe.text).toBe("Opened in WhatsApp. Tap Send on your phone.");
    expect(viaWaMe.role).toBe("status");
  });

  it("channel_failed (provider error): a fixed message, never the provider's own text", async () => {
    const draft = await sharmaDraft();
    useProviders(draft.draftId, {
      twilioCreate: [{ status: 401, json: { code: 20003, message: "SECRET-PROVIDER-DETAIL", status: 401 } }],
    });

    const view = await act(sendPayLink, { draftId: draft.draftId });

    expect(view).toEqual({
      invoiceId: world.invoiceId,
      text: "The message was not sent. Try again or use Open in WhatsApp.",
      role: "alert",
    });
    expect(JSON.stringify(view)).not.toContain("SECRET-PROVIDER-DETAIL");
    const stored = await world.db.select().from(messages);
    expect(stored.map((m) => ({ status: m.status, errorCode: m.errorCode }))).toEqual([
      { status: "failed", errorCode: "20003" },
    ]);
    expect((await snapshot(world.db)).sentEvents).toBe(0);
    expect(mocks.revalidatePath.mock.calls).toEqual([[`/debtors/${world.buyerId}`]]);
  });

  it("record_failed: an unexpected error gives the not-recorded text and logs only the error name", async () => {
    const draft = await sharmaDraft();
    useProviders(draft.draftId);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.fault.error = new Error(`connection refused postgres://user:SECRET-DSN@db ${BUYER_NUMBER}`);

    const view = await act(sendPayLink, { draftId: draft.draftId });

    expect(view).toEqual({
      invoiceId: world.invoiceId,
      text: "The message was queued but could not be recorded.",
      role: "alert",
    });
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain("SECRET-DSN");
    expect(logged).not.toContain(BUYER_NUMBER);
    expect(logged).toContain("Error");
    expect(http.requests).toEqual([]);
    // The unexpected-error path may have written a row before it failed, so the buyer's page is refreshed.
    expect(mocks.revalidatePath.mock.calls).toEqual([[`/debtors/${world.buyerId}`]]);
  });
});

describe("the sandbox text names the join code only when TWILIO_SANDBOX_JOIN_CODE is set", () => {
  const SANDBOX_ERROR: FakeResponse = { status: 400, json: { code: 63015, message: "not joined", status: 400 } };

  it("with the code set: send join <code>", async () => {
    const draft = await sharmaDraft();
    useEnv({ TWILIO_SANDBOX_JOIN_CODE: "orange-tiger" });
    useProviders(draft.draftId, { twilioCreate: [SANDBOX_ERROR] });

    const view = await act(sendPayLink, { draftId: draft.draftId });

    expect(view).toEqual({
      invoiceId: world.invoiceId,
      text: `${SANDBOX_HEAD}Ask the buyer to send join orange-tiger to the sandbox number, or use Open in WhatsApp.`,
      role: "alert",
    });
  });

  for (const [label, code] of [
    ["unset", ""],
    ["blank", "   "],
  ] as const) {
    it(`with the code ${label}: point to the Twilio sandbox page, with no placeholder`, async () => {
      const draft = await sharmaDraft();
      useEnv({ TWILIO_SANDBOX_JOIN_CODE: code });
      useProviders(draft.draftId, { twilioCreate: [SANDBOX_ERROR] });

      const view = await act(sendPayLink, { draftId: draft.draftId });

      expect(view).toEqual({
        invoiceId: world.invoiceId,
        text:
          `${SANDBOX_HEAD}Ask the buyer to send the join code from the Twilio sandbox page to the sandbox number, ` +
          "or use Open in WhatsApp.",
        role: "alert",
      });
      expect(view.text).not.toContain("join undefined");
      expect(view.text).not.toContain("join  ");
    });
  }

  it("a 63015 on the first status poll gives the same text", async () => {
    const draft = await sharmaDraft();
    useProviders(draft.draftId, { twilioPolls: [{ json: { status: "failed", error_code: 63015 } }] });

    const view = await act(sendPayLink, { draftId: draft.draftId });

    expect(view.text).toBe(
      `${SANDBOX_HEAD}Ask the buyer to send join orange-tiger to the sandbox number, or use Open in WhatsApp.`,
    );
    expect(view.role).toBe("alert");
    const stored = await world.db.select().from(messages);
    expect(stored.map((m) => ({ status: m.status, providerMessageId: m.providerMessageId }))).toEqual([
      { status: "failed", providerMessageId: TWILIO_SID },
    ]);
  });
});
