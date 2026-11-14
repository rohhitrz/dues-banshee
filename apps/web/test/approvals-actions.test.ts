import { DEMO_SUPPLIER, type Db, type Supplier } from "@dues-banshee/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  redirect: vi.fn((url: string) => {
    // Next's redirect() never returns: it throws to navigate.
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  revalidatePath: vi.fn(),
  getDb: vi.fn(),
  close: vi.fn(),
  getSupplier: vi.fn(),
  getDraftForSupplier: vi.fn(),
  approveDraft: vi.fn(),
  editDraft: vi.fn(),
  rejectDraft: vi.fn(),
  redraft: vi.fn(),
  runLadder: vi.fn(),
  productionModels: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("@dues-banshee/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dues-banshee/db")>()),
  getSupplier: mocks.getSupplier,
  getDraftForSupplier: mocks.getDraftForSupplier,
}));
// No live model call and no provider key: the agent's entry points are replaced.
vi.mock("@dues-banshee/agent", () => ({
  approveDraft: mocks.approveDraft,
  editDraft: mocks.editDraft,
  rejectDraft: mocks.rejectDraft,
  redraft: mocks.redraft,
  runLadder: mocks.runLadder,
  productionModels: mocks.productionModels,
}));

import { approve, checkLadderNow, redraftIn, reject, saveEdit } from "@/app/(app)/approvals/actions";

const SUPPLIER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_SUPPLIER_ID = "00000000-0000-4000-8000-0000000000ff";
const DRAFT_ID = "00000000-0000-4000-8000-0000000000d1";
const BUYER_ID = "00000000-0000-4000-8000-0000000000b1";
const SUPPLIER: Supplier = { id: SUPPLIER_ID, ...DEMO_SUPPLIER };
const DB = {} as Db;
const DEBTOR_URL = `/debtors/${BUYER_ID}`;

// 2026-11-12 11:30 IST.
const NOW = Date.parse("2026-11-12T06:00:00Z");

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

/** Runs a server action and returns the URL it redirected to (the mock throws, as Next's redirect does). */
async function redirectOf(run: () => Promise<void>): Promise<string> {
  try {
    await run();
  } catch (err) {
    const match = /^NEXT_REDIRECT (.*)$/.exec((err as Error).message);
    if (match !== null) return match[1]!;
    throw err;
  }
  throw new Error("the action did not redirect");
}

let nowSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mocks.auth.mockReset().mockResolvedValue({ supplierId: SUPPLIER_ID });
  mocks.redirect.mockClear();
  mocks.revalidatePath.mockReset();
  mocks.close.mockReset().mockResolvedValue(undefined);
  mocks.getDb.mockReset().mockReturnValue({ db: DB, close: mocks.close });
  mocks.getSupplier.mockReset().mockResolvedValue(SUPPLIER);
  // The Draft belongs to the demo supplier only; any other supplier gets null, as the real read does.
  mocks.getDraftForSupplier
    .mockReset()
    .mockImplementation(async (_db: Db, supplierId: string, draftId: string) =>
      supplierId === SUPPLIER_ID && draftId === DRAFT_ID ? { buyerId: BUYER_ID } : null,
    );
  mocks.approveDraft.mockReset().mockResolvedValue({ kind: "ok" });
  mocks.editDraft.mockReset().mockResolvedValue({ kind: "ok" });
  mocks.rejectDraft.mockReset().mockResolvedValue({ kind: "ok" });
  mocks.redraft.mockReset().mockResolvedValue({ kind: "ok" });
  mocks.runLadder.mockReset().mockResolvedValue({ supplierId: SUPPLIER_ID, today: "2026-11-12", invoices: {} });
  mocks.productionModels.mockReset().mockReturnValue({ sentinel: "models" });
  nowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  nowSpy.mockRestore();
});

