// The start-call action on a real in-memory Postgres (PGlite) with the Demo_Seed. `startCallCore` is called
// with an injected instant, so every Call_Window and Call_Day case is exact. The `startCall` wrapper is
// tested separately with a mocked session (`@/auth`), `next/navigation`, `next/headers` and database handle
// (`@/lib/db`, which returns the PGlite clone). The suite-wide fetch guard fails any unmocked HTTP request.
// Requirements: 1.4, 1.5, 1.6, 1.7, 1.8, 1.10, 1.11, 1.12, 1.13, 1.14, 1.15, 11.7, 11.8
import { DISCLAIMER } from "@dues-banshee/agent";
import {
  DEMO_SUPPLIER,
  agentRuns,
  buyers,
  claimJoin,
  findSupplierIdByUdyam,
  getSupplier,
  invoices,
  seed,
  suppliers,
  voiceCalls,
  type Db,
  type Supplier,
} from "@dues-banshee/db";
import { cloneTestDb, createTestDb, type TestDb } from "@dues-banshee/db/testing";
import { hashToken } from "@dues-banshee/voice";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  redirect: vi.fn((url: string) => {
    // Next's redirect() never returns: it throws to navigate.
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  headers: vi.fn(),
  getDb: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));

import { startCall } from "@/app/(debtor)/debtors/[id]/call-actions";
import { REFUSAL_TEXT } from "@/lib/call/callable";
import { CALL_LINK_READY_TEXT, startCallCore, type StartCallView } from "@/lib/call/start-call";

const SHARMA_INVOICE_NUMBER = "LPC/26-27/0412";
const STALE_SUPPLIER_ID = "00000000-0000-4000-8000-0000000000ff";
const ORIGIN = "https://banshee-call.example.test";
const API_KEY = "sk-test-SENTINEL-call-actions-5d1f";

const WINDOW_TEXT = "Calls are allowed 10:00–19:00 IST, Monday to Saturday";
const ALREADY_TEXT = "This buyer was already called today";
const DEMO_LIMIT_TEXT = "Demo call limit reached for today";
const NOT_FOUND_TEXT = "Invoice not found";
const NOT_CONFIGURED = "Voice calls not configured";
const NOT_CALLABLE = "No call needed for this invoice";

/** The instant of `hh:mm` IST on a calendar day. */
function ist(day: string, hhmm: string): Date {
  return new Date(`${day}T${hhmm}:00+05:30`);
}

interface World {
  t: TestDb;
  db: Db;
  demo: Supplier;
  sharmaInvoiceId: string;
  sharmaBuyerId: string;
}

interface Other {
  supplier: Supplier;
  buyerId: string;
  /** Overdue on 2026-11-12: due 2026-08-15. */
  invoiceId: string;
  /** Not yet due on 2026-11-12: due 2026-12-20. */
  notDueInvoiceId: string;
}

let template: TestDb;
let world: World;

beforeAll(async () => {
  template = await createTestDb();
  await seed(template.db);
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
  world = {
    t,
    db: t.db,
    demo: await getSupplier(t.db, supplierId),
    sharmaInvoiceId: sharma.id,
    sharmaBuyerId: sharma.buyerId,
  };
  mocks.auth.mockReset().mockResolvedValue({ supplierId });
  mocks.redirect.mockClear();
  mocks.headers.mockReset().mockResolvedValue(new Headers({ origin: ORIGIN }));
  mocks.close.mockReset().mockResolvedValue(undefined);
  mocks.getDb.mockReset().mockReturnValue({ db: t.db, close: mocks.close });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await world.t.close();
});

