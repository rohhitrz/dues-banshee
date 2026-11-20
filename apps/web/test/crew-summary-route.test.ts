import {
  DEMO_INVOICES,
  DEMO_SUPPLIER,
  toEngineInvoice,
  type GraveyardInvoiceRecord,
  type InvoiceRow,
  type Supplier,
  type SupplierRow,
} from "@dues-banshee/db";
import type { BankRate, CalendarDate } from "@dues-banshee/engine";
import fc from "fast-check";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted above the imports, so the mocks' state has to be hoisted with it.
const mocks = vi.hoisted(() => ({
  db: { sentinel: "db" } as const,
  close: undefined as unknown as ReturnType<typeof vi.fn>,
  getDb: undefined as unknown as ReturnType<typeof vi.fn>,
  findSupplierIdByUdyam: undefined as unknown as ReturnType<typeof vi.fn>,
  loadGraveyardData: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("@/lib/db", () => {
  mocks.close = vi.fn(async () => {});
  mocks.getDb = vi.fn(() => ({ db: mocks.db, close: mocks.close }));
  return { getDb: mocks.getDb };
});

vi.mock("@dues-banshee/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dues-banshee/db")>();
  mocks.findSupplierIdByUdyam = vi.fn();
  return { ...actual, findSupplierIdByUdyam: mocks.findSupplierIdByUdyam };
});

vi.mock("@/lib/graveyard/load", () => {
  mocks.loadGraveyardData = vi.fn();
  return { loadGraveyardData: mocks.loadGraveyardData };
});

import * as routeModule from "@/app/api/crew/summary/route";
import { GET } from "@/app/api/crew/summary/route";
import { CREW_DISCLAIMER } from "@/lib/crew/summary";
import { buildGraveyard } from "@/lib/graveyard/build-graveyard";

// --- Shared setup (task 3.3 extends this file; keep these helpers at top level) ---------------------------------

const CREW_SECRET = "crew-read-secret-for-tests-0123456789";
const LADDER_SECRET = "ladder-run-secret-for-tests-9876543210";
const URL_BASE = "http://localhost/api/crew/summary";

// 2026-11-12 20:00 UTC is 2026-11-13 01:30 IST, so the IST date differs from the UTC date.
const NOW = new Date("2026-11-12T20:00:00Z");
const IST_TODAY = "2026-11-13";
const DEMO_TODAY = "2026-11-12";
const BANK_RATE: BankRate = { annualBps: 575, asOf: "2026-10-07" };

const DEMO_ID = "supplier-demo";
const SUPPLIER_ID = "00000000-0000-4000-8000-000000000001";
const SUPPLIER: Supplier = { id: SUPPLIER_ID, ...DEMO_SUPPLIER };
const SUPPLIER_ROW: SupplierRow = {
  ...SUPPLIER,
  udyamRegisteredOn: DEMO_SUPPLIER.udyamRegisteredOn,
  createdAt: new Date(0),
};

// Fixed ids (copied from build-graveyard.test.ts), so expected values never depend on generated uuids.
const IDS: Record<string, string> = {
  "LPC/26-27/0412": "inv-sharma",
  "LPC/26-27/0466": "inv-gupta",
  "LPC/26-27/0301": "inv-kumar",
  "LPC/26-27/0377": "inv-verma",
  "LPC/25-26/0388": "inv-mehta",
  "LPC/23-24/0098": "inv-bansal",
};

function demoRecords(): GraveyardInvoiceRecord[] {
  return DEMO_INVOICES.map((demo): GraveyardInvoiceRecord => {
    const id = IDS[demo.invoiceNumber];
    if (id === undefined) throw new Error(`no fixed id for ${demo.invoiceNumber}`);
    const row: InvoiceRow = {
      id,
      supplierId: SUPPLIER_ID,
      buyerId: `buyer-${id}`,
      invoiceNumber: demo.invoiceNumber,
      invoiceNumberKey: demo.invoiceNumber.toLowerCase(),
      invoiceDate: demo.acceptedOn,
      acceptedOn: demo.acceptedOn,
      acceptanceDateDefaulted: false,
      agreedTermDays: demo.agreedTermDays ?? null,
      amountPaise: demo.amountPaise,
      paidOn: demo.paidOn ?? null,
      supplierCategory: SUPPLIER_ROW.supplierCategory,
      supplierActivity: SUPPLIER_ROW.supplierActivity,
      createdAt: new Date(0),
    };
    return {
      invoice: toEngineInvoice(row, SUPPLIER_ROW),
      buyerName: demo.buyerName,
      invoiceNumber: demo.invoiceNumber,
      history: [],
      buyerId: row.buyerId,
      invoiceDate: row.invoiceDate,
    };
  });
}

/** An `ok` Load_Result whose view is built for the `today` the route passes in. */
function okResult(today: CalendarDate) {
  const records = demoRecords();
  return {
    kind: "ok" as const,
    supplier: SUPPLIER,
    bankRate: BANK_RATE,
    records,
    view: buildGraveyard(SUPPLIER, records, BANK_RATE, today),
  };
}

function request(options: { auth?: string; query?: string } = {}): Request {
  const headers = new Headers();
  if (options.auth !== undefined) headers.set("authorization", options.auth);
  return new Request(`${URL_BASE}${options.query ?? ""}`, { method: "GET", headers });
}

const authed = (query = ""): Request => request({ auth: `Bearer ${CREW_SECRET}`, query });

/** Every argument of every call to the spied console methods, rendered as text. */
function consoleText(spies: ReadonlyArray<{ mock: { calls: unknown[][] } }>): string {
  return spies.flatMap((spy) => spy.mock.calls.flat()).map((arg) => inspect(arg, { depth: 6 })).join("\n");
}

const expectNoStore = (res: Response): void => {
  expect(res.headers.get("cache-control")).toBe("no-store");
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("CREW_READ_SECRET", CREW_SECRET);
  vi.stubEnv("LADDER_RUN_SECRET", LADDER_SECRET);
  mocks.findSupplierIdByUdyam.mockResolvedValue(DEMO_ID);
  mocks.loadGraveyardData.mockImplementation(async (_db: unknown, _id: string, today: CalendarDate) =>
    okResult(today),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  mocks.close.mockReset();
  mocks.close.mockImplementation(async () => {});
  mocks.getDb.mockReset();
  mocks.getDb.mockImplementation(() => ({ db: mocks.db, close: mocks.close }));
  mocks.findSupplierIdByUdyam.mockReset();
  mocks.loadGraveyardData.mockReset();
});

// --- Example tests ----------------------------------------------------------------------------------------------

describe("GET /api/crew/summary: module shape", () => {
  it("runs on the nodejs runtime", () => {
    expect(routeModule.runtime).toBe("nodejs");
  });

  it("exports GET as its only HTTP method handler", () => {
    const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
    expect(Object.keys(routeModule).filter((name) => methods.includes(name))).toEqual(["GET"]);
    expect(Object.keys(routeModule).sort()).toEqual(["GET", "runtime"]);
  });
});

describe("GET /api/crew/summary: 503 and 401", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
  ])("returns 503 when CREW_READ_SECRET is %s", async (_label, value) => {
    vi.stubEnv("CREW_READ_SECRET", value);

    const res = await GET(authed());

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not_configured" });
    expectNoStore(res);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it.each([
    ["no Authorization header", request()],
    ["a wrong token", request({ auth: `Bearer ${CREW_SECRET}x` })],
    ["a bare secret without the Bearer scheme", request({ auth: CREW_SECRET })],
    ["an empty bearer", request({ auth: "Bearer " })],
    ["the Ladder_Secret", request({ auth: `Bearer ${LADDER_SECRET}` })],
  ])("returns 401 with %s", async (_label, req) => {
    const res = await GET(req);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expectNoStore(res);
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.findSupplierIdByUdyam).not.toHaveBeenCalled();
    expect(mocks.loadGraveyardData).not.toHaveBeenCalled();
  });
});