describe("approvals actions follow an allowlisted returnTo", () => {
  it("approve returns to /debtors/<uuid> keeping the notice and the today override", async () => {
    const url = await redirectOf(() =>
      approve(form({ draftId: DRAFT_ID, today: "2027-03-10", returnTo: DEBTOR_URL })),
    );

    expect(url).toBe(`${DEBTOR_URL}?today=2027-03-10&notice=approved`);
  });

  it("an uppercase uuid in returnTo is followed, lowercased", async () => {
    const target = `/debtors/${BUYER_ID.toUpperCase()}`;
    const url = await redirectOf(() => approve(form({ draftId: DRAFT_ID, returnTo: target })));

    expect(url).toBe(`/debtors/${BUYER_ID.toLowerCase()}?notice=approved`);
  });

  it("saveEdit and reject return to the debtor page with their own notice", async () => {
    expect(await redirectOf(() => saveEdit(form({ draftId: DRAFT_ID, body: "x", returnTo: DEBTOR_URL })))).toBe(
      `${DEBTOR_URL}?notice=saved`,
    );
    expect(await redirectOf(() => reject(form({ draftId: DRAFT_ID, returnTo: DEBTOR_URL })))).toBe(
      `${DEBTOR_URL}?notice=rejected`,
    );
  });

  it("redraftIn returns to the debtor page, and so does its unknown-language branch", async () => {
    expect(
      await redirectOf(() => redraftIn(form({ draftId: DRAFT_ID, language: "english", returnTo: DEBTOR_URL }))),
    ).toBe(`${DEBTOR_URL}?notice=redrafted`);
    expect(
      await redirectOf(() => redraftIn(form({ draftId: DRAFT_ID, language: "french", returnTo: DEBTOR_URL }))),
    ).toBe(`${DEBTOR_URL}?notice=draft_failed`);
    expect(mocks.redraft).toHaveBeenCalledTimes(1);
  });

  it("keeps label and n from the notice when returning to the debtor page", async () => {
    mocks.approveDraft.mockResolvedValue({
      kind: "expired",
      decision: { action: "wait", applicable: true, reason: "promise_active", ruleIds: [] },
    });

    const url = await redirectOf(() =>
      approve(form({ draftId: DRAFT_ID, today: "2027-03-10", returnTo: DEBTOR_URL })),
    );

    expect(url).toBe(`${DEBTOR_URL}?today=2027-03-10&notice=expired&label=wait%3Apromise_active`);
  });

  for (const [name, returnTo] of [
    ["missing", undefined],
    ["empty", ""],
    ["protocol-relative", "//evil.example"],
    ["absolute", "https://evil.example"],
    ["a non-uuid buyer", "/debtors/not-a-uuid"],
    ["the root", "/"],
    ["a debtor target with a suffix", `${DEBTOR_URL}/x`],
  ] as const) {
    it(`returnTo ${name} goes to /approvals`, async () => {
      const fields: Record<string, string> = { draftId: DRAFT_ID, today: "2027-03-10" };
      if (returnTo !== undefined) fields.returnTo = returnTo;

      const url = await redirectOf(() => approve(form(fields)));

      expect(url).toBe("/approvals?today=2027-03-10&notice=approved");
    });
  }

  it("returnTo /approvals goes to /approvals", async () => {
    const url = await redirectOf(() => approve(form({ draftId: DRAFT_ID, returnTo: "/approvals" })));

    expect(url).toBe("/approvals?notice=approved");
  });

  it("a bad draft id still follows a valid returnTo with the not_found notice", async () => {
    const url = await redirectOf(() => approve(form({ draftId: "nope", returnTo: DEBTOR_URL })));

    expect(url).toBe(`${DEBTOR_URL}?notice=not_found`);
    expect(mocks.approveDraft).not.toHaveBeenCalled();
    expect(mocks.revalidatePath.mock.calls).toEqual([["/approvals"]]);
  });
});

describe("approvals actions revalidate the buyer's page for the supplier's own Draft", () => {
  it("revalidates /approvals and /debtors/<buyerId> for the session supplier's Draft", async () => {
    await redirectOf(() => approve(form({ draftId: DRAFT_ID, returnTo: DEBTOR_URL })));

    expect(mocks.getDraftForSupplier.mock.calls).toEqual([[DB, SUPPLIER_ID, DRAFT_ID]]);
    expect(mocks.revalidatePath.mock.calls).toEqual([["/approvals"], [DEBTOR_URL]]);
  });

  it("revalidates the buyer's page even when the owner returns to /approvals", async () => {
    await redirectOf(() => reject(form({ draftId: DRAFT_ID })));

    expect(mocks.revalidatePath.mock.calls).toEqual([["/approvals"], [DEBTOR_URL]]);
  });

  it("revalidates the buyer's page for the unknown-language branch of redraftIn", async () => {
    await redirectOf(() => redraftIn(form({ draftId: DRAFT_ID, language: "x" })));

    expect(mocks.revalidatePath.mock.calls).toEqual([["/approvals"], [DEBTOR_URL]]);
  });

  it("revalidates only /approvals for another supplier's Draft, and never a foreign buyer's page", async () => {
    mocks.auth.mockResolvedValue({ supplierId: OTHER_SUPPLIER_ID });
    mocks.getSupplier.mockResolvedValue({ ...SUPPLIER, id: OTHER_SUPPLIER_ID });

    const url = await redirectOf(() => approve(form({ draftId: DRAFT_ID, returnTo: DEBTOR_URL })));

    expect(mocks.getDraftForSupplier.mock.calls).toEqual([[DB, OTHER_SUPPLIER_ID, DRAFT_ID]]);
    expect(mocks.revalidatePath.mock.calls).toEqual([["/approvals"]]);
    expect(url.startsWith(DEBTOR_URL)).toBe(true);
  });

  it("looks nothing up for a draft id that is not a uuid", async () => {
    await redirectOf(() => approve(form({ draftId: "1; drop table drafts" })));

    expect(mocks.getDraftForSupplier).not.toHaveBeenCalled();
  });
});

describe("approvals actions keep their other behaviour", () => {
  it("checkLadderNow ignores returnTo and revalidates only /approvals", async () => {
    const url = await redirectOf(() => checkLadderNow(form({ returnTo: DEBTOR_URL })));

    expect(url).toBe("/approvals?notice=ladder_checked&n=0");
    expect(mocks.revalidatePath.mock.calls).toEqual([["/approvals"]]);
    expect(mocks.getDraftForSupplier).not.toHaveBeenCalled();
  });

  it("a stale session still redirects once to /signin?error=SessionExpired, whatever the returnTo", async () => {
    const { SupplierNotFoundError } = await import("@dues-banshee/db");
    mocks.getSupplier.mockRejectedValue(new SupplierNotFoundError("gone"));

    await expect(approve(form({ draftId: DRAFT_ID, returnTo: DEBTOR_URL }))).rejects.toThrow(
      "NEXT_REDIRECT /signin?error=SessionExpired",
    );
    expect(mocks.redirect.mock.calls).toEqual([["/signin?error=SessionExpired"]]);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    expect(mocks.approveDraft).not.toHaveBeenCalled();
  });
});
