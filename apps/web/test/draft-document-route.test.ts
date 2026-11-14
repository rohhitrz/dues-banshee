// GET /api/drafts/[id]/document on a real in-memory Postgres (PGlite) with the Demo_Seed. Only the
// session (`auth`) and the database handle (`getDb`) are replaced; the supplier scoping is the real query.
// Requirements: 7.7, 7.9, 8.5, 12.8
import {
  DEMO_INVOICES,
  DEMO_SUPPLIER,
  buyers,
  findSupplierIdByUdyam,
  insertDraft,
  invoices,
  seed,
  suppliers,
  type NewDraft,
} from "@dues-banshee/db";
import { createTestDb, type TestDb } from "@dues-banshee/db/testing";
import type { EscalationDecision, LadderStep } from "@dues-banshee/engine";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getDb: vi.fn(),
  close: vi.fn(async () => {}),
}));

vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({ getDb: mocks.getDb }));

import { GET } from "@/app/api/drafts/[id]/document/route";

const TODAY = "2026-11-12";
const UNKNOWN_ID = "00000000-0000-4000-8000-0000000000aa";
const STALE_SUPPLIER_ID = "00000000-0000-4000-8000-0000000000ff";

/** A tiny but real PDF: the route only has to hand the stored bytes back unchanged. */
const PDF_BYTES = new TextEncoder().encode(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
    "2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n" +
    "trailer\n<< /Root 1 0 R >>\n%%EOF\n",
);

const DECISION: EscalationDecision = {
  action: "advance",
  applicable: true,
  step: "legal_notice",
  rank: 4,
  requiresApproval: true,
  ruleIds: ["MSMED-15", "MSMED-16"],
};

function newDraft(invoiceId: string, step: LadderStep, document: Uint8Array | null): NewDraft {
  return {
    invoiceId,
    step,
    language: "english",
    bodyText: "Dear {{buyer_name}}, invoice {{invoice_number}} is overdue.",
    finalText: "Dear Sharma Traders, invoice LPC/26-27/0412 is overdue.\n\nBasis: MSMED-15",
    ruleIds: ["MSMED-15"],
    modelId: "mock-sonnet",
    decision: DECISION,
    document,
  };
}

let t: TestDb;
let supplierId: string;
let ownNoticeId: string;
let ownNudgeId: string;
let otherNoticeId: string;

async function draftIdOf(draft: NewDraft): Promise<string> {
  const result = await insertDraft(t.db, draft, TODAY);
  if (result.kind !== "ok") throw new Error("test setup: insertDraft refused the draft");
  return result.draftId;
}

beforeAll(async () => {
  t = await createTestDb();
  await seed(t.db);

  const id = await findSupplierIdByUdyam(t.db, DEMO_SUPPLIER.udyamNumber);
  if (id === null) throw new Error("test setup: demo supplier missing after seed");
  supplierId = id;

  const demoInvoices = await t.db.select().from(invoices);
  const invoiceIdOf = (invoiceNumber: string): string => {
    const row = demoInvoices.find((i) => i.invoiceNumber === invoiceNumber);
    if (row === undefined) throw new Error(`test setup: no invoice ${invoiceNumber}`);
    return row.id;
  };
  const sharma = invoiceIdOf(DEMO_INVOICES[0]!.invoiceNumber);
  const kumar = invoiceIdOf(DEMO_INVOICES.find((i) => i.buyerName === "Kumar Textiles")!.invoiceNumber);

  ownNoticeId = await draftIdOf(newDraft(sharma, "legal_notice", PDF_BYTES));
  ownNudgeId = await draftIdOf(newDraft(kumar, "whatsapp_nudge", null));

  // A second supplier with its own legal_notice Draft that the demo supplier must never reach.
  const [other] = await t.db
    .insert(suppliers)
    .values({
      name: "Other Supplier",
      udyamNumber: "UDYAM-XX-00-0000001",
      supplierCategory: "micro",
      supplierActivity: "manufacturing",
      udyamRegisteredOn: "2024-04-15",
    })
    .returning({ id: suppliers.id });
  const [buyer] = await t.db
    .insert(buyers)
    .values({ supplierId: other!.id, name: "Other Buyer", nameKey: "other buyer" })
    .returning({ id: buyers.id });
  const [invoice] = await t.db
    .insert(invoices)
    .values({
      supplierId: other!.id,
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
  otherNoticeId = await draftIdOf(newDraft(invoice!.id, "legal_notice", PDF_BYTES));
});

afterAll(async () => {
  await t.close();
});

beforeEach(() => {
  mocks.auth.mockReset();
  mocks.close.mockClear();
  mocks.getDb.mockReset();
  mocks.getDb.mockReturnValue({ db: t.db, close: mocks.close });
  mocks.auth.mockResolvedValue({ supplierId });
});

function call(draftId: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/drafts/${draftId}/document`), {
    params: Promise.resolve({ id: draftId }),
  });
}

describe("GET /api/drafts/[id]/document", () => {
  it("returns the PDF of the supplier's own legal_notice Draft as an attachment", async () => {
    const res = await call(ownNoticeId);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="legal_notice-${ownNoticeId}.pdf"`);

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("%PDF");
    expect(bytes).toEqual(PDF_BYTES);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("returns 404 for another supplier's Draft, exactly like an unknown id", async () => {
    const other = await call(otherNoticeId);
    const unknown = await call(UNKNOWN_ID);

    expect(other.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await other.json()).toEqual({ error: "Not found" });
    expect(await unknown.json()).toEqual({ error: "Not found" });
  });

  it("returns 404 for an id that is not a UUID, without touching the database", async () => {
    const res = await call("not-a-uuid");
    expect(res.status).toBe(404);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("returns 404 for a Draft that has no document (whatsapp_nudge)", async () => {
    const res = await call(ownNudgeId);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("redirects a stale session (supplier no longer exists) with 303 to /signin?error=SessionExpired", async () => {
    mocks.auth.mockResolvedValue({ supplierId: STALE_SUPPLIER_ID });

    const res = await call(ownNoticeId);

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("http://localhost/signin?error=SessionExpired");
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("returns 401 with no session, before touching the database", async () => {
    mocks.auth.mockResolvedValue(null);

    const res = await call(ownNoticeId);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("returns 401 for a session without a supplierId", async () => {
    mocks.auth.mockResolvedValue({});
    const res = await call(ownNoticeId);
    expect(res.status).toBe(401);
  });
});
