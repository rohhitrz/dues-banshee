import {
  DEMO_INVOICES,
  DEMO_SUPPLIER,
  SupplierNotFoundError,
  toEngineInvoice,
  type Db,
  type DraftRow,
  type DraftWithContext,
  type InvoiceRow,
  type Supplier,
  type SupplierRow,
} from "@dues-banshee/db";
import type { EscalationDecision } from "@dues-banshee/engine";
import { renderToStaticMarkup } from "react-dom/server";
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
  listPendingDrafts: vi.fn(),
  approveDraft: vi.fn(),
  editDraft: vi.fn(),
  rejectDraft: vi.fn(),
  redraft: vi.fn(),
  runLadder: vi.fn(),
  productionModels: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("@dues-banshee/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dues-banshee/db")>()),
  getSupplier: mocks.getSupplier,
  listPendingDrafts: mocks.listPendingDrafts,
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

import ApprovalsPage from "@/app/(app)/approvals/page";
import { approve, checkLadderNow, redraftIn, reject, saveEdit } from "@/app/(app)/approvals/actions";

const SUPPLIER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_SUPPLIER_ID = "00000000-0000-4000-8000-0000000000ff";
const DRAFT_ID = "00000000-0000-4000-8000-0000000000d1";
const SUPPLIER: Supplier = { id: SUPPLIER_ID, ...DEMO_SUPPLIER };
const SUPPLIER_ROW: SupplierRow = {
  ...SUPPLIER,
  udyamRegisteredOn: DEMO_SUPPLIER.udyamRegisteredOn,
  createdAt: new Date(0),
};
const DB = {} as Db;
const MODELS = { sentinel: "models" };

const CAVEAT_BADGE = "Registered on Udyam after supply: claim may be contested";
const STALE_REDIRECT = "NEXT_REDIRECT /signin?error=SessionExpired";

// 2026-11-12 11:30 IST, so Today is 2026-11-12 whenever a form gives no `today`.
const NOW = Date.parse("2026-11-12T06:00:00Z");

const ADVANCE_NUDGE: EscalationDecision = {
  action: "advance",
  applicable: true,
  step: "whatsapp_nudge",
  rank: 1,
  requiresApproval: false,
  ruleIds: ["MSMED-15"],
};
const ADVANCE_NUDGE_CAVEAT: EscalationDecision = {
  ...ADVANCE_NUDGE,
  caveat: "registered_after_supply",
  ruleIds: ["MSMED-15", "MSMED-SCOPE"],
};
const ADVANCE_NOTICE: EscalationDecision = {
  action: "advance",
  applicable: true,
  step: "legal_notice",
  rank: 4,
  requiresApproval: true,
  ruleIds: ["MSMED-15", "MSMED-16"],
};

