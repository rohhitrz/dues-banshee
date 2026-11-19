import type { EscalationDecision } from "@dues-banshee/engine";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getDraftForSupplier,
  insertDraft,
  listLadderRecords,
  listPendingDrafts,
  listRunSuppliers,
  setDraftStatus,
  updatePendingBody,
  type NewDraft,
} from "../src/ladder";
import { agentRuns, buyers, drafts, escalationEvents, invoices, suppliers } from "../src/schema";
import { DEMO_SUPPLIER, seed } from "../src/seed";
import { cloneTestDb, createTestDb, type TestDb } from "../src/testing";
import { logToolCall } from "../src/tool-log";

const SHARMA = "LPC/26-27/0412";
const TODAY = "2026-11-12";

const DECISION: EscalationDecision = {
  action: "advance",
  applicable: true,
  step: "whatsapp_nudge",
  rank: 1,
  requiresApproval: false,
  ruleIds: ["MSMED-15"],
};

let template: TestDb;
const open: TestDb[] = [];

beforeAll(async () => {
  template = await createTestDb();
});

afterAll(async () => {
  await template.close();
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((t) => t.close()));
});

async function freshDb(): Promise<TestDb> {
  const t = await cloneTestDb(template);
  open.push(t);
  return t;
}

/** A fresh database with the demo seed, the demo supplier's id and the invoice id of each demo invoice number. */
async function seeded(): Promise<{ t: TestDb; supplierId: string; invoiceIds: Map<string, string> }> {
  const t = await freshDb();
  await seed(t.db);
  const [supplier] = await t.db.select({ id: suppliers.id }).from(suppliers);
  if (supplier === undefined) throw new Error("demo supplier missing after seed");
  const rows = await t.db
    .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber })
    .from(invoices)
    .where(eq(invoices.supplierId, supplier.id));
  return { t, supplierId: supplier.id, invoiceIds: new Map(rows.map((r) => [r.invoiceNumber, r.id])) };
}

function invoiceIdOf(ids: Map<string, string>, invoiceNumber: string): string {
  const id = ids.get(invoiceNumber);
  if (id === undefined) throw new Error(`no invoice ${invoiceNumber}`);
  return id;
}

function newDraft(invoiceId: string, over: Partial<NewDraft> = {}): NewDraft {
  return {
    invoiceId,
    step: "whatsapp_nudge",
    language: "hinglish",
    bodyText: "Sharma ji, a gentle reminder.",
    finalText: "Sharma ji, a gentle reminder.\n\nBasis: MSMED-15 (MSMED Act 2006, s.15)\nDisclaimer",
    ruleIds: ["MSMED-15"],
    modelId: "mock-haiku",
    decision: DECISION,
    document: null,
    ...over,
  };
}

/** A second supplier with one buyer, one invoice, one pending Draft and one `drafted` event. */
async function insertOtherSupplier(t: TestDb) {
  const [supplier] = await t.db
    .insert(suppliers)
    .values({
      name: "Other Works",
      udyamNumber: "UDYAM-GJ-01-7654321",
      supplierCategory: "small",
      supplierActivity: "services",
      udyamRegisteredOn: "2023-01-10",
    })
    .returning();
  if (supplier === undefined) throw new Error("supplier not inserted");
  const [buyer] = await t.db
    .insert(buyers)
    .values({ supplierId: supplier.id, name: "Sharma Traders", nameKey: "sharma traders" })
    .returning();
  if (buyer === undefined) throw new Error("buyer not inserted");
  const [invoice] = await t.db
    .insert(invoices)
    .values({
      supplierId: supplier.id,
      buyerId: buyer.id,
      invoiceNumber: "OTH/26-27/0001",
      invoiceNumberKey: "oth/26-27/0001",
      invoiceDate: "2026-08-01",
      acceptedOn: "2026-08-01",
      agreedTermDays: 30,
      amountPaise: 7_700_000,
      supplierCategory: "small",
      supplierActivity: "services",
    })
    .returning();
  if (invoice === undefined) throw new Error("invoice not inserted");
  const result = await insertDraft(t.db, newDraft(invoice.id, { bodyText: "Other supplier body" }), "2026-10-01");
  if (result.kind !== "ok") throw new Error("other supplier draft not inserted");
  return { supplier, invoice, draftId: result.draftId };
}

