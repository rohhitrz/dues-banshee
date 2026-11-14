// Owner decisions on Drafts (approve, edit, reject, redraft) for Sharma Traders at Today 2026-11-12,
// on the Demo_Seed (PGlite, mock models, no network). Every test asserts the exact Escalation_Events.
// Requirements: 3.8, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 7.7, 8.7, 12.8
import {
  DEMO_SUPPLIER,
  agentRuns,
  drafts,
  escalationEvents,
  findSupplierIdByUdyam,
  getSupplier,
  insertDraft,
  listLadderRecords,
  promises,
  seed,
  suppliers,
} from "@dues-banshee/db";
import { cloneTestDb, createTestDb } from "@dues-banshee/db/testing";
import type { TestDb } from "@dues-banshee/db/testing";
import { formatINR } from "@dues-banshee/engine";
import type { BankRate, EscalationDecision } from "@dues-banshee/engine";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { extractText, getDocumentProxy } from "unpdf";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { approveDraft, editDraft, redraft, rejectDraft } from "../src/decide";
import { draftStep } from "../src/draft-step";
import type { ModelSet } from "../src/models";
import { runLadder } from "../src/run-ladder";

const TODAY = "2026-11-12";
const BANK_RATE: BankRate = { annualBps: 575, asOf: "2026-10-07" };
const SHARMA = "Sharma Traders";
const UNKNOWN_ID = "00000000-0000-4000-8000-0000000000ff";

const BASIS_LINE = "Basis: MSMED-15 (MSMED Act 2006, s.15)";
const DISCLAIMER_LINE = "Reminders a supplier sends to its own buyers. Not legal advice.";

const ORIGINAL_OUTPUT = {
  text: "Namaste {{buyer_name}} ji, invoice {{invoice_number}} ka {{principal}} {{due_date}} ko due tha.",
  ruleIds: ["MSMED-15"],
};
const ORIGINAL_BODY = `Namaste Sharma Traders ji, invoice LPC/26-27/0412 ka ${formatINR(41_200_000, "full")} 17 Oct 2026 ko due tha.`;

const REDRAFT_OUTPUT = {
  text: "Hello {{buyer_name}} ji, {{principal}} for invoice {{invoice_number}} was due on {{due_date}}.",
  ruleIds: ["MSMED-15"],
};
const REDRAFT_BODY = `Hello Sharma Traders ji, ${formatINR(41_200_000, "full")} for invoice LPC/26-27/0412 was due on 17 Oct 2026.`;

const NUDGE_DECISION: EscalationDecision = {
  action: "advance",
  applicable: true,
  step: "whatsapp_nudge",
  rank: 1,
  requiresApproval: false,
  ruleIds: ["MSMED-15"],
};
const NOTICE_DECISION: Extract<EscalationDecision, { action: "advance" }> = {
  action: "advance",
  applicable: true,
  step: "legal_notice",
  rank: 4,
  requiresApproval: true,
  ruleIds: ["MSMED-15"],
};

function modelReturning(modelId: string, output: { text: string; ruleIds: string[] }): MockLanguageModelV4 {
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

function failingModel(modelId: string, statusCode: number): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId,
    doGenerate: async () => {
      throw new APICallError({
        message: "provider error",
        url: "https://example.test/v1/messages",
        requestBodyValues: {},
        statusCode,
        isRetryable: false,
      });
    },
  });
}

function modelSet(output = ORIGINAL_OUTPUT): ModelSet & { default: MockLanguageModelV4 } {
  return {
    default: modelReturning("mock-haiku", output),
    legal: modelReturning("mock-sonnet", output),
    fallback: modelReturning("mock-luna", output),
  };
}

let template: TestDb;
const open: TestDb[] = [];

beforeAll(async () => {
  template = await createTestDb();
  await seed(template.db);
});

afterAll(async () => {
  await template.close();
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((t) => t.close()));
});

interface Fixture {
  t: TestDb;
  supplierId: string;
  sharmaInvoiceId: string;
}

