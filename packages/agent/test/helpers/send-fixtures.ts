// Shared fixtures for the sendDraft tests (send-draft.*.test.ts): a migrated, seeded PGlite database,
// an approved Sharma Traders WhatsApp Draft built from a fixed mock Model_Output, fictional Channel_Env
// values, canned Razorpay and Twilio routes for `fakeHttp`, and a `SendDeps` builder.
// Everything is fictional: no real number, key or account. No network call is made.
import {
  DEMO_SUPPLIER,
  agentRuns,
  findSupplierIdByUdyam,
  getSupplier,
  insertDraft,
  invoices,
  listLadderRecords,
  seed,
} from "@dues-banshee/db";
import type { Db } from "@dues-banshee/db";
import { cloneTestDb, createTestDb } from "@dues-banshee/db/testing";
import type { TestDb } from "@dues-banshee/db/testing";
import { nextEscalationStep } from "@dues-banshee/engine";
import type { CalendarDate, LadderStep } from "@dues-banshee/engine";
import { MockLanguageModelV4 } from "ai/test";
import { readChannelEnv } from "../../src/channel/env";
import { createRazorpayClient } from "../../src/channel/razorpay";
import type { SendDeps } from "../../src/channel/send-draft";
import { createTwilioSandbox } from "../../src/channel/twilio-sandbox";
import { createWaMeLink } from "../../src/channel/wa-me";
import type { ModelOutput } from "../../src/core/model-output";
import { engineHistory } from "../../src/core/history";
import { approveDraft } from "../../src/decide";
import { draftStep } from "../../src/draft-step";
import { loadBankRate } from "../../src/load-bank-rate";
import type { ModelSet } from "../../src/models";
import { fakeClock, fakeHttp } from "../../src/testing/fake-http";
import type { FakeClock, FakeHttp, FakeResponse, FakeRoute } from "../../src/testing/fake-http";

/** Today of the demo (Sharma Traders is 26 days late, tax bomb in 139 days). */
export const DEMO_TODAY: CalendarDate = "2026-11-12";
export const SHARMA_INVOICE_NUMBER = "LPC/26-27/0412";
export const SHARMA_AMOUNT_PAISE = 41_200_000;
/** Fictional E.164 number (+91 900000xxxx is not a real subscriber range). */
export const BUYER_NUMBER = "+919000000001";

/** The fixed Model_Output of the demo: cites both rules and uses only Engine placeholders. */
export const DEMO_MODEL_OUTPUT: ModelOutput = {
  text:
    "Namaste {{buyer_name}} ji, invoice {{invoice_number}} ka {{principal}} {{due_date}} ko due tha. " +
    "Tab se {{interest}} byaaj jud chuka hai ({{rate_as_of}} ki bank rate par).",
  ruleIds: ["MSMED-15", "MSMED-16"],
};

/**
 * Fictional Channel_Env. Every value is a unique sentinel so a test can prove none of them reached a
 * Tool_Log row (Req 5.6, 8.2).
 */
export const CHANNEL_ENV_VALUES = {
  TWILIO_ACCOUNT_SID: "ACdemo0000000000000000000000SENTINEL",
  TWILIO_AUTH_TOKEN: "twilio-auth-token-SENTINEL-61c2e9",
  TWILIO_WHATSAPP_FROM: "+14155550100",
  RAZORPAY_KEY_ID: "rzp_test_SENTINELKEYID",
  RAZORPAY_KEY_SECRET: "razorpay-key-secret-SENTINEL-8d40b7",
  RAZORPAY_WEBHOOK_SECRET: "razorpay-webhook-secret-SENTINEL-3a9f15",
  PUBLIC_BASE_URL: "https://banshee-sentinel.example.test",
  TWILIO_SANDBOX_JOIN_CODE: "sentinel-join-code",
} as const satisfies Record<string, string>;

export const TWILIO_BASE = `https://api.twilio.com/2010-04-01/Accounts/${CHANNEL_ENV_VALUES.TWILIO_ACCOUNT_SID}`;
export const TWILIO_CREATE_URL = `${TWILIO_BASE}/Messages.json`;
export const TWILIO_MESSAGE_SID = "SM0000000000000000000000000000d1";
export const TWILIO_POLL_URL = `${TWILIO_BASE}/Messages/${TWILIO_MESSAGE_SID}.json`;
export const RAZORPAY_LINKS_URL = "https://api.razorpay.com/v1/payment_links";
export const RAZORPAY_LOOKUP_URL = `${RAZORPAY_LINKS_URL}?reference_id=`;
export const MOCK_PAY_LINK_ID = "plink_demo0000000001";
export const MOCK_PAY_LINK_URL = "https://rzp.io/i/demoSharma0412";