describe("listLadderRecords", () => {
  it("returns the six demo records with display fields and an empty ladder state", async () => {
    const { t, supplierId } = await seeded();

    const records = await listLadderRecords(t.db, supplierId, TODAY);

    const view = records
      .map((r) => ({
        buyerName: r.buyerName,
        invoiceNumber: r.invoiceNumber,
        invoiceDate: r.invoiceDate,
        acceptanceDateDefaulted: r.acceptanceDateDefaulted,
        steps: r.steps,
        promises: r.promises,
        pendingDraftId: r.pendingDraftId,
      }))
      .sort((a, b) => (a.invoiceNumber < b.invoiceNumber ? -1 : 1));
    expect(view).toEqual([
      ["Bansal Hardware", "LPC/23-24/0098", "2024-03-01"],
      ["Mehta Polymers", "LPC/25-26/0388", "2026-03-20"],
      ["Kumar Textiles", "LPC/26-27/0301", "2026-07-02"],
      ["Verma Auto Parts", "LPC/26-27/0377", "2026-08-10"],
      ["Sharma Traders", "LPC/26-27/0412", "2026-09-02"],
      ["Gupta Engineering Works", "LPC/26-27/0466", "2026-11-01"],
    ].map(([buyerName, invoiceNumber, invoiceDate]) => ({
      buyerName,
      invoiceNumber,
      invoiceDate,
      acceptanceDateDefaulted: false,
      steps: [],
      promises: [],
      pendingDraftId: null,
    })));
    expect(new Set(records.map((r) => r.invoice.id)).size).toBe(6);
  });

  it("reads one invoice when invoiceId is given, and [] for an unknown supplier", async () => {
    const { t, supplierId, invoiceIds } = await seeded();
    const sharmaId = invoiceIdOf(invoiceIds, SHARMA);

    const one = await listLadderRecords(t.db, supplierId, TODAY, sharmaId);

    expect(one.map((r) => [r.invoiceNumber, r.invoice.id, r.invoice.amountPaise])).toEqual([[SHARMA, sharmaId, 41_200_000]]);
    expect(await listLadderRecords(t.db, "00000000-0000-4000-8000-000000000000", TODAY)).toEqual([]);
  });

  it("returns steps (all actions), promises and the pending Draft id of the invoice", async () => {
    const { t, supplierId, invoiceIds } = await seeded();
    const sharmaId = invoiceIdOf(invoiceIds, SHARMA);
    await t.db.insert(escalationEvents).values([
      { invoiceId: sharmaId, step: "whatsapp_paylink", occurredOn: "2026-11-02", action: "approved" },
      { invoiceId: sharmaId, step: "whatsapp_nudge", occurredOn: "2026-10-20", action: "approved" },
      { invoiceId: sharmaId, step: "voice_call", occurredOn: "2026-11-05", action: "drafted" },
    ]);
    const inserted = await insertDraft(t.db, newDraft(sharmaId), TODAY);
    if (inserted.kind !== "ok") throw new Error("draft not inserted");

    const [record] = await listLadderRecords(t.db, supplierId, TODAY, sharmaId);

    expect(record?.steps).toEqual([
      { step: "whatsapp_nudge", occurredOn: "2026-10-20", action: "approved", draftId: null },
      { step: "whatsapp_paylink", occurredOn: "2026-11-02", action: "approved", draftId: null },
      { step: "voice_call", occurredOn: "2026-11-05", action: "drafted", draftId: null },
      { step: "whatsapp_nudge", occurredOn: TODAY, action: "drafted", draftId: inserted.draftId },
    ]);
    expect(record?.pendingDraftId).toBe(inserted.draftId);
  });
});