describe("GET /api/crew/summary: 404 and 500", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns 404 for an unknown demo supplier and does not load the graveyard", async () => {
    mocks.findSupplierIdByUdyam.mockResolvedValue(null);

    const res = await GET(authed());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expectNoStore(res);
    expect(mocks.findSupplierIdByUdyam).toHaveBeenCalledWith(mocks.db, DEMO_SUPPLIER.udyamNumber);
    expect(mocks.loadGraveyardData).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("returns 404 for a stale Load_Result", async () => {
    mocks.loadGraveyardData.mockResolvedValue({ kind: "stale" });

    const res = await GET(authed());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expectNoStore(res);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("returns 500 for an error Load_Result", async () => {
    mocks.loadGraveyardData.mockResolvedValue({ kind: "error" });

    const res = await GET(authed());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "load_failed" });
    expectNoStore(res);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("returns 500 when the supplier lookup throws", async () => {
    mocks.findSupplierIdByUdyam.mockRejectedValue(new Error("connection refused"));

    const res = await GET(authed());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "load_failed" });
    expectNoStore(res);
    expect(mocks.loadGraveyardData).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("returns 500 when getDb() throws, and has no handle to close", async () => {
    mocks.getDb.mockImplementation(() => {
      throw new Error("DATABASE_URL is not set");
    });

    const res = await GET(authed());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "load_failed" });
    expectNoStore(res);
    expect(mocks.findSupplierIdByUdyam).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });
});