async function seeded(): Promise<Fixture> {
  const t = await cloneTestDb(template);
  open.push(t);
  const supplierId = await findSupplierIdByUdyam(t.db, DEMO_SUPPLIER.udyamNumber);
  if (supplierId === null) throw new Error("demo supplier missing after seed");
  const sharma = (await listLadderRecords(t.db, supplierId)).find((r) => r.buyerName === SHARMA);
  if (sharma === undefined) throw new Error("Sharma invoice missing after seed");
  return { t, supplierId, sharmaInvoiceId: sharma.invoice.id };
}

/** The seed plus the four Drafts of a Ladder_Run at Today; returns the Sharma Draft id. */
async function withNudgeDraft(): Promise<Fixture & { draftId: string }> {
  const f = await seeded();
  const result = await runLadder({ db: f.t.db, models: modelSet() }, f.supplierId, TODAY);
  const outcome = result.invoices[f.sharmaInvoiceId];
  if (outcome === undefined || outcome.kind !== "drafted") throw new Error("expected a Sharma Draft");
  return { ...f, draftId: outcome.draftId };
}

async function draftRows(t: TestDb) {
  return (await t.db.select().from(drafts)).sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Every event, in write order (the table is append-only, so ctid is the write order). */
async function allEvents(t: TestDb) {
  const rows = await t.db.select().from(escalationEvents);
  const order = await t.pglite.query<{ id: string }>("select id from escalation_events order by ctid");
  const rank = new Map(order.rows.map((r, i) => [r.id, i]));
  return rows.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}

async function sharmaEvents(f: Fixture) {
  return (await allEvents(f.t))
    .filter((e) => e.invoiceId === f.sharmaInvoiceId)
    .map((e) => ({
      step: e.step,
      occurredOn: e.occurredOn,
      action: e.action,
      draftId: e.draftId,
      detail: e.detail,
    }));
}

async function draftById(t: TestDb, id: string) {
  const row = (await t.db.select().from(drafts)).find((d) => d.id === id);
  if (row === undefined) throw new Error(`no Draft ${id}`);
  return row;
}

async function snapshot(t: TestDb) {
  return { drafts: await draftRows(t), events: await allEvents(t) };
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  return norm(text);
}

describe("approveDraft", () => {
  it("approves a pending Draft: status approved, decided_at set, one approved event dated Today", async () => {
    const f = await withNudgeDraft();
    const others = (await draftRows(f.t)).filter((d) => d.id !== f.draftId);

    const result = await approveDraft({ db: f.t.db }, f.supplierId, f.draftId, TODAY);

    expect(result).toEqual({ kind: "ok" });
    const row = await draftById(f.t, f.draftId);
    expect(row.status).toEqual("approved");
    expect(row.decidedAt).toBeInstanceOf(Date);
    expect(row.bodyText).toEqual(ORIGINAL_BODY);
    expect(await sharmaEvents(f)).toEqual([
      { step: "whatsapp_nudge", occurredOn: TODAY, action: "drafted", draftId: f.draftId, detail: null },
      { step: "whatsapp_nudge", occurredOn: TODAY, action: "approved", draftId: f.draftId, detail: null },
    ]);
    // The other three Drafts and their events are untouched.
    expect((await draftRows(f.t)).filter((d) => d.id !== f.draftId)).toEqual(others);
    expect((await allEvents(f.t)).filter((e) => e.action !== "drafted")).toHaveLength(1);

    // The approved step now counts in the ladder history.
    const record = (await listLadderRecords(f.t.db, f.supplierId, f.sharmaInvoiceId))[0];
    expect(record?.steps.filter((s) => s.action === "approved")).toEqual([
      { step: "whatsapp_nudge", occurredOn: TODAY, action: "approved" },
    ]);
    expect(record?.pendingDraftId).toBeNull();
  });

  it("logs the recomputed Decision with the Engine input and the default config", async () => {
    const f = await withNudgeDraft();
    await f.t.db.delete(agentRuns);

    expect(await approveDraft({ db: f.t.db }, f.supplierId, f.draftId, TODAY)).toEqual({ kind: "ok" });

    const rows = (await f.t.db.select().from(agentRuns)).filter((r) => r.tool === "next_escalation_step");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.invoiceId).toEqual(f.sharmaInvoiceId);
    expect(rows[0]?.input).toEqual({
      invoice: {
        id: f.sharmaInvoiceId,
        amountPaise: 41_200_000,
        acceptedOn: "2026-09-02",
        agreedTermDays: 45,
        supplierCategory: "micro",
        supplierActivity: "manufacturing",
        udyamRegisteredOn: DEMO_SUPPLIER.udyamRegisteredOn,
      },
      history: [],
      today: TODAY,
      config: { stepGapDays: 7 },
    });
    expect(rows[0]?.output).toEqual(NUDGE_DECISION);
  });

  it("expires the Draft when a promise was recorded since: expired event, no approved event", async () => {
    const f = await withNudgeDraft();
    await f.t.db.insert(promises).values({
      invoiceId: f.sharmaInvoiceId,
      promisedDate: "2026-11-20",
      amountPaise: 41_200_000,
      recordedOn: TODAY,
    });

    const result = await approveDraft({ db: f.t.db }, f.supplierId, f.draftId, TODAY);

    expect(result).toEqual({
      kind: "expired",
      decision: { action: "wait", applicable: true, reason: "promise_active", ruleIds: [] },
    });
    const row = await draftById(f.t, f.draftId);
    expect(row.status).toEqual("expired");
    expect(row.decidedAt).toBeInstanceOf(Date);
    expect(await sharmaEvents(f)).toEqual([
      { step: "whatsapp_nudge", occurredOn: TODAY, action: "drafted", draftId: f.draftId, detail: null },
      { step: "whatsapp_nudge", occurredOn: TODAY, action: "expired", draftId: f.draftId, detail: null },
    ]);
    expect((await allEvents(f.t)).some((e) => e.action === "approved")).toBe(false);
  });
});