describe("supplier scoping", () => {
  it("never returns a second supplier's Drafts, events or invoices from any read, and vice versa", async () => {
    const { t, supplierId, invoiceIds } = await seeded();
    const other = await insertOtherSupplier(t);
    const sharmaId = invoiceIdOf(invoiceIds, SHARMA);
    const demoInserted = await insertDraft(t.db, newDraft(sharmaId), TODAY);
    if (demoInserted.kind !== "ok") throw new Error("draft not inserted");

    // Demo supplier's view.
    const demoRecords = await listLadderRecords(t.db, supplierId, TODAY);
    expect(demoRecords).toHaveLength(6);
    expect(demoRecords.map((r) => r.invoiceNumber)).not.toContain("OTH/26-27/0001");
    expect(demoRecords.flatMap((r) => r.steps)).toEqual([
      { step: "whatsapp_nudge", occurredOn: TODAY, action: "drafted", draftId: demoInserted.draftId },
    ]);
    expect(demoRecords.map((r) => r.pendingDraftId).filter((id) => id !== null)).toEqual([demoInserted.draftId]);
    expect(await listLadderRecords(t.db, supplierId, TODAY, other.invoice.id)).toEqual([]);
    expect((await listPendingDrafts(t.db, supplierId)).map((d) => d.draft.id)).toEqual([demoInserted.draftId]);
    expect(await getDraftForSupplier(t.db, supplierId, other.draftId)).toBeNull();

    // Second supplier's view.
    const otherRecords = await listLadderRecords(t.db, other.supplier.id, TODAY);
    expect(otherRecords.map((r) => [r.invoiceNumber, r.buyerName, r.pendingDraftId])).toEqual([
      ["OTH/26-27/0001", "Sharma Traders", other.draftId],
    ]);
    expect(otherRecords[0]?.steps).toEqual([{ step: "whatsapp_nudge", occurredOn: "2026-10-01", action: "drafted", draftId: other.draftId }]);
    expect(await listLadderRecords(t.db, other.supplier.id, TODAY, sharmaId)).toEqual([]);
    expect((await listPendingDrafts(t.db, other.supplier.id)).map((d) => d.draft.id)).toEqual([other.draftId]);
    expect(await getDraftForSupplier(t.db, other.supplier.id, demoInserted.draftId)).toBeNull();

    // Each supplier reads its own Draft with its buyer and invoice number.
    const own = await getDraftForSupplier(t.db, supplierId, demoInserted.draftId);
    expect([own?.buyerName, own?.invoiceNumber, own?.draft.bodyText]).toEqual([
      "Sharma Traders",
      SHARMA,
      "Sharma ji, a gentle reminder.",
    ]);
  });
});

describe("insertDraft", () => {
  it("writes one pending Draft and one drafted event", async () => {
    const { t, invoiceIds } = await seeded();
    const sharmaId = invoiceIdOf(invoiceIds, SHARMA);

    const result = await insertDraft(t.db, newDraft(sharmaId, { document: new Uint8Array([1, 2, 3]) }), TODAY);

    if (result.kind !== "ok") throw new Error("expected ok");
    const draftRows = await t.db.select().from(drafts).where(eq(drafts.invoiceId, sharmaId));
    expect(draftRows).toHaveLength(1);
    expect(draftRows[0]).toMatchObject({
      id: result.draftId,
      step: "whatsapp_nudge",
      status: "pending",
      language: "hinglish",
      bodyText: "Sharma ji, a gentle reminder.",
      ruleIds: ["MSMED-15"],
      modelId: "mock-haiku",
      decision: DECISION,
      createdOn: TODAY,
      decidedAt: null,
    });
    expect(Array.from(draftRows[0]?.document ?? [])).toEqual([1, 2, 3]);
    const events = await t.db
      .select({
        step: escalationEvents.step,
        occurredOn: escalationEvents.occurredOn,
        action: escalationEvents.action,
        draftId: escalationEvents.draftId,
        detail: escalationEvents.detail,
      })
      .from(escalationEvents)
      .where(eq(escalationEvents.invoiceId, sharmaId));
    expect(events).toEqual([
      { step: "whatsapp_nudge", occurredOn: TODAY, action: "drafted", draftId: result.draftId, detail: null },
    ]);
  });

  it("returns pending_exists for a second Draft on the same invoice and writes no event", async () => {
    const { t, invoiceIds } = await seeded();
    const sharmaId = invoiceIdOf(invoiceIds, SHARMA);
    const first = await insertDraft(t.db, newDraft(sharmaId), TODAY);
    if (first.kind !== "ok") throw new Error("expected ok");

    const second = await insertDraft(t.db, newDraft(sharmaId, { language: "english", bodyText: "Second body" }), "2026-11-13");

    expect(second).toEqual({ kind: "pending_exists" });
    const draftRows = await t.db.select({ id: drafts.id, bodyText: drafts.bodyText }).from(drafts);
    expect(draftRows).toEqual([{ id: first.draftId, bodyText: "Sharma ji, a gentle reminder." }]);
    const events = await t.db
      .select({ occurredOn: escalationEvents.occurredOn, action: escalationEvents.action })
      .from(escalationEvents);
    expect(events).toEqual([{ occurredOn: TODAY, action: "drafted" }]);
  });
});