/** One fixed Model_Output replied by a mock model (the same reply for every call). */
function mockModel(modelId: string, output: ModelOutput): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId,
    doGenerate: {
      content: [{ type: "text", text: JSON.stringify(output) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    },
  });
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export interface SendWorld {
  t: TestDb;
  db: Db;
  supplierId: string;
  /** The Sharma Traders invoice `LPC/26-27/0412`. */
  invoiceId: string;
  buyerId: string;
}

/** A migrated database with the demo seed; Sharma Traders has `BUYER_NUMBER`. Clone it per test. */
export async function createSendTemplate(): Promise<TestDb> {
  const template = await createTestDb();
  await seed(template.db, { demoBuyerWhatsapp: BUYER_NUMBER });
  return template;
}

/** An independent copy of the template. The caller closes `world.t`. */
export async function cloneSendWorld(template: TestDb): Promise<SendWorld> {
  const t = await cloneTestDb(template);
  const supplierId = await findSupplierIdByUdyam(t.db, DEMO_SUPPLIER.udyamNumber);
  if (supplierId === null) throw new Error("demo supplier missing after seed");
  const sharma = (await t.db.select({ id: invoices.id, buyerId: invoices.buyerId, number: invoices.invoiceNumber }).from(invoices)).find(
    (i) => i.number === SHARMA_INVOICE_NUMBER,
  );
  if (sharma === undefined) throw new Error("Sharma invoice missing after seed");
  return { t, db: t.db, supplierId, invoiceId: sharma.id, buyerId: sharma.buyerId };
}

/**
 * Drafts the Sharma invoice's next step from a fixed mock Model_Output through the real `draftStep`,
 * stores it, and approves it on `today` through the real `approveDraft`. Returns the Draft id.
 * Throws if the Engine's next step is not `step` (seed the earlier approved events first).
 */
export async function draftAndApproveSharma(
  world: SendWorld,
  options: { step?: Extract<LadderStep, "whatsapp_nudge" | "whatsapp_paylink">; output?: ModelOutput; today?: CalendarDate } = {},
): Promise<string> {
  const step = options.step ?? "whatsapp_nudge";
  const today = options.today ?? DEMO_TODAY;
  const output = options.output ?? DEMO_MODEL_OUTPUT;
  const { db, supplierId, invoiceId } = world;

  const [record] = await listLadderRecords(db, supplierId, today, invoiceId);
  if (record === undefined) throw new Error("no ladder record for the Sharma invoice");
  const decision = nextEscalationStep(record.invoice, engineHistory(record), today);
  if (decision.action !== "advance" || decision.step !== step) {
    throw new Error(`expected the Engine to advance to ${step}, got ${JSON.stringify(decision)}`);
  }

  const models: ModelSet = {
    default: mockModel("mock-haiku", output),
    legal: mockModel("mock-sonnet", output),
    fallback: mockModel("mock-luna", output),
  };
  const attempt = await draftStep(
    { db, models },
    {
      record,
      supplier: await getSupplier(db, supplierId),
      decision,
      language: "hinglish",
      today,
      bankRate: await loadBankRate(db, today),
    },
  );
  if (attempt.kind !== "accepted") throw new Error(`mock draft was not accepted: ${attempt.errorKind}`);
  const stored = await insertDraft(db, attempt.draft, today);
  if (stored.kind !== "ok") throw new Error("pending draft already exists");
  const approved = await approveDraft({ db }, supplierId, stored.draftId, today);
  if (approved.kind !== "ok") throw new Error(`approveDraft: ${approved.kind}`);
  return stored.draftId;
}

/**
 * Every Tool_Log row in the order it was written. `created_at` can tie within a millisecond and the
 * table is append-only, so `ctid` is the write order.
 */
export async function toolRowsInOrder(t: TestDb) {
  const rows = await t.db.select().from(agentRuns);
  const order = await t.pglite.query<{ id: string }>("select id from agent_runs order by ctid");
  const rank = new Map(order.rows.map((r, i) => [r.id, i]));
  return rows.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}