describe("a pending Draft whose invoice the Engine now rejects", () => {
  const VALIDATION_ROW = {
    error: "ValidationError",
    field: "paidOn",
    message: "paidOn: must not be before acceptedOn",
  };
  /** paid_on before accepted_on passes the database checks and fails the Engine's validateInvoice. */
  async function breakInvoice(f: Fixture): Promise<void> {
    await f.t.pglite.query("update invoices set paid_on = '2026-01-01' where id = $1", [f.sharmaInvoiceId]);
  }
  async function errorRows(f: Fixture) {
    return (await f.t.db.select().from(agentRuns)).filter((r) => r.tool === "next_escalation_step");
  }
  it("approveDraft logs the ValidationError row and answers not_found, leaving the Draft pending", async () => {
    const f = await withNudgeDraft();
    await breakInvoice(f);
    await f.t.db.delete(agentRuns);
    const before = await snapshot(f.t);
    await expect(approveDraft({ db: f.t.db }, f.supplierId, f.draftId, TODAY)).resolves.toEqual({
      kind: "not_found",
    });
    const rows = await errorRows(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.invoiceId).toEqual(f.sharmaInvoiceId);
    expect(rows[0]?.output).toEqual(VALIDATION_ROW);
    expect(rows[0]?.input).toMatchObject({ today: TODAY, history: [], config: { stepGapDays: 7 } });
    expect(await snapshot(f.t)).toEqual(before);
    expect((await draftById(f.t, f.draftId)).status).toEqual("pending");
  });
  it("redraft logs the ValidationError row and answers not_found without calling a model", async () => {
    const f = await withNudgeDraft();
    await breakInvoice(f);
    await f.t.db.delete(agentRuns);
    const before = await snapshot(f.t);
    const models = modelSet(REDRAFT_OUTPUT);
    await expect(redraft({ db: f.t.db, models }, f.supplierId, f.draftId, "english", TODAY)).resolves.toEqual({
      kind: "not_found",
    });
    const rows = await errorRows(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.invoiceId).toEqual(f.sharmaInvoiceId);
    expect(rows[0]?.output).toEqual(VALIDATION_ROW);
    expect(models.default.doGenerateCalls).toHaveLength(0);
    expect(await snapshot(f.t)).toEqual(before);
  });
});
describe("editDraft", () => {
  it("rebuilds the Final_Text with the same Basis_Line and the Disclaimer last, and keeps the Draft pending", async () => {
    const f = await withNudgeDraft();
    const before = await draftById(f.t, f.draftId);
    expect(before.finalText).toEqual(`${ORIGINAL_BODY}\n\n${BASIS_LINE}\n${DISCLAIMER_LINE}`);
    const newBody = "Sharma ji, kripya is hafte bhugtan ki tareekh bata dein.";

    const result = await editDraft({ db: f.t.db }, f.supplierId, f.draftId, newBody, TODAY);

    expect(result).toEqual({ kind: "ok" });
    const row = await draftById(f.t, f.draftId);
    expect(row.status).toEqual("pending");
    expect(row.decidedAt).toBeNull();
    expect(row.bodyText).toEqual(newBody);
    expect(row.finalText).toEqual(`${newBody}\n\n${BASIS_LINE}\n${DISCLAIMER_LINE}`);
    expect(row.finalText.split("\n").at(-1)).toEqual(DISCLAIMER_LINE);
    expect(row.ruleIds).toEqual(["MSMED-15"]);
    expect(row.document).toBeNull();
    expect(await sharmaEvents(f)).toEqual([
      { step: "whatsapp_nudge", occurredOn: TODAY, action: "drafted", draftId: f.draftId, detail: null },
      {
        step: "whatsapp_nudge",
        occurredOn: TODAY,
        action: "edited",
        draftId: f.draftId,
        detail: { before: ORIGINAL_BODY, after: newBody },
      },
    ]);
  });

  it("dates the edited event Today, not the day the Draft was created", async () => {
    const f = await withNudgeDraft();
    const later = "2026-11-14";
    const newBody = "Sharma ji, kripya is hafte bhugtan ki tareekh bata dein.";

    const result = await editDraft({ db: f.t.db }, f.supplierId, f.draftId, newBody, later);

    expect(result).toEqual({ kind: "ok" });
    expect(await sharmaEvents(f)).toEqual([
      { step: "whatsapp_nudge", occurredOn: TODAY, action: "drafted", draftId: f.draftId, detail: null },
      {
        step: "whatsapp_nudge",
        occurredOn: later,
        action: "edited",
        draftId: f.draftId,
        detail: { before: ORIGINAL_BODY, after: newBody },
      },
    ]);
  });

  it("refuses an empty body with empty_body, changes nothing and writes no event", async () => {
    const f = await withNudgeDraft();
    const before = await snapshot(f.t);

    const result = await editDraft({ db: f.t.db }, f.supplierId, f.draftId, "  \n\t ", TODAY);

    expect(result).toEqual({ kind: "empty_body" });
    expect(await snapshot(f.t)).toEqual(before);
    expect(await sharmaEvents(f)).toEqual([
      { step: "whatsapp_nudge", occurredOn: TODAY, action: "drafted", draftId: f.draftId, detail: null },
    ]);
  });

  it("rebuilds the document of a legal_notice Draft from the edited Final_Text", async () => {
    const f = await seeded();
    const record = (await listLadderRecords(f.t.db, f.supplierId, f.sharmaInvoiceId))[0];
    if (record === undefined) throw new Error("Sharma record missing");
    const supplier = await getSupplier(f.t.db, f.supplierId);
    const attempt = await draftStep(
      { db: f.t.db, models: modelSet() },
      { record, supplier, decision: NOTICE_DECISION, language: "english", today: TODAY, bankRate: BANK_RATE },
    );
    if (attempt.kind !== "accepted") throw new Error("expected an accepted legal_notice Draft");
    const inserted = await insertDraft(f.t.db, attempt.draft, TODAY);
    if (inserted.kind !== "ok") throw new Error("expected the Draft to be inserted");
    const draftId = inserted.draftId;

    const original = await draftById(f.t, draftId);
    expect(original.step).toEqual("legal_notice");
    expect(original.modelId).toEqual("mock-sonnet");
    if (original.document === null) throw new Error("expected a document on the legal_notice Draft");
    const originalText = await pdfText(original.document);
    expect(originalText).toContain("ko due tha.");
    expect(originalText).not.toContain("Please settle this invoice by Friday.");

    const newBody = "Please settle this invoice by Friday.";
    const result = await editDraft({ db: f.t.db }, f.supplierId, draftId, newBody, TODAY);

    expect(result).toEqual({ kind: "ok" });
    const row = await draftById(f.t, draftId);
    expect(row.status).toEqual("pending");
    expect(row.finalText).toEqual(`${newBody}\n\n${BASIS_LINE}\n${DISCLAIMER_LINE}`);
    if (row.document === null) throw new Error("expected the rebuilt document");
    const text = await pdfText(row.document);
    expect(text).toContain(newBody);
    expect(text).toContain(BASIS_LINE);
    expect(text).toContain(DISCLAIMER_LINE);
    expect(text).toContain("DRAFT \u2013 for the owner's review");
    expect(text).not.toContain("ko due tha.");
    expect(await sharmaEvents(f)).toEqual([
      { step: "legal_notice", occurredOn: TODAY, action: "drafted", draftId, detail: null },
      {
        step: "legal_notice",
        occurredOn: TODAY,
        action: "edited",
        draftId,
        detail: { before: ORIGINAL_BODY, after: newBody },
      },
    ]);
  });
});