/** A second, non-demo supplier with one overdue and one not-yet-due invoice of the same buyer. */
async function otherSupplier(): Promise<Other> {
  const { db } = world;
  const [row] = await db
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
    .values({ supplierId: row!.id, name: "Other Buyer", nameKey: "other buyer" })
    .returning({ id: buyers.id });
  const base = {
    supplierId: row!.id,
    buyerId: buyer!.id,
    amountPaise: 1_000_000,
    supplierCategory: "micro",
    supplierActivity: "manufacturing",
  } as const;
  const [overdue] = await db
    .insert(invoices)
    .values({
      ...base,
      invoiceNumber: "OS/001",
      invoiceNumberKey: "os/001",
      invoiceDate: "2026-07-01",
      acceptedOn: "2026-07-01",
    })
    .returning({ id: invoices.id });
  const [notDue] = await db
    .insert(invoices)
    .values({
      ...base,
      invoiceNumber: "OS/002",
      invoiceNumberKey: "os/002",
      invoiceDate: "2026-11-05",
      acceptedOn: "2026-11-05",
    })
    .returning({ id: invoices.id });
  return {
    supplier: await getSupplier(db, row!.id),
    buyerId: buyer!.id,
    invoiceId: overdue!.id,
    notDueInvoiceId: notDue!.id,
  };
}

interface StartOptions {
  supplier: Supplier;
  invoiceId: string;
  at: Date;
  today?: string;
  origin?: string | null;
  configured?: boolean;
}

function start(o: StartOptions): Promise<StartCallView> {
  return startCallCore(
    {
      db: world.db,
      supplier: o.supplier,
      now: o.at,
      origin: o.origin === undefined ? ORIGIN : o.origin,
      apiKeyConfigured: o.configured ?? true,
    },
    { invoiceId: o.invoiceId, today: o.today ?? "" },
  );
}

function tokenOf(view: StartCallView): string {
  const token = view.callUrl?.split("/call/")[1];
  if (token === undefined || token === "") throw new Error("test setup: the view has no call URL");
  return token;
}

/** The buyer joins: `started_at` is set, so the call counts for the Call_Day. */
async function join(view: StartCallView, at: Date): Promise<void> {
  const claimed = await claimJoin(world.db, hashToken(tokenOf(view)), at);
  if (claimed === null) throw new Error("test setup: the join did not succeed");
}

async function callRows() {
  return world.db.select().from(voiceCalls);
}

async function toolRows() {
  return (await world.db.select().from(agentRuns)).filter((r) => r.tool === "start_voice_call");
}

function refused(invoiceId: string, text: string): StartCallView {
  return { invoiceId, text, role: "alert" };
}

describe("non-demo supplier: Call_Window and one call per buyer per Call_Day", () => {
  const OUTSIDE: readonly [string, string, string][] = [
    ["09:59 IST on Thursday 2026-11-12", "2026-11-12", "09:59"],
    ["19:00 IST on Thursday 2026-11-12", "2026-11-12", "19:00"],
    ["12:00 IST on Sunday 2026-11-15", "2026-11-15", "12:00"],
  ];
  for (const [label, day, hhmm] of OUTSIDE) {
    it(`refuses a start at ${label} with the Call_Window text, no Voice_Call and one Tool_Log row`, async () => {
      const other = await otherSupplier();

      const view = await start({ supplier: other.supplier, invoiceId: other.invoiceId, at: ist(day, hhmm) });

      expect(view).toEqual(refused(other.invoiceId, WINDOW_TEXT));
      expect(await callRows()).toEqual([]);
      expect((await toolRows()).map((r) => ({ invoiceId: r.invoiceId, input: r.input, output: r.output }))).toEqual([
        {
          invoiceId: other.invoiceId,
          input: { invoice_id: other.invoiceId, today: day, demo_override: null },
          output: { ok: false, refusal: "outside_window" },
        },
      ]);
    });
  }

  for (const hhmm of ["10:00", "18:59"]) {
    it(`accepts a start at ${hhmm} IST on Thursday 2026-11-12, then refuses a second call for the same buyer that day`, async () => {
      const other = await otherSupplier();
      const at = ist("2026-11-12", hhmm);

      const first = await start({ supplier: other.supplier, invoiceId: other.invoiceId, at });
      expect(first.role).toBe("status");
      expect(first.text).toBe(CALL_LINK_READY_TEXT);
      expect(await callRows()).toHaveLength(1);

      // The one-call rule counts calls whose `started_at` is on the Call_Day, so the buyer joins first.
      await join(first, at);
      const second = await start({
        supplier: other.supplier,
        invoiceId: other.invoiceId,
        at: new Date(at.getTime() + 30_000),
      });

      expect(second).toEqual(refused(other.invoiceId, ALREADY_TEXT));
      expect(await callRows()).toHaveLength(1);
      expect((await toolRows()).map((r) => r.output)).toEqual([
        expect.objectContaining({ ok: true }),
        { ok: false, refusal: "already_called" },
      ]);
    });
  }

  it("creates a created Voice_Call for the invoice and buyer, with call_today and a 10-minute token stored as a hash", async () => {
    const other = await otherSupplier();
    const at = ist("2026-11-12", "11:00");

    const view = await start({ supplier: other.supplier, invoiceId: other.invoiceId, at });

    const token = tokenOf(view);
    const rows = await callRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      invoiceId: other.invoiceId,
      buyerId: other.buyerId,
      callToday: "2026-11-12",
      status: "created",
      startedAt: null,
      tokenHash: hashToken(token),
      tokenExpiresAt: new Date(at.getTime() + 600_000),
    });
    expect(view.invoiceId).toBe(other.invoiceId);
  });

  it("ignores a Demo_Override: Today is the real IST date", async () => {
    const other = await otherSupplier();

    const view = await start({
      supplier: other.supplier,
      invoiceId: other.invoiceId,
      at: ist("2026-11-12", "11:00"),
      today: "2027-01-01",
    });

    expect(view.role).toBe("status");
    expect((await callRows())[0]?.callToday).toBe("2026-11-12");
    expect((await toolRows())[0]?.input).toEqual({
      invoice_id: other.invoiceId,
      today: "2026-11-12",
      demo_override: null,
    });
  });
});

