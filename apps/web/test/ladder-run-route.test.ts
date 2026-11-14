import { DEMO_SUPPLIER } from "@dues-banshee/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted above the imports, so the mocks' state has to be hoisted with it.
const mocks = vi.hoisted(() => ({
  db: { sentinel: "db" } as const,
  close: undefined as unknown as ReturnType<typeof vi.fn>,
  getDb: undefined as unknown as ReturnType<typeof vi.fn>,
  runLadder: undefined as unknown as ReturnType<typeof vi.fn>,
  productionModels: undefined as unknown as ReturnType<typeof vi.fn>,
  listRunSuppliers: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("@/lib/db", () => {
  mocks.close = vi.fn(async () => {});
  mocks.getDb = vi.fn(() => ({ db: mocks.db, close: mocks.close }));
  return { getDb: mocks.getDb };
});

vi.mock("@dues-banshee/agent", () => {
  mocks.runLadder = vi.fn();
  mocks.productionModels = vi.fn();
  return { runLadder: mocks.runLadder, productionModels: mocks.productionModels };
});

vi.mock("@dues-banshee/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dues-banshee/db")>();
  mocks.listRunSuppliers = vi.fn();
  return { ...actual, listRunSuppliers: mocks.listRunSuppliers };
});

import { POST } from "@/app/api/ladder/run/route";

const SECRET = "ladder-run-secret-for-tests-0123456789";
const URL_BASE = "http://localhost/api/ladder/run";
const MODELS = { models: "mock" };

// 2026-11-12 20:00 UTC is 2026-11-13 01:30 IST, so the IST date differs from the UTC date.
const NOW = new Date("2026-11-12T20:00:00Z");
const IST_TODAY = "2026-11-13";

const DEMO = { id: "supplier-demo", udyamNumber: DEMO_SUPPLIER.udyamNumber };
const OTHER = { id: "supplier-other", udyamNumber: "UDYAM-XX-00-0000000" };

function request(options: { auth?: string; query?: string } = {}): Request {
  const headers = new Headers();
  if (options.auth !== undefined) headers.set("authorization", options.auth);
  return new Request(`${URL_BASE}${options.query ?? ""}`, { method: "POST", headers });
}

const authed = (query = ""): Request => request({ auth: `Bearer ${SECRET}`, query });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("LADDER_RUN_SECRET", SECRET);
  mocks.productionModels.mockReturnValue(MODELS);
  mocks.listRunSuppliers.mockResolvedValue([DEMO]);
  mocks.runLadder.mockImplementation(async (_deps: unknown, supplierId: string, today: string) => ({
    supplierId,
    today,
    invoices: {},
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  mocks.close.mockClear();
  mocks.getDb.mockClear();
  mocks.runLadder.mockReset();
  mocks.productionModels.mockReset();
  mocks.listRunSuppliers.mockReset();
});

describe("POST /api/ladder/run", () => {
  it("returns 503 when LADDER_RUN_SECRET is not set, before looking at the header", async () => {
    vi.stubEnv("LADDER_RUN_SECRET", "");
    const res = await POST(authed());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not_configured" });
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.runLadder).not.toHaveBeenCalled();
  });

  it("returns 401 with no Authorization header", async () => {
    const res = await POST(request());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.runLadder).not.toHaveBeenCalled();
  });

  it.each([
    ["a wrong bearer", `Bearer ${SECRET}x`],
    ["a bare secret without the Bearer scheme", SECRET],
    ["an empty bearer", "Bearer "],
  ])("returns 401 with %s", async (_label, header) => {
    const res = await POST(request({ auth: header }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.runLadder).not.toHaveBeenCalled();
  });

  it("returns 200 with one result per supplier and closes the database", async () => {
    const invoices = { "inv-1": { kind: "drafted", draftId: "draft-1" } };
    mocks.runLadder.mockResolvedValueOnce({ supplierId: DEMO.id, today: IST_TODAY, invoices });

    const res = await POST(authed());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runs: [{ supplierId: DEMO.id, today: IST_TODAY, invoices }] });
    expect(mocks.runLadder).toHaveBeenCalledTimes(1);
    expect(mocks.runLadder).toHaveBeenCalledWith({ db: mocks.db, models: MODELS }, DEMO.id, IST_TODAY);
    expect(mocks.listRunSuppliers).toHaveBeenCalledWith(mocks.db);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("uses ?today= for the demo supplier only; every other supplier gets the IST date", async () => {
    mocks.listRunSuppliers.mockResolvedValue([DEMO, OTHER]);

    const res = await POST(authed("?today=2027-03-10"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      runs: [
        { supplierId: DEMO.id, today: "2027-03-10", invoices: {} },
        { supplierId: OTHER.id, today: IST_TODAY, invoices: {} },
      ],
    });
    expect(mocks.runLadder.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      [DEMO.id, "2027-03-10"],
      [OTHER.id, IST_TODAY],
    ]);
  });

  it("ignores an invalid ?today= and runs the demo supplier on the IST date", async () => {
    const res = await POST(authed("?today=2027-02-30"));
    expect(await res.json()).toEqual({ runs: [{ supplierId: DEMO.id, today: IST_TODAY, invoices: {} }] });
  });

  it("reports run_failed for a throwing supplier without leaking details, and still runs the others", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.listRunSuppliers.mockResolvedValue([DEMO, OTHER]);
    const failure = new Error(`select "id" from "invoices" where token = '${SECRET}' failed`);
    mocks.runLadder.mockImplementation(async (_deps: unknown, supplierId: string, today: string) => {
      if (supplierId === DEMO.id) throw failure;
      return { supplierId, today, invoices: {} };
    });

    const res = await POST(authed());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      runs: [
        { supplierId: DEMO.id, today: IST_TODAY, error: "run_failed" },
        { supplierId: OTHER.id, today: IST_TODAY, invoices: {} },
      ],
    });

    const text = JSON.stringify(await POST(authed()).then((r) => r.json()));
    expect(text).not.toContain("select");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(failure.message);
    expect(text).not.toMatch(/\bat\s.+\(/);
    expect(text).not.toContain("stack");

    expect(mocks.runLadder).toHaveBeenCalledTimes(4);
    expect(consoleError).toHaveBeenCalledWith(
      "ladder run failed",
      { supplierId: DEMO.id, today: IST_TODAY },
      failure,
    );
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });
});