describe("rejectDraft", () => {
  it("rejects with a reason: status rejected, decided_at set, one rejected event holding the trimmed reason", async () => {
    const f = await withNudgeDraft();

    const result = await rejectDraft({ db: f.t.db }, f.supplierId, f.draftId, "  Buyer called, will pay on Friday  ", TODAY);

    expect(result).toEqual({ kind: "ok" });
    const row = await draftById(f.t, f.draftId);
    expect(row.status).toEqual("rejected");
    expect(row.decidedAt).toBeInstanceOf(Date);
    expect(await sharmaEvents(f)).toEqual([
      { step: "whatsapp_nudge", occurredOn: TODAY, action: "drafted", draftId: f.draftId, detail: null },
      {
        step: "whatsapp_nudge",
        occurredOn: TODAY,
        action: "rejected",
        draftId: f.draftId,
        detail: { reason: "Buyer called, will pay on Friday" },
      },
    ]);
    expect((await allEvents(f.t)).some((e) => e.action === "approved")).toBe(false);
  });

  it("stores a null reason when none (or only whitespace) is given", async () => {
    const f = await withNudgeDraft();

    const result = await rejectDraft({ db: f.t.db }, f.supplierId, f.draftId, "   ", TODAY);

    expect(result).toEqual({ kind: "ok" });
    expect((await sharmaEvents(f)).at(-1)).toEqual({
      step: "whatsapp_nudge",
      occurredOn: TODAY,
      action: "rejected",
      draftId: f.draftId,
      detail: { reason: null },
    });
  });
});