describe("demo supplier: no Call_Window, no one-call rule, Demo_Call_Limit", () => {
  it("is identified by Udyam number UDYAM-MH-00-0000000", () => {
    expect(world.demo.udyamNumber).toBe("UDYAM-MH-00-0000000");
  });

  for (const [label, day, hhmm] of [
    ["20:00 IST on Thursday 2026-11-12", "2026-11-12", "20:00"],
    ["12:00 IST on Sunday 2026-11-15", "2026-11-15", "12:00"],
  ] as const) {
    it(`accepts a start at ${label}`, async () => {
      const view = await start({ supplier: world.demo, invoiceId: world.sharmaInvoiceId, at: ist(day, hhmm) });

      expect(view.role).toBe("status");
      expect(view.text).toBe(CALL_LINK_READY_TEXT);
      const rows = await callRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ invoiceId: world.sharmaInvoiceId, status: "created", callToday: day });
    });
  }

  it("accepts a second call for the same buyer on the same Call_Day", async () => {
    const at = ist("2026-11-12", "20:00");
    const first = await start({ supplier: world.demo, invoiceId: world.sharmaInvoiceId, at });
    await join(first, at);

    const second = await start({
      supplier: world.demo,
      invoiceId: world.sharmaInvoiceId,
      at: new Date(at.getTime() + 60_000),
    });

    expect(second.role).toBe("status");
    expect(await callRows()).toHaveLength(2);
  });

  it("accepts 20 calls on the Call_Day and refuses the 21st with the limit text and no Voice_Call", async () => {
    const at = ist("2026-11-12", "20:00");
    for (let i = 0; i < 20; i++) {
      const view = await start({
        supplier: world.demo,
        invoiceId: world.sharmaInvoiceId,
        at: new Date(at.getTime() + i * 1000),
      });
      expect(view.role).toBe("status");
      await join(view, new Date(at.getTime() + i * 1000));
    }
    expect(await callRows()).toHaveLength(20);

    const view = await start({
      supplier: world.demo,
      invoiceId: world.sharmaInvoiceId,
      at: new Date(at.getTime() + 21_000),
    });

    expect(view).toEqual(refused(world.sharmaInvoiceId, DEMO_LIMIT_TEXT));
    expect(await callRows()).toHaveLength(20);
    expect((await toolRows()).at(-1)?.output).toEqual({ ok: false, refusal: "demo_limit" });
  });

  it("does not count calls of the previous Call_Day", async () => {
    const yesterday = ist("2026-11-11", "20:00");
    for (let i = 0; i < 20; i++) {
      const view = await start({
        supplier: world.demo,
        invoiceId: world.sharmaInvoiceId,
        at: new Date(yesterday.getTime() + i * 1000),
      });
      await join(view, new Date(yesterday.getTime() + i * 1000));
    }

    const view = await start({ supplier: world.demo, invoiceId: world.sharmaInvoiceId, at: ist("2026-11-12", "00:30") });

    expect(view.role).toBe("status");
  });

  it("honours a Demo_Override as call_today and logs it", async () => {
    const view = await start({
      supplier: world.demo,
      invoiceId: world.sharmaInvoiceId,
      at: ist("2026-11-12", "20:00"),
      today: "2026-11-20",
    });

    expect(view.role).toBe("status");
    expect((await callRows())[0]?.callToday).toBe("2026-11-20");
    expect((await toolRows())[0]?.input).toEqual({
      invoice_id: world.sharmaInvoiceId,
      today: "2026-11-20",
      demo_override: "2026-11-20",
    });
  });
});

