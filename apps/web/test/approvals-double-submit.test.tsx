// @vitest-environment jsdom
import type { Supplier, DraftRow, DraftWithContext } from "@dues-banshee/db";
import { DEMO_SUPPLIER } from "@dues-banshee/db";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  redirect: vi.fn(),
  getDb: vi.fn(),
  getSupplier: vi.fn(),
  listPendingDrafts: vi.fn(),
  approve: vi.fn(),
  saveEdit: vi.fn(),
  reject: vi.fn(),
  redraftIn: vi.fn(),
  checkLadderNow: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));
vi.mock("@dues-banshee/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dues-banshee/db")>()),
  getSupplier: mocks.getSupplier,
  listPendingDrafts: mocks.listPendingDrafts,
}));
// The real actions are server-only; the form only needs a function it can call with the FormData.
vi.mock("@/app/(app)/approvals/actions", () => ({
  approve: mocks.approve,
  saveEdit: mocks.saveEdit,
  reject: mocks.reject,
  redraftIn: mocks.redraftIn,
  checkLadderNow: mocks.checkLadderNow,
}));
import ApprovalsPage from "@/app/(app)/approvals/page";
const SUPPLIER_ID = "00000000-0000-4000-8000-000000000001";
const DRAFT_ID = "00000000-0000-4000-8000-0000000000d1";
const SUPPLIER: Supplier = { id: SUPPLIER_ID, ...DEMO_SUPPLIER };
const ACTIONS = [mocks.checkLadderNow, mocks.saveEdit, mocks.approve, mocks.redraftIn, mocks.reject] as const;
/** The forms in page order: the check form, then the card's edit, approve, redraft and reject forms. */
const FORM_NAMES = ["checkLadderNow", "saveEdit", "approve", "redraftIn", "reject"] as const;
function pendingItem(): DraftWithContext {
  const draft: DraftRow = {
    id: DRAFT_ID,
    invoiceId: "inv-1",
    step: "whatsapp_nudge",
    status: "pending",
    language: "hinglish",
    bodyText: "Sharma ji, a gentle reminder",
    finalText: "Sharma ji, a gentle reminder\n\nNot legal advice.",
    ruleIds: ["MSMED-15"],
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
    createdOn: "2026-11-12",
    decidedAt: null,
    createdAt: new Date(0),
  };
  return { draft, buyerId: "buyer-sharma", buyerName: "Sharma Traders", invoiceNumber: "LPC/26-27/0412" } as unknown as DraftWithContext;
}
interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
let container: HTMLDivElement;
let root: Root;
async function mountPage(): Promise<HTMLFormElement[]> {
  const element = (await ApprovalsPage({ searchParams: Promise.resolve({}) })) as ReactElement;
  await act(async () => {
    root.render(element);
  });
  return Array.from(container.querySelectorAll("form"));
}
async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
function totalCalls(): number {
  return ACTIONS.reduce((sum, action) => sum + action.mock.calls.length, 0);
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.auth.mockReset().mockResolvedValue({ supplierId: SUPPLIER_ID });
  mocks.getDb.mockReset().mockReturnValue({ db: {}, close: vi.fn().mockResolvedValue(undefined) });
  mocks.getSupplier.mockReset().mockResolvedValue(SUPPLIER);
  mocks.listPendingDrafts.mockReset().mockResolvedValue([pendingItem()]);
  for (const action of ACTIONS) action.mockReset();
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});
describe("approvals forms ignore a second submit while one is in flight", () => {
  it("renders the five forms: check the ladder, edit, approve, redraft and reject", async () => {
    expect(await mountPage()).toHaveLength(FORM_NAMES.length);
  });
  for (const [index, name] of FORM_NAMES.entries()) {
    it(`${name}: a double submit calls the action once, and a later submit works again`, async () => {
      const action = ACTIONS[index]!;
      const inFlight = deferred();
      action.mockImplementationOnce(() => inFlight.promise);
      action.mockImplementation(async () => {});
      const forms = await mountPage();
      const target = forms[index]!;
      await submit(target);
      await submit(target);
      expect(action).toHaveBeenCalledTimes(1);
      expect(totalCalls()).toBe(1);
      const sent = action.mock.calls[0]![0] as FormData;
      expect(sent).toBeInstanceOf(FormData);
      if (name !== "checkLadderNow") expect(sent.get("draftId")).toBe(DRAFT_ID);
      await act(async () => {
        inFlight.resolve();
        await inFlight.promise;
      });
      await submit(target);
      expect(action).toHaveBeenCalledTimes(2);
      expect(totalCalls()).toBe(2);
    });
  }
});