describe("GET /api/crew/summary: 200", () => {
  it("returns the Sharma Traders tombstone and the top-level fields at ?today=2026-11-12", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await GET(authed(`?today=${DEMO_TODAY}`));

    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expectNoStore(res);
    const body = await res.json();

    expect(Object.keys(body).sort()).toEqual(
      ["disclaimer", "rulesAsOf", "supplierName", "today", "todayOverride", "totals", "tombstones"].sort(),
    );
    expect(body.today).toBe(DEMO_TODAY);
    expect(body.todayOverride).toBe(true);
    expect(body.rulesAsOf).toBe("2026-10-07");
    expect(body.supplierName).toBe(DEMO_SUPPLIER.name);
    expect(body.disclaimer).toBe("Reminders a supplier sends to its own buyers. Not legal advice.");
    expect(body.disclaimer).toBe(CREW_DISCLAIMER);

    const sharma = body.tombstones.find((t: { invoiceNumber: string }) => t.invoiceNumber === "LPC/26-27/0412");
    expect(sharma).toMatchObject({
      id: "inv-sharma",
      buyerName: "Sharma Traders",
      invoiceNumber: "LPC/26-27/0412",
      state: "armed",
      stateRuleId: "IT-43BH",
      principal: { paise: 41200000, text: "₹4,12,000" },
      dueDate: "2026-10-17",
      dueDateText: "17 Oct 2026",
      daysOverdue: 26,
      interest: { paise: 512794, text: "₹5,127.94" },
      taxBomb: { status: "armed", daysLeft: 139, deductionAtRiskPaise: 41200000, deductionAtRiskText: "₹4,12,000" },
      nextLabel: "Next: WhatsApp nudge",
    });

    expect(body.tombstones.length).toBe(DEMO_INVOICES.length);
    for (const tombstone of body.tombstones) {
      for (const key of ["look", "ariaLabel", "caveat", "next"]) expect(tombstone).not.toHaveProperty(key);
    }
  });

  it("looks up the demo supplier and loads the graveyard once with the resolved date", async () => {
    await GET(authed(`?today=${DEMO_TODAY}`));

    expect(mocks.getDb).toHaveBeenCalledTimes(1);
    expect(mocks.findSupplierIdByUdyam).toHaveBeenCalledTimes(1);
    expect(mocks.findSupplierIdByUdyam).toHaveBeenCalledWith(mocks.db, DEMO_SUPPLIER.udyamNumber);
    expect(mocks.loadGraveyardData).toHaveBeenCalledTimes(1);
    expect(mocks.loadGraveyardData).toHaveBeenCalledWith(mocks.db, DEMO_ID, DEMO_TODAY);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("falls back to the IST date for an invalid ?today=", async () => {
    const res = await GET(authed("?today=2027-02-30"));

    expect(res.status).toBe(200);
    expect(mocks.loadGraveyardData).toHaveBeenCalledTimes(1);
    expect(mocks.loadGraveyardData).toHaveBeenCalledWith(mocks.db, DEMO_ID, IST_TODAY);
    const body = await res.json();
    expect(body.today).toBe(IST_TODAY);
    expect(body.todayOverride).toBe(false);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("uses the IST date and no override when ?today= is absent", async () => {
    const res = await GET(authed());

    expect(mocks.loadGraveyardData).toHaveBeenCalledWith(mocks.db, DEMO_ID, IST_TODAY);
    const body = await res.json();
    expect(body.today).toBe(IST_TODAY);
    expect(body.todayOverride).toBe(false);
  });
});

describe("GET /api/crew/summary: secret hygiene", () => {
  it("keeps the Crew_Secret out of the 200 body and the console", async () => {
    const spies = [
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "log").mockImplementation(() => {}),
    ];

    const res = await GET(authed(`?today=${DEMO_TODAY}`));

    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain(CREW_SECRET);
    expect(consoleText(spies)).not.toContain(CREW_SECRET);
  });

  it("keeps the Crew_Secret and the thrown message out of the 500 body and the console", async () => {
    const spies = [
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "log").mockImplementation(() => {}),
    ];
    const message = `select * from suppliers where token = '${CREW_SECRET}' failed`;
    mocks.findSupplierIdByUdyam.mockRejectedValue(new Error(message));

    const res = await GET(authed());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "load_failed" });
    expectNoStore(res);
    expect(mocks.close).toHaveBeenCalledTimes(1);

    const bodyText = JSON.stringify(await GET(authed()).then((r) => r.json()));
    expect(bodyText).not.toContain(CREW_SECRET);
    expect(bodyText).not.toContain(message);
    expect(bodyText).not.toContain("select");

    const logged = consoleText(spies);
    expect(logged).toContain("crew summary failed");
    expect(logged).not.toContain(CREW_SECRET);
    expect(logged).not.toContain(message);
  });
});