function draftItem(options: {
  id: string;
  demoIndex: number;
  step: DraftRow["step"];
  decision: EscalationDecision;
  createdAt: number;
  finalText: string;
  bodyText: string;
  ruleIds: string[];
  modelId: string;
}): DraftWithContext {
  const demo = DEMO_INVOICES[options.demoIndex]!;
  const row: InvoiceRow = {
    id: `inv-${options.id}`,
    supplierId: SUPPLIER_ID,
    buyerId: `buyer-${options.id}`,
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
  const draft: DraftRow = {
    id: options.id,
    invoiceId: row.id,
    step: options.step,
    status: "pending",
    language: "hinglish",
    bodyText: options.bodyText,
    finalText: options.finalText,
    ruleIds: options.ruleIds,
    modelId: options.modelId,
    decision: options.decision,
    document: null,
    createdOn: "2026-11-12",
    decidedAt: null,
    createdAt: new Date(options.createdAt),
  };
  return {
    draft,
    invoice: toEngineInvoice(row, SUPPLIER_ROW),
    invoiceDate: row.invoiceDate,
    acceptanceDateDefaulted: false,
    buyerId: row.buyerId,
    buyerName: demo.buyerName,
    invoiceNumber: demo.invoiceNumber,
  };
}

// Listed oldest first, as `listPendingDrafts` returns them. Sharma Traders is DEMO_INVOICES[0].
function pendingItems(): DraftWithContext[] {
  return [
    draftItem({
      id: "00000000-0000-4000-8000-0000000000d2",
      demoIndex: 1,
      step: "legal_notice",
      decision: ADVANCE_NOTICE,
      createdAt: 1000,
      bodyText: "Notice body for the second buyer",
      finalText:
        "Notice body for the second buyer\n\nBasis: MSMED-15 (MSMED Act 2006, s.15); MSMED-16 (MSMED Act 2006, s.16)\nNot legal advice.",
      ruleIds: ["MSMED-15", "MSMED-16"],
      modelId: "mock-sonnet",
    }),
    draftItem({
      id: DRAFT_ID,
      demoIndex: 0,
      step: "whatsapp_nudge",
      decision: ADVANCE_NUDGE_CAVEAT,
      createdAt: 2000,
      bodyText: "Sharma ji, a gentle reminder about LPC/26-27/0412",
      finalText:
        "Sharma ji, a gentle reminder about LPC/26-27/0412\n\nBasis: MSMED-15 (MSMED Act 2006, s.15); MSMED-SCOPE (MSMED Act s.2(n))\nNot legal advice.",
      ruleIds: ["MSMED-15", "MSMED-SCOPE"],
      modelId: "mock-haiku",
    }),
  ];
}

type SearchParams = Record<string, string | string[] | undefined>;

async function render(searchParams: SearchParams = {}): Promise<string> {
  const element = await ApprovalsPage({ searchParams: Promise.resolve(searchParams) });
  return renderToStaticMarkup(element);
}

/** Visible text: tags removed, the one entity React escapes in these strings turned back. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

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

/** The `?notice=` URL an action redirected to, as the page's `searchParams`. */
function paramsOf(url: string): SearchParams {
  return Object.fromEntries(new URL(url, "http://localhost").searchParams.entries());
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let nowSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mocks.auth.mockReset().mockResolvedValue({ supplierId: SUPPLIER_ID });
  mocks.redirect.mockClear();
  mocks.revalidatePath.mockReset();
  mocks.close.mockReset().mockResolvedValue(undefined);
  mocks.getDb.mockReset().mockReturnValue({ db: DB, close: mocks.close });
  mocks.getSupplier.mockReset().mockResolvedValue(SUPPLIER);
  mocks.listPendingDrafts.mockReset().mockResolvedValue(pendingItems());
  mocks.approveDraft.mockReset().mockResolvedValue({ kind: "ok" });
  mocks.editDraft.mockReset().mockResolvedValue({ kind: "ok" });
  mocks.rejectDraft.mockReset().mockResolvedValue({ kind: "ok" });
  mocks.redraft.mockReset().mockResolvedValue({ kind: "ok" });
  mocks.runLadder.mockReset().mockResolvedValue({ supplierId: SUPPLIER_ID, today: "2026-11-12", invoices: {} });
  mocks.productionModels.mockReset().mockReturnValue(MODELS);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  nowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  errorSpy.mockRestore();
  nowSpy.mockRestore();
});