describe("a Draft that is not pending", () => {
  it("answers already_decided to every decision and changes nothing", async () => {
    const f = await withNudgeDraft();
    expect(await approveDraft({ db: f.t.db }, f.supplierId, f.draftId, TODAY)).toEqual({ kind: "ok" });
    const before = await snapshot(f.t);

    expect(await approveDraft({ db: f.t.db }, f.supplierId, f.draftId, TODAY)).toEqual({ kind: "already_decided" });
    expect(await editDraft({ db: f.t.db }, f.supplierId, f.draftId, "New text", TODAY)).toEqual({ kind: "already_decided" });
    expect(await rejectDraft({ db: f.t.db }, f.supplierId, f.draftId, "late", TODAY)).toEqual({ kind: "already_decided" });
    const models = modelSet(REDRAFT_OUTPUT);
    expect(await redraft({ db: f.t.db, models }, f.supplierId, f.draftId, "english", TODAY)).toEqual({
      kind: "already_decided",
    });
    expect(models.default.doGenerateCalls).toHaveLength(0);

    expect(await snapshot(f.t)).toEqual(before);
    expect(await sharmaEvents(f)).toEqual([
      { step: "whatsapp_nudge", occurredOn: TODAY, action: "drafted", draftId: f.draftId, detail: null },
      { step: "whatsapp_nudge", occurredOn: TODAY, action: "approved", draftId: f.draftId, detail: null },
    ]);
  });
});