describe("links", () => {
  it("callUrl starts with the request origin and ends with the single-use token", async () => {
    const view = await start({
      supplier: world.demo,
      invoiceId: world.sharmaInvoiceId,
      at: ist("2026-11-12", "12:00"),
      origin: "https://owner-laptop.example.test:3000",
    });

    expect(view.callUrl?.startsWith("https://owner-laptop.example.test:3000/call/")).toBe(true);
    expect(tokenOf(view)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("waMeUrl is a WaMe_Link whose text holds the call URL and the disclaimer", async () => {
    const view = await start({
      supplier: world.demo,
      invoiceId: world.sharmaInvoiceId,
      at: ist("2026-11-12", "12:00"),
    });

    expect(view.waMeUrl?.startsWith("https://wa.me/?text=")).toBe(true);
    const text = decodeURIComponent(view.waMeUrl!.slice("https://wa.me/?text=".length));
    expect(text).toContain(view.callUrl);
    expect(text).toContain("Sharma");
    expect(text).toContain(DISCLAIMER);
  });

  it("refuses with no call and a Tool_Log row when the request has no usable origin", async () => {
    const view = await start({
      supplier: world.demo,
      invoiceId: world.sharmaInvoiceId,
      at: ist("2026-11-12", "12:00"),
      origin: null,
    });

    expect(view.role).toBe("alert");
    expect(view.callUrl).toBeUndefined();
    expect(await callRows()).toEqual([]);
    expect((await toolRows())[0]?.output).toEqual({ ok: false, refusal: "no_origin" });
  });
});

describe("invoice lookup", () => {
  it("another supplier's invoice is not found: no Voice_Call and no Tool_Log row", async () => {
    const other = await otherSupplier();

    const view = await start({ supplier: world.demo, invoiceId: other.invoiceId, at: ist("2026-11-12", "12:00") });

    expect(view).toEqual(refused(other.invoiceId, NOT_FOUND_TEXT));
    expect(await callRows()).toEqual([]);
    expect(await toolRows()).toEqual([]);
  });

  it("the demo supplier's invoice is not found for another supplier", async () => {
    const other = await otherSupplier();

    const view = await start({
      supplier: other.supplier,
      invoiceId: world.sharmaInvoiceId,
      at: ist("2026-11-12", "12:00"),
    });

    expect(view.text).toBe(NOT_FOUND_TEXT);
    expect(await callRows()).toEqual([]);
    expect(await toolRows()).toEqual([]);
  });

  for (const bad of ["not-a-uuid", "", "00000000-0000-4000-8000-0000000000aa"]) {
    it(`"${bad}" is not found: no Voice_Call and no Tool_Log row`, async () => {
      const view = await start({ supplier: world.demo, invoiceId: bad, at: ist("2026-11-12", "12:00") });

      expect(view.role).toBe("alert");
      expect(view.text).toBe(NOT_FOUND_TEXT);
      expect(view.callUrl).toBeUndefined();
      expect(await callRows()).toEqual([]);
      expect(await toolRows()).toEqual([]);
    });
  }
});

describe("not configured and not callable", () => {
  it("OPENAI_API_KEY unset: refused with the not-configured text, no Voice_Call, a Tool_Log row", async () => {
    const view = await start({
      supplier: world.demo,
      invoiceId: world.sharmaInvoiceId,
      at: ist("2026-11-12", "12:00"),
      configured: false,
    });

    expect(view).toEqual(refused(world.sharmaInvoiceId, NOT_CONFIGURED));
    expect(REFUSAL_TEXT.not_configured).toBe(NOT_CONFIGURED);
    expect(await callRows()).toEqual([]);
    expect((await toolRows())[0]?.output).toEqual({ ok: false, refusal: "not_configured" });
  });

  it("an invoice that is not yet due: refused with the not-callable text, no Voice_Call, a Tool_Log row", async () => {
    const other = await otherSupplier();

    const view = await start({
      supplier: other.supplier,
      invoiceId: other.notDueInvoiceId,
      at: ist("2026-11-12", "12:00"),
    });

    expect(view).toEqual(refused(other.notDueInvoiceId, NOT_CALLABLE));
    expect(await callRows()).toEqual([]);
    expect((await toolRows())[0]?.output).toEqual({ ok: false, refusal: "not_callable" });
  });

  it("a paid invoice is not callable, also for the demo supplier outside any window", async () => {
    await world.db.update(invoices).set({ paidOn: "2026-11-10" });

    const view = await start({
      supplier: world.demo,
      invoiceId: world.sharmaInvoiceId,
      at: ist("2026-11-12", "20:00"),
    });

    expect(view.text).toBe(NOT_CALLABLE);
    expect(await callRows()).toEqual([]);
  });

  it("not configured wins over not callable and over the Call_Window", async () => {
    const other = await otherSupplier();

    const view = await start({
      supplier: other.supplier,
      invoiceId: other.notDueInvoiceId,
      at: ist("2026-11-15", "12:00"),
      configured: false,
    });

    expect(view.text).toBe(NOT_CONFIGURED);
  });
});

describe("a new start expires the buyer's older created calls", () => {
  it("sets the earlier created Voice_Call to expired and leaves the new one created", async () => {
    const at = ist("2026-11-12", "12:00");
    const first = await start({ supplier: world.demo, invoiceId: world.sharmaInvoiceId, at });
    const second = await start({
      supplier: world.demo,
      invoiceId: world.sharmaInvoiceId,
      at: new Date(at.getTime() + 5000),
    });

    const rows = await callRows();
    const byHash = new Map(rows.map((r) => [r.tokenHash, r.status]));
    expect(rows).toHaveLength(2);
    expect(byHash.get(hashToken(tokenOf(first)))).toBe("expired");
    expect(byHash.get(hashToken(tokenOf(second)))).toBe("created");
  });

  it("does not touch a call of another buyer", async () => {
    const other = await otherSupplier();
    const at = ist("2026-11-12", "12:00");
    const otherView = await start({ supplier: other.supplier, invoiceId: other.invoiceId, at });
    await start({ supplier: world.demo, invoiceId: world.sharmaInvoiceId, at: new Date(at.getTime() + 5000) });

    const rows = await callRows();
    expect(rows.find((r) => r.tokenHash === hashToken(tokenOf(otherView)))?.status).toBe("created");
  });
});

describe("Tool_Log", () => {
  it("holds one start_voice_call row per request, for accepted and refused starts, and never the token or call URL", async () => {
    const other = await otherSupplier();
    const at = ist("2026-11-12", "10:00");
    const accepted = await start({ supplier: other.supplier, invoiceId: other.invoiceId, at });
    await join(accepted, at);
    await start({ supplier: other.supplier, invoiceId: other.invoiceId, at: new Date(at.getTime() + 1000) });
    await start({ supplier: other.supplier, invoiceId: other.invoiceId, at: ist("2026-11-12", "21:00") });
    await start({ supplier: other.supplier, invoiceId: other.notDueInvoiceId, at, configured: false });

    const rows = await toolRows();
    expect(rows.map((r) => (r.output as { refusal?: string }).refusal ?? "ok")).toEqual([
      "ok",
      "already_called",
      "outside_window",
      "not_configured",
    ]);
    const token = tokenOf(accepted);
    for (const row of rows) {
      const json = JSON.stringify(row);
      expect(json).not.toContain(token);
      expect(json).not.toContain(accepted.callUrl);
      expect(json).not.toContain("/call/");
      expect(row.invoiceId).not.toBeNull();
    }
    expect(rows[0]?.output).toEqual({
      ok: true,
      voice_call_id: (await callRows())[0]?.id,
      call_today: "2026-11-12",
      token_expires_at: new Date(at.getTime() + 600_000).toISOString(),
    });
    // The whole agent_runs table is clean too, not only the start_voice_call rows.
    expect(JSON.stringify(await world.db.select().from(agentRuns))).not.toContain(token);
  });
});

describe("startCall wrapper", () => {
  function form(fields: Record<string, string>): FormData {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) data.set(name, value);
    return data;
  }

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

  for (const [label, session] of [
    ["null", null],
    ["without a supplierId", {}],
    ["with an empty supplierId", { supplierId: "" }],
  ] as const) {
    it(`a session ${label} redirects to /signin and creates nothing`, async () => {
      mocks.auth.mockResolvedValue(session);

      const url = await redirectOf(() => startCall(null, form({ invoiceId: world.sharmaInvoiceId })));

      expect(url).toBe("/signin");
      expect(mocks.redirect.mock.calls).toEqual([["/signin"]]);
      expect(mocks.getDb).not.toHaveBeenCalled();
      expect(await callRows()).toEqual([]);
      expect(await toolRows()).toEqual([]);
    });
  }

  it("a Stale_Session redirects once to /signin?error=SessionExpired and creates nothing", async () => {
    mocks.auth.mockResolvedValue({ supplierId: STALE_SUPPLIER_ID });

    const url = await redirectOf(() => startCall(null, form({ invoiceId: world.sharmaInvoiceId })));

    expect(url).toBe("/signin?error=SessionExpired");
    expect(mocks.redirect.mock.calls).toEqual([["/signin?error=SessionExpired"]]);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(await callRows()).toEqual([]);
    expect(await toolRows()).toEqual([]);
  });

  it("starts a call for the session supplier at the server clock and builds the URL from the request origin", async () => {
    vi.stubEnv("OPENAI_API_KEY", API_KEY);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(ist("2026-11-12", "20:00"));

    const view = await startCall(null, form({ invoiceId: world.sharmaInvoiceId }));

    expect(view.role).toBe("status");
    expect(view.callUrl?.startsWith(`${ORIGIN}/call/`)).toBe(true);
    expect(JSON.stringify(view)).not.toContain(API_KEY);
    expect(await callRows()).toHaveLength(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("reports not configured when OPENAI_API_KEY is empty", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");

    const view = await startCall(null, form({ invoiceId: world.sharmaInvoiceId }));

    expect(view).toEqual(refused(world.sharmaInvoiceId, NOT_CONFIGURED));
    expect(await callRows()).toEqual([]);
  });

  it("ignores a forged supplierId field: another supplier's invoice is not found", async () => {
    vi.stubEnv("OPENAI_API_KEY", API_KEY);
    const other = await otherSupplier();

    const view = await startCall(null, form({ invoiceId: other.invoiceId, supplierId: other.supplier.id }));

    expect(view).toEqual(refused(other.invoiceId, NOT_FOUND_TEXT));
    expect(await callRows()).toEqual([]);
    expect(await toolRows()).toEqual([]);
  });

  it("answers a non-uuid invoice id as not found without a database error", async () => {
    vi.stubEnv("OPENAI_API_KEY", API_KEY);

    const view = await startCall(null, form({ invoiceId: "'; drop table invoices; --" }));

    expect(view).toEqual({ invoiceId: "", text: NOT_FOUND_TEXT, role: "alert" });
    expect(await callRows()).toEqual([]);
  });
});