// --- Property test ----------------------------------------------------------------------------------------------

/** Printable ASCII only: Headers.set rejects line breaks and non-Latin-1 characters. */
const asciiText = fc.string({ unit: "grapheme-ascii", maxLength: 80 });

/** A Crew_Secret generated per run: printable ASCII, non-empty, never the Ladder_Secret. */
const crewSecret = fc
  .string({ unit: "grapheme-ascii", minLength: 1, maxLength: 80 })
  .filter((secret) => secret !== LADDER_SECRET);
/** The secret with one edit: a char inserted, dropped or replaced, a case flip, or a truncation. */
const secretMutation = (secret: string): fc.Arbitrary<string> =>
  fc
    .tuple(fc.nat({ max: secret.length }), fc.string({ unit: "grapheme-ascii", minLength: 1, maxLength: 1 }), fc.constantFrom("insert", "drop", "replace", "case", "truncate"))
    .map(([at, ch, kind]) => {
      const i = Math.min(at, secret.length - 1);
      switch (kind) {
        case "insert":
          return secret.slice(0, at) + ch + secret.slice(at);
        case "drop":
          return secret.slice(0, i) + secret.slice(i + 1);
        case "replace":
          return secret.slice(0, i) + ch + secret.slice(i + 1);
        case "case":
          return secret.toUpperCase();
        case "truncate":
          return secret.slice(0, i);
      }
    });
/** An Authorization header value (or none) that is not the given secret's bearer header. */
const rejectedAuthorization = (secret: string): fc.Arbitrary<string | undefined> =>
  fc
    .oneof(
      fc.constant(undefined),
      asciiText.filter((token) => token !== secret).map((token) => `Bearer ${token}`),
      asciiText,
      secretMutation(secret).map((token) => `Bearer ${token}`),
      secretMutation(secret),
      fc.constant(`Bearer ${LADDER_SECRET}`),
      fc.constant(LADDER_SECRET),
      fc.constant(secret),
      fc.constant(`bearer ${secret}`),
      fc.constant(`Basic ${secret}`),
      fc.constant("Bearer "),
    )
    .filter((value) => value === undefined || value.trim() !== `Bearer ${secret}`);
describe("GET /api/crew/summary: auth gate property", () => {
  // Feature: crew-api, Property 2: Only the Crew_Secret opens the route
  // Validates: Requirements 2.4, 2.5, 5.2
  it("answers 401 and never opens the database for any Authorization value other than the Crew_Secret's", async () => {
    await fc.assert(
      fc.asyncProperty(
        crewSecret.chain((secret) => fc.tuple(fc.constant(secret), rejectedAuthorization(secret))),
        async ([secret, auth]) => {
          vi.stubEnv("CREW_READ_SECRET", secret);
          mocks.getDb.mockClear();
          mocks.findSupplierIdByUdyam.mockClear();
          mocks.loadGraveyardData.mockClear();
          const res = await GET(request(auth === undefined ? {} : { auth }));
          expect(res.status).toBe(401);
          expect(await res.json()).toEqual({ error: "Unauthorized" });
          expect(res.headers.get("cache-control")).toBe("no-store");
          expect(mocks.getDb).not.toHaveBeenCalled();
          expect(mocks.findSupplierIdByUdyam).not.toHaveBeenCalled();
          expect(mocks.loadGraveyardData).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 200 },
    );
  });
});