describe("redraft", () => {
  it("expires the old Draft and inserts a new pending one in the new language, with the events in order", async () => {
    const f = await withNudgeDraft();
    const models = modelSet(REDRAFT_OUTPUT);

    const result = await redraft({ db: f.t.db, models }, f.supplierId, f.draftId, "english", TODAY);

    expect(result).toEqual({ kind: "ok" });
    expect(models.default.doGenerateCalls).toHaveLength(1);

    const sharmaDrafts = (await draftRows(f.t)).filter((d) => d.invoiceId === f.sharmaInvoiceId);
    expect(sharmaDrafts).toHaveLength(2);
    const old = sharmaDrafts.find((d) => d.id === f.draftId);
    const fresh = sharmaDrafts.find((d) => d.id !== f.draftId);
    if (old === undefined || fresh === undefined) throw new Error("expected an old and a new Draft");
    expect(old.status).toEqual("expired");
    expect(old.decidedAt).toBeInstanceOf(Date);
    expect(old.bodyText).toEqual(ORIGINAL_BODY);
    expect(fresh.status).toEqual("pending");
    expect(fresh.decidedAt).toBeNull();
    expect(fresh.language).toEqual("english");
    expect(fresh.step).toEqual("whatsapp_nudge");
    expect(fresh.modelId).toEqual("mock-haiku");
    expect(fresh.createdOn).toEqual(TODAY);
    expect(fresh.ruleIds).toEqual(["MSMED-15"]);
    expect(fresh.decision).toEqual(NUDGE_DECISION);
    expect(fresh.bodyText).toEqual(REDRAFT_BODY);
    expect(fresh.finalText).toEqual(`${REDRAFT_BODY}\n\n${BASIS_LINE}\n${DISCLAIMER_LINE}`);

    // The Pending_Index holds: exactly one pending Draft for the invoice, and it is the new one.
    expect(sharmaDrafts.filter((d) => d.status === "pending").map((d) => d.id)).toEqual([fresh.id]);
    const record = (await listLadderRecords(f.t.db, f.supplierId, f.sharmaInvoiceId))[0];
    expect(record?.pendingDraftId).toEqual(fresh.id);

    expect(await sharmaEvents(f)).toEqual([
      { step: "whatsapp_nudge", occurredOn: TODAY, action: "drafted", draftId: f.draftId, detail: null },
      { step: "whatsapp_nudge", occurredOn: TODAY, action: "expired", draftId: f.draftId, detail: null },
      { step: "whatsapp_nudge", occurredOn: TODAY, action: "drafted", draftId: fresh.id, detail: null },
    ]);
  });

  it("returns draft_failed when both models fail: the old Draft stays pending and no event is written", async () => {
    const f = await withNudgeDraft();
    const before = await snapshot(f.t);
    const models: ModelSet = {
      default: failingModel("mock-haiku", 429),
      legal: modelReturning("mock-sonnet", REDRAFT_OUTPUT),
      fallback: failingModel("mock-luna", 500),
    };

    const result = await redraft({ db: f.t.db, models }, f.supplierId, f.draftId, "english", TODAY);

    expect(result).toEqual({ kind: "draft_failed" });
    expect(await snapshot(f.t)).toEqual(before);
    expect((await draftById(f.t, f.draftId)).status).toEqual("pending");
    expect(await sharmaEvents(f)).toEqual([
      { step: "whatsapp_nudge", occurredOn: TODAY, action: "drafted", draftId: f.draftId, detail: null },
    ]);
  });
  it.each([["spaces", "   "], ["a newline", "\n"], ["a tab", "\t"]])(
    "returns draft_failed for a model body of %s: the old Draft stays pending and no event is written",
    async (_name, blank) => {
      const f = await withNudgeDraft();
      const before = await snapshot(f.t);
      const models = modelSet({ text: blank, ruleIds: ["MSMED-15"] });

      const result = await redraft({ db: f.t.db, models }, f.supplierId, f.draftId, "english", TODAY);

      expect(result).toEqual({ kind: "draft_failed" });
      // The blank output is blocked, then the one Repair_Call returns a blank body again.
      expect(models.default.doGenerateCalls).toHaveLength(2);
      expect(await snapshot(f.t)).toEqual(before);
      expect((await draftById(f.t, f.draftId)).status).toEqual("pending");
      expect(await sharmaEvents(f)).toEqual([
        { step: "whatsapp_nudge", occurredOn: TODAY, action: "drafted", draftId: f.draftId, detail: null },
      ]);
    },
  );
});