describe("ApprovalsPage session", () => {
  it("redirects to /signin when signed out, before reading any data", async () => {
    mocks.auth.mockResolvedValue(null);

    await expect(render()).rejects.toThrow("NEXT_REDIRECT /signin");
    expect(mocks.redirect.mock.calls).toEqual([["/signin"]]);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("redirects to /signin when the session has no supplierId", async () => {
    mocks.auth.mockResolvedValue({});

    await expect(render()).rejects.toThrow("NEXT_REDIRECT /signin");
    expect(mocks.redirect.mock.calls).toEqual([["/signin"]]);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("redirects exactly once to /signin?error=SessionExpired and renders no markup for a stale session", async () => {
    mocks.getSupplier.mockRejectedValue(new SupplierNotFoundError("gone"));

    await expect(render()).rejects.toThrow(STALE_REDIRECT);
    expect(mocks.redirect.mock.calls).toEqual([["/signin?error=SessionExpired"]]);
    expect(mocks.listPendingDrafts).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("ignores a supplier id in the query and reads only the session's supplier", async () => {
    await render({ supplierId: OTHER_SUPPLIER_ID, supplier: OTHER_SUPPLIER_ID });

    expect(mocks.getSupplier.mock.calls).toEqual([[DB, SUPPLIER_ID]]);
    expect(mocks.listPendingDrafts.mock.calls).toEqual([[DB, SUPPLIER_ID]]);
    expect(JSON.stringify(mocks.listPendingDrafts.mock.calls)).not.toContain(OTHER_SUPPLIER_ID);
  });
});

describe("ApprovalsPage pending list", () => {
  it("lists the Drafts oldest first, each with every field, and closes the database", async () => {
    const html = await render();
    const text = visibleText(html);

    expect(mocks.listPendingDrafts.mock.calls).toEqual([[DB, SUPPLIER_ID]]);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(count(html, "<article")).toBe(2);

    const second = html.indexOf("Gupta Engineering Works");
    const first = html.indexOf("Sharma Traders");
    expect(second).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(second);

    // The legal-notice card (listed first).
    const noticeCard = html.slice(html.indexOf("<article"), html.indexOf("<article", 1 + html.indexOf("<article")));
    const noticeText = visibleText(noticeCard);
    expect(noticeText).toContain("Gupta Engineering Works");
    expect(noticeText).toContain(DEMO_INVOICES[1]!.invoiceNumber);
    expect(noticeText).toContain("Legal notice");
    expect(noticeText).toContain("Needs your approval");
    expect(noticeText).toContain(
      "Notice body for the second buyer Basis: MSMED-15 (MSMED Act 2006, s.15); MSMED-16 (MSMED Act 2006, s.16) Not legal advice.",
    );
    expect(noticeText).toContain("Rule IDs MSMED-15, MSMED-16");
    expect(noticeText).toContain("Model mock-sonnet");
    expect(noticeCard).toContain(
      'href="/api/drafts/00000000-0000-4000-8000-0000000000d2/document"',
    );
    expect(noticeText).not.toContain(CAVEAT_BADGE);

    // The WhatsApp card (listed second), with the caveat.
    const nudgeCard = html.slice(html.lastIndexOf("<article"));
    const nudgeText = visibleText(nudgeCard);
    expect(nudgeText).toContain("Sharma Traders");
    expect(nudgeText).toContain("LPC/26-27/0412");
    expect(nudgeText).toContain("WhatsApp nudge");
    expect(nudgeText).toContain("Needs your approval");
    expect(nudgeText).toContain(
      "Sharma ji, a gentle reminder about LPC/26-27/0412 Basis: MSMED-15 (MSMED Act 2006, s.15); MSMED-SCOPE (MSMED Act s.2(n)) Not legal advice.",
    );
    expect(nudgeText).toContain("Rule IDs MSMED-15, MSMED-SCOPE");
    expect(nudgeText).toContain("Model mock-haiku");
    expect(nudgeText).toContain(CAVEAT_BADGE);
    expect(nudgeCard).not.toContain("/document");
    expect(nudgeCard).toContain(">Sharma ji, a gentle reminder about LPC/26-27/0412</textarea>");

    expect(count(text, "Needs your approval")).toBe(2);
    expect(count(text, CAVEAT_BADGE)).toBe(1);
    for (const label of ["Approve", "Save edit", "Reject", "Redraft in English", "Redraft in Hinglish"]) {
      expect(count(text, label)).toBe(2);
    }
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("shows the empty state with a link back to /", async () => {
    mocks.listPendingDrafts.mockResolvedValue([]);

    const html = await render();

    expect(visibleText(html)).toContain("No drafts waiting");
    expect(html).toMatch(/<a [^>]*href="\/"[^>]*>Back to the graveyard<\/a>/);
    expect(count(html, "<article")).toBe(0);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe("approvals actions use only the session supplier", () => {
  const FORGED = { draftId: DRAFT_ID, supplierId: OTHER_SUPPLIER_ID };

  function expectScopedToSession(): void {
    expect(mocks.getSupplier.mock.calls).toEqual([[DB, SUPPLIER_ID]]);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  }

  it("approve passes the session supplier and ignores a supplierId form field", async () => {
    const url = await redirectOf(() => approve(form(FORGED)));

    expect(url).toBe("/approvals?notice=approved");
    expect(mocks.approveDraft.mock.calls).toEqual([[{ db: DB }, SUPPLIER_ID, DRAFT_ID, "2026-11-12"]]);
    expect(mocks.revalidatePath.mock.calls).toEqual([["/approvals"]]);
    expectScopedToSession();
  });

  it("saveEdit passes the session supplier and the edited body, and ignores a supplierId form field", async () => {
    const url = await redirectOf(() => saveEdit(form({ ...FORGED, body: "Sharma ji, please look at this" })));

    expect(url).toBe("/approvals?notice=saved");
    expect(mocks.editDraft.mock.calls).toEqual([
      [{ db: DB }, SUPPLIER_ID, DRAFT_ID, "Sharma ji, please look at this", "2026-11-12"],
    ]);
    expectScopedToSession();
  });

  it("reject passes the session supplier and the trimmed reason, and ignores a supplierId form field", async () => {
    const url = await redirectOf(() => reject(form({ ...FORGED, reason: "  buyer called the owner  " })));

    expect(url).toBe("/approvals?notice=rejected");
    expect(mocks.rejectDraft.mock.calls).toEqual([
      [{ db: DB }, SUPPLIER_ID, DRAFT_ID, "buyer called the owner", "2026-11-12"],
    ]);
    expectScopedToSession();
  });

  it("reject with a blank reason passes null", async () => {
    await redirectOf(() => reject(form({ ...FORGED, reason: "   " })));

    expect(mocks.rejectDraft.mock.calls).toEqual([[{ db: DB }, SUPPLIER_ID, DRAFT_ID, null, "2026-11-12"]]);
  });

  it("redraftIn passes the session supplier and the language, and ignores a supplierId form field", async () => {
    const url = await redirectOf(() => redraftIn(form({ ...FORGED, language: "english" })));

    expect(url).toBe("/approvals?notice=redrafted");
    expect(mocks.redraft.mock.calls).toEqual([
      [{ db: DB, models: MODELS }, SUPPLIER_ID, DRAFT_ID, "english", "2026-11-12"],
    ]);
    expectScopedToSession();
  });

  it("redraftIn with an unknown language calls no model", async () => {
    const url = await redirectOf(() => redraftIn(form({ ...FORGED, language: "french" })));

    expect(url).toBe("/approvals?notice=draft_failed");
    expect(mocks.redraft).not.toHaveBeenCalled();
  });

  it("no action reads a supplierId from the form", async () => {
    await redirectOf(() => approve(form(FORGED)));
    await redirectOf(() => saveEdit(form({ ...FORGED, body: "x" })));
    await redirectOf(() => reject(form(FORGED)));
    await redirectOf(() => redraftIn(form({ ...FORGED, language: "hinglish" })));
    await redirectOf(() => checkLadderNow(form({ supplierId: OTHER_SUPPLIER_ID })));

    const calls = [
      ...mocks.approveDraft.mock.calls,
      ...mocks.editDraft.mock.calls,
      ...mocks.rejectDraft.mock.calls,
      ...mocks.redraft.mock.calls,
      ...mocks.runLadder.mock.calls,
      ...mocks.getSupplier.mock.calls,
    ];
    expect(calls).toHaveLength(10);
    expect(JSON.stringify(calls)).not.toContain(OTHER_SUPPLIER_ID);
  });

  it("a signed-out action redirects to /signin and touches nothing", async () => {
    mocks.auth.mockResolvedValue(null);

    await expect(approve(form(FORGED))).rejects.toThrow("NEXT_REDIRECT /signin");
    expect(mocks.redirect.mock.calls).toEqual([["/signin"]]);
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.approveDraft).not.toHaveBeenCalled();
  });

  it("a stale session in an action redirects once to /signin?error=SessionExpired and decides nothing", async () => {
    mocks.getSupplier.mockRejectedValue(new SupplierNotFoundError("gone"));

    await expect(approve(form(FORGED))).rejects.toThrow(STALE_REDIRECT);
    expect(mocks.redirect.mock.calls).toEqual([["/signin?error=SessionExpired"]]);
    expect(mocks.approveDraft).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});

describe("approvals messages", () => {
  it("shows 'This draft is out of date: <Wait_Text>' when a promise made the Draft stale", async () => {
    mocks.approveDraft.mockResolvedValue({
      kind: "expired",
      decision: { action: "wait", applicable: true, reason: "promise_active", ruleIds: [] },
    });

    const url = await redirectOf(() => approve(form({ draftId: DRAFT_ID })));
    expect(url).toBe("/approvals?notice=expired&label=wait%3Apromise_active");

    const html = await render(paramsOf(url));
    expect(visibleText(html)).toContain("This draft is out of date: Promise to pay active");
    expect(html).toContain('role="alert"');
  });

  it("shows 'This draft is out of date: <Step_Text>' when the Engine now wants another step", async () => {
    mocks.approveDraft.mockResolvedValue({ kind: "expired", decision: ADVANCE_NOTICE });

    const url = await redirectOf(() => approve(form({ draftId: DRAFT_ID })));
    expect(url).toBe("/approvals?notice=expired&label=step%3Alegal_notice");

    const html = await render(paramsOf(url));
    expect(visibleText(html)).toContain("This draft is out of date: Legal notice");
  });

  it("shows only the fixed text for an unknown label, never the URL's own text", async () => {
    const html = await render({ notice: "expired", label: "<script>alert(1)</script>" });

    expect(visibleText(html)).toContain("This draft is out of date");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("This draft is out of date:");
  });

  it("shows 'The message can't be empty' for an empty edit", async () => {
    mocks.editDraft.mockResolvedValue({ kind: "empty_body" });

    const url = await redirectOf(() => saveEdit(form({ draftId: DRAFT_ID, body: "   " })));
    expect(url).toBe("/approvals?notice=empty_body");

    const html = await render(paramsOf(url));
    expect(visibleText(html)).toContain("The message can't be empty");
    expect(html).toContain('role="alert"');
  });

  it("shows 'This draft was already decided' when the Draft is no longer pending", async () => {
    mocks.approveDraft.mockResolvedValue({ kind: "already_decided" });

    const url = await redirectOf(() => approve(form({ draftId: DRAFT_ID })));
    expect(url).toBe("/approvals?notice=already_decided");

    const html = await render(paramsOf(url));
    expect(visibleText(html)).toContain("This draft was already decided");
  });

  it("a Draft id that is not a UUID is 'Draft not found' and reaches no decision", async () => {
    const url = await redirectOf(() => approve(form({ draftId: "1; drop table drafts" })));

    expect(url).toBe("/approvals?notice=not_found");
    expect(mocks.approveDraft).not.toHaveBeenCalled();
    expect(visibleText(await render(paramsOf(url)))).toContain("Draft not found");
  });

  it("keeps a valid today override through the redirect and uses it as Today", async () => {
    const url = await redirectOf(() => approve(form({ draftId: DRAFT_ID, today: "2027-03-10" })));

    expect(url).toBe("/approvals?today=2027-03-10&notice=approved");
    expect(mocks.approveDraft.mock.calls).toEqual([[{ db: DB }, SUPPLIER_ID, DRAFT_ID, "2027-03-10"]]);
  });
});

describe("checkLadderNow", () => {
  it("calls runLadder once with the session supplier and Today, then reports the new drafts", async () => {
    mocks.runLadder.mockResolvedValue({
      supplierId: SUPPLIER_ID,
      today: "2026-11-12",
      invoices: {
        a: { kind: "drafted", draftId: "d-a" },
        b: { kind: "wait", reason: "not_overdue" },
        c: { kind: "skip", reason: "pending_draft_exists" },
      },
    });

    const url = await redirectOf(() => checkLadderNow(form({ supplierId: OTHER_SUPPLIER_ID })));

    expect(url).toBe("/approvals?notice=ladder_checked&n=1");
    expect(mocks.runLadder.mock.calls).toEqual([[{ db: DB, models: MODELS }, SUPPLIER_ID, "2026-11-12"]]);
    expect(mocks.getSupplier.mock.calls).toEqual([[DB, SUPPLIER_ID]]);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(visibleText(await render(paramsOf(url)))).toContain("Ladder checked. 1 new draft.");
  });

  it("says so when the run made no new draft", async () => {
    const url = await redirectOf(() => checkLadderNow(form({})));

    expect(url).toBe("/approvals?notice=ladder_checked&n=0");
    expect(visibleText(await render(paramsOf(url)))).toContain("Ladder checked. No new drafts.");
  });

  it("reports a failed run with a fixed message and no error text", async () => {
    mocks.runLadder.mockRejectedValue(new Error("select * from invoices failed: password authentication failed"));

    const url = await redirectOf(() => checkLadderNow(form({})));

    expect(url).toBe("/approvals?notice=ladder_failed");
    const html = await render(paramsOf(url));
    expect(visibleText(html)).toContain("Could not check the ladder. Try again.");
    expect(html).not.toContain("password authentication failed");
  });

  it("a stale session redirects once to /signin?error=SessionExpired without running the ladder", async () => {
    mocks.getSupplier.mockRejectedValue(new SupplierNotFoundError("gone"));

    await expect(checkLadderNow(form({}))).rejects.toThrow(STALE_REDIRECT);
    expect(mocks.redirect.mock.calls).toEqual([["/signin?error=SessionExpired"]]);
    expect(mocks.runLadder).not.toHaveBeenCalled();
  });
});
describe("the today override is for the demo supplier only", () => {
  const NON_DEMO: Supplier = { ...SUPPLIER, udyamNumber: "UDYAM-XX-00-0000000" };
  const HIDDEN_TODAY = 'name="today"';
  beforeEach(() => {
    mocks.getSupplier.mockResolvedValue(NON_DEMO);
  });
  it("approve, saveEdit, reject and redraftIn give a non-demo supplier the real IST date and no override", async () => {
    const fields = { draftId: DRAFT_ID, today: "2027-12-31" };
    expect(await redirectOf(() => approve(form(fields)))).toBe("/approvals?notice=approved");
    expect(await redirectOf(() => saveEdit(form({ ...fields, body: "x" })))).toBe("/approvals?notice=saved");
    expect(await redirectOf(() => reject(form(fields)))).toBe("/approvals?notice=rejected");
    expect(await redirectOf(() => redraftIn(form({ ...fields, language: "english" })))).toBe(
      "/approvals?notice=redrafted",
    );
    expect(mocks.approveDraft.mock.calls).toEqual([[{ db: DB }, SUPPLIER_ID, DRAFT_ID, "2026-11-12"]]);
    expect(mocks.editDraft.mock.calls).toEqual([[{ db: DB }, SUPPLIER_ID, DRAFT_ID, "x", "2026-11-12"]]);
    expect(mocks.rejectDraft.mock.calls).toEqual([[{ db: DB }, SUPPLIER_ID, DRAFT_ID, null, "2026-11-12"]]);
    expect(mocks.redraft.mock.calls).toEqual([
      [{ db: DB, models: MODELS }, SUPPLIER_ID, DRAFT_ID, "english", "2026-11-12"],
    ]);
  });
  it("checkLadderNow gives a non-demo supplier the real IST date and drops the override from the redirect", async () => {
    const url = await redirectOf(() => checkLadderNow(form({ today: "2027-12-31" })));
    expect(url).toBe("/approvals?notice=ladder_checked&n=0");
    expect(mocks.runLadder.mock.calls).toEqual([[{ db: DB, models: MODELS }, SUPPLIER_ID, "2026-11-12"]]);
  });
  it("uses the IST date, not the UTC date, for a non-demo supplier", async () => {
    // 2026-11-12 20:00 UTC is 2026-11-13 01:30 IST.
    nowSpy.mockReturnValue(Date.parse("2026-11-12T20:00:00Z"));
    await redirectOf(() => approve(form({ draftId: DRAFT_ID, today: "2027-12-31" })));
    expect(mocks.approveDraft.mock.calls).toEqual([[{ db: DB }, SUPPLIER_ID, DRAFT_ID, "2026-11-13"]]);
  });
  it("a malformed draft id or language from a non-demo supplier keeps no override either", async () => {
    expect(await redirectOf(() => approve(form({ draftId: "nope", today: "2027-12-31" })))).toBe(
      "/approvals?notice=not_found",
    );
    expect(await redirectOf(() => redraftIn(form({ draftId: DRAFT_ID, today: "2027-12-31", language: "x" })))).toBe(
      "/approvals?notice=draft_failed",
    );
  });
  it("the page renders no hidden today input for a non-demo supplier, even with ?today=", async () => {
    const html = await render({ today: "2027-12-31" });
    expect(count(html, "<article")).toBe(2);
    expect(count(html, HIDDEN_TODAY)).toBe(0);
    expect(html).not.toContain("2027-12-31");
  });
  it("the demo supplier still gets the override from the form and on the page", async () => {
    mocks.getSupplier.mockResolvedValue(SUPPLIER);
    const url = await redirectOf(() => approve(form({ draftId: DRAFT_ID, today: "2027-12-31" })));
    expect(url).toBe("/approvals?today=2027-12-31&notice=approved");
    expect(mocks.approveDraft.mock.calls).toEqual([[{ db: DB }, SUPPLIER_ID, DRAFT_ID, "2027-12-31"]]);
    const ladderUrl = await redirectOf(() => checkLadderNow(form({ today: "2027-12-31" })));
    expect(ladderUrl).toBe("/approvals?today=2027-12-31&notice=ladder_checked&n=0");
    expect(mocks.runLadder.mock.calls).toEqual([[{ db: DB, models: MODELS }, SUPPLIER_ID, "2027-12-31"]]);
    const html = await render({ today: "2027-12-31" });
    // One hidden input in the check form and one in each of the two cards' four forms.
    expect(count(html, `${HIDDEN_TODAY} value="2027-12-31"`)).toBe(1 + 2 * 4);
  });
});