describe("setDraftStatus", () => {
  it("moves a pending Draft once, then returns false", async () => {
    const { t, supplierId, invoiceIds } = await seeded();
    const inserted = await insertDraft(t.db, newDraft(invoiceIdOf(invoiceIds, SHARMA)), TODAY);
    if (inserted.kind !== "ok") throw new Error("expected ok");

    expect(await setDraftStatus(t.db, supplierId, inserted.draftId, "approved")).toBe(true);
    expect(await setDraftStatus(t.db, supplierId, inserted.draftId, "rejected")).toBe(false);

    const [row] = await t.db.select({ status: drafts.status, decidedAt: drafts.decidedAt }).from(drafts);
    expect(row?.status).toBe("approved");
    expect(row?.decidedAt).toBeInstanceOf(Date);
  });

  it("returns false for another supplier's Draft and leaves it pending", async () => {
    const { t, supplierId } = await seeded();
    const other = await insertOtherSupplier(t);

    expect(await setDraftStatus(t.db, supplierId, other.draftId, "approved")).toBe(false);
    expect(await setDraftStatus(t.db, supplierId, "00000000-0000-4000-8000-000000000000", "approved")).toBe(false);

    const [row] = await t.db.select({ status: drafts.status, decidedAt: drafts.decidedAt }).from(drafts);
    expect(row).toEqual({ status: "pending", decidedAt: null });
  });
});

describe("updatePendingBody", () => {
  it("returns the previous body and stores the new text and document", async () => {
    const { t, supplierId, invoiceIds } = await seeded();
    const inserted = await insertDraft(t.db, newDraft(invoiceIdOf(invoiceIds, SHARMA)), TODAY);
    if (inserted.kind !== "ok") throw new Error("expected ok");

    const result = await updatePendingBody(t.db, supplierId, inserted.draftId, "Edited body", "Edited final", new Uint8Array([9]));

    expect(result).toEqual({ before: "Sharma ji, a gentle reminder." });
    const [row] = await t.db.select().from(drafts);
    expect([row?.bodyText, row?.finalText, row?.status]).toEqual(["Edited body", "Edited final", "pending"]);
    expect(Array.from(row?.document ?? [])).toEqual([9]);
  });

  it("returns null for a non-pending Draft, another supplier's Draft and an unknown id, changing nothing", async () => {
    const { t, supplierId, invoiceIds } = await seeded();
    const inserted = await insertDraft(t.db, newDraft(invoiceIdOf(invoiceIds, SHARMA)), TODAY);
    if (inserted.kind !== "ok") throw new Error("expected ok");
    const other = await insertOtherSupplier(t);
    await setDraftStatus(t.db, supplierId, inserted.draftId, "approved");

    expect(await updatePendingBody(t.db, supplierId, inserted.draftId, "x", "y", null)).toBeNull();
    expect(await updatePendingBody(t.db, supplierId, other.draftId, "x", "y", null)).toBeNull();
    expect(await updatePendingBody(t.db, supplierId, "00000000-0000-4000-8000-000000000000", "x", "y", null)).toBeNull();

    const rows = await t.db.select({ id: drafts.id, bodyText: drafts.bodyText }).from(drafts);
    expect(rows.map((r) => r.bodyText).sort()).toEqual(["Other supplier body", "Sharma ji, a gentle reminder."]);
  });
});