describe("overlapping decisions", () => {
  it("applies one status change and writes events for that change only when approve and reject overlap", async () => {
    const f = await withNudgeDraft();

    const [approved, rejected] = await Promise.all([
      approveDraft({ db: f.t.db }, f.supplierId, f.draftId, TODAY),
      rejectDraft({ db: f.t.db }, f.supplierId, f.draftId, "too soon", TODAY),
    ]);

    expect([approved.kind, rejected.kind].sort()).toEqual(["already_decided", "ok"]);
    const row = await draftById(f.t, f.draftId);
    const drafted = { step: "whatsapp_nudge", occurredOn: TODAY, action: "drafted", draftId: f.draftId, detail: null };
    if (approved.kind === "ok") {
      expect(row.status).toEqual("approved");
      expect(await sharmaEvents(f)).toEqual([
        drafted,
        { step: "whatsapp_nudge", occurredOn: TODAY, action: "approved", draftId: f.draftId, detail: null },
      ]);
    } else {
      expect(row.status).toEqual("rejected");
      expect(await sharmaEvents(f)).toEqual([
        drafted,
        {
          step: "whatsapp_nudge",
          occurredOn: TODAY,
          action: "rejected",
          draftId: f.draftId,
          detail: { reason: "too soon" },
        },
      ]);
    }
  });
});

describe("another supplier's Draft id", () => {
  it("answers not_found to every decision, changes nothing and writes no event", async () => {
    const f = await withNudgeDraft();
    const [other] = await f.t.db
      .insert(suppliers)
      .values({
        name: "Other Works",
        udyamNumber: "UDYAM-GJ-01-7654321",
        supplierCategory: "small",
        supplierActivity: "manufacturing",
        udyamRegisteredOn: "2023-01-10",
      })
      .returning();
    if (other === undefined) throw new Error("supplier not inserted");
    const before = await snapshot(f.t);
    const models = modelSet(REDRAFT_OUTPUT);

    expect(await approveDraft({ db: f.t.db }, other.id, f.draftId, TODAY)).toEqual({ kind: "not_found" });
    expect(await editDraft({ db: f.t.db }, other.id, f.draftId, "New text", TODAY)).toEqual({ kind: "not_found" });
    expect(await rejectDraft({ db: f.t.db }, other.id, f.draftId, "no", TODAY)).toEqual({ kind: "not_found" });
    expect(await redraft({ db: f.t.db, models }, other.id, f.draftId, "english", TODAY)).toEqual({
      kind: "not_found",
    });
    // A Draft id that does not exist is answered the same way.
    expect(await approveDraft({ db: f.t.db }, f.supplierId, UNKNOWN_ID, TODAY)).toEqual({ kind: "not_found" });
    expect(await rejectDraft({ db: f.t.db }, f.supplierId, UNKNOWN_ID, null, TODAY)).toEqual({ kind: "not_found" });

    expect(models.default.doGenerateCalls).toHaveLength(0);
    expect(await snapshot(f.t)).toEqual(before);
    expect(await sharmaEvents(f)).toEqual([
      { step: "whatsapp_nudge", occurredOn: TODAY, action: "drafted", draftId: f.draftId, detail: null },
    ]);
  });
});