/** The Tool_Log rows written after `before` (a result of `toolRowsInOrder`), in write order. */
export async function toolRowsSince(t: TestDb, before: readonly { id: string }[]) {
  const seen = new Set(before.map((r) => r.id));
  return (await toolRowsInOrder(t)).filter((r) => !seen.has(r.id));
}

/** Rows serialised, for "no secret and no full number in any row" checks. */
export function serialise(rows: readonly unknown[]): string {
  return JSON.stringify(rows);
}

// ---------------------------------------------------------------------------
// HTTP routes and deps
// ---------------------------------------------------------------------------

export interface ProviderResponses {
  /** `GET /v1/payment_links?reference_id=`. Default: no link yet. */
  lookup?: readonly FakeResponse[];
  /** `POST /v1/payment_links`. Default: one created link, `MOCK_PAY_LINK_URL`. */
  create?: readonly FakeResponse[];
  /** Twilio `POST …/Messages.json`. Default: 201 with `TWILIO_MESSAGE_SID`. */
  twilioCreate?: readonly FakeResponse[];
  /** Twilio `GET …/Messages/<sid>.json`, served in order. Default: `queued` three times. */
  twilioPolls?: readonly FakeResponse[];
}

/** A Razorpay link entity as the API returns it. */
export function razorpayLink(draftId: string, amountPaise = SHARMA_AMOUNT_PAISE) {
  return { id: MOCK_PAY_LINK_ID, short_url: MOCK_PAY_LINK_URL, amount: amountPaise, reference_id: draftId };
}

export const QUEUED_POLL: FakeResponse = { json: { status: "queued", error_code: null } };

/** The four provider routes the send path calls, with per-route overrides. */
export function providerRoutes(draftId: string, over: ProviderResponses = {}): FakeRoute[] {
  return [
    {
      method: "GET",
      url: RAZORPAY_LOOKUP_URL,
      responses: over.lookup ?? [{ json: { count: 0, payment_links: [] } }],
    },
    {
      method: "POST",
      url: RAZORPAY_LINKS_URL,
      responses: over.create ?? [{ status: 200, json: razorpayLink(draftId) }],
    },
    {
      method: "POST",
      url: TWILIO_CREATE_URL,
      responses: over.twilioCreate ?? [{ status: 201, json: { sid: TWILIO_MESSAGE_SID, status: "queued" } }],
    },
    {
      method: "GET",
      url: `${TWILIO_BASE}/Messages/`,
      responses: over.twilioPolls ?? [QUEUED_POLL, QUEUED_POLL, QUEUED_POLL],
    },
  ];
}

export interface SendHarness {
  deps: SendDeps;
  http: FakeHttp;
  clock: FakeClock;
}

/**
 * `SendDeps` over `fakeHttp` and `fakeClock`. `env` defaults to `CHANNEL_ENV_VALUES`; pass a map with
 * a value removed or changed to turn a provider off. `deps.razorpay`/`deps.twilio` follow `readChannelEnv`,
 * as the server action builds them.
 */
export function buildSendHarness(
  db: Db,
  options: {
    routes: readonly FakeRoute[];
    env?: Readonly<Record<string, string | undefined>>;
    recordSent?: SendDeps["recordSent"];
  },
): SendHarness {
  const clock = fakeClock();
  const http = fakeHttp(options.routes, { clock });
  const env = readChannelEnv(options.env ?? CHANNEL_ENV_VALUES);
  const deps: SendDeps = {
    db,
    env,
    razorpay:
      env.razorpay === null
        ? null
        : createRazorpayClient({ fetch: http.fetch, keyId: env.razorpay.keyId, keySecret: env.razorpay.keySecret }),
    twilio:
      env.twilio === null
        ? null
        : createTwilioSandbox({
            fetch: http.fetch,
            sleep: clock.sleep,
            timeoutSignal: clock.timeoutSignal,
            accountSid: env.twilio.accountSid,
            authToken: env.twilio.authToken,
            from: env.twilio.from,
          }),
    waMe: createWaMeLink(),
    ...(options.recordSent === undefined ? {} : { recordSent: options.recordSent }),
  };
  return { deps, http, clock };
}