describe("listPendingDrafts", () => {
  it("orders by created_at ascending, then id, and skips non-pending Drafts", async () => {
    const { t, supplierId, invoiceIds } = await seeded();
    const base: Omit<typeof drafts.$inferInsert, "invoiceId"> = {
      step: "whatsapp_nudge",
      language: "hinglish",
      bodyText: "body",
      finalText: "final",
      ruleIds: ["MSMED-15"],
      modelId: "mock-haiku",
      decision: DECISION,
      createdOn: TODAY,
    };
    const late = new Date("2026-11-02T00:00:00Z");
    const early = new Date("2026-11-01T00:00:00Z");
    // Two Drafts tie on created_at, so their ids decide; the latest one has the smallest id.
    await t.db.insert(drafts).values([
      { ...base, id: "00000000-0000-4000-8000-000000000001", invoiceId: invoiceIdOf(invoiceIds, "LPC/23-24/0098"), createdAt: late },
      { ...base, id: "00000000-0000-4000-8000-000000000009", invoiceId: invoiceIdOf(invoiceIds, "LPC/25-26/0388"), createdAt: early },
      { ...base, id: "00000000-0000-4000-8000-000000000005", invoiceId: invoiceIdOf(invoiceIds, "LPC/26-27/0301"), createdAt: early },
      {
        ...base,
        id: "00000000-0000-4000-8000-000000000000",
        invoiceId: invoiceIdOf(invoiceIds, SHARMA),
        createdAt: new Date("2026-10-01T00:00:00Z"),
        status: "approved",
      },
    ]);

    const pending = await listPendingDrafts(t.db, supplierId);

    expect(pending.map((d) => [d.draft.id, d.buyerName, d.invoiceNumber, d.invoiceDate])).toEqual([
      ["00000000-0000-4000-8000-000000000005", "Kumar Textiles", "LPC/26-27/0301", "2026-07-02"],
      ["00000000-0000-4000-8000-000000000009", "Mehta Polymers", "LPC/25-26/0388", "2026-03-20"],
      ["00000000-0000-4000-8000-000000000001", "Bansal Hardware", "LPC/23-24/0098", "2024-03-01"],
    ]);
  });
});

describe("listRunSuppliers", () => {
  it("returns the demo supplier's id and udyamNumber", async () => {
    const { t, supplierId } = await seeded();

    expect(await listRunSuppliers(t.db)).toEqual([{ id: supplierId, udyamNumber: DEMO_SUPPLIER.udyamNumber }]);
  });

  it("lists every supplier, so a daily run covers them all", async () => {
    const { t, supplierId } = await seeded();
    const other = await insertOtherSupplier(t);

    const list = await listRunSuppliers(t.db);

    expect(list).toHaveLength(2);
    expect(list).toEqual(
      expect.arrayContaining([
        { id: supplierId, udyamNumber: DEMO_SUPPLIER.udyamNumber },
        { id: other.supplier.id, udyamNumber: "UDYAM-GJ-01-7654321" },
      ]),
    );
  });
});

describe("logToolCall", () => {
  it("writes one agent_runs row with the tool, invoice, input and output", async () => {
    const { t, invoiceIds } = await seeded();
    const sharmaId = invoiceIdOf(invoiceIds, SHARMA);

    await logToolCall(t.db, {
      tool: "draft_step",
      invoiceId: sharmaId,
      input: { step: "whatsapp_nudge", attempt: "initial" },
      output: { ok: true, ruleIds: ["MSMED-15"] },
    });

    const rows = await t.db
      .select({ tool: agentRuns.tool, invoiceId: agentRuns.invoiceId, input: agentRuns.input, output: agentRuns.output })
      .from(agentRuns);
    expect(rows).toEqual([
      {
        tool: "draft_step",
        invoiceId: sharmaId,
        input: { step: "whatsapp_nudge", attempt: "initial" },
        output: { ok: true, ruleIds: ["MSMED-15"] },
      },
    ]);
  });

  it("stores a null invoice id and a null output when the output is undefined", async () => {
    const t = await freshDb();

    await logToolCall(t.db, { tool: "next_escalation_step", invoiceId: null, input: { a: 1 }, output: undefined });

    const rows = await t.db
      .select({ tool: agentRuns.tool, invoiceId: agentRuns.invoiceId, input: agentRuns.input, output: agentRuns.output })
      .from(agentRuns);
    expect(rows).toEqual([{ tool: "next_escalation_step", invoiceId: null, input: { a: 1 }, output: null }]);
  });
});
