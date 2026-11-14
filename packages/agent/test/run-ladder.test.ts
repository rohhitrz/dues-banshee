// runLadder on the Demo_Seed at Today 2026-11-12 (PGlite, mock models, no network): draft order,
// idempotence, promise pause, overlapping runs, the Draft_Cap, an Engine ValidationError and the
// Tool_Log row counts.
// Requirements: 1.1, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.11, 1.12, 2.1, 2.2, 2.3, 10.1, 12.6, 12.8, 12.9, 12.10
import {
  DEMO_INVOICES,
  DEMO_SUPPLIER,
  agentRuns,
  buyers,
  drafts,
  escalationEvents,
  findSupplierIdByUdyam,
  invoices,
  promises,
  seed,
  suppliers,
} from "@dues-banshee/db";
import { cloneTestDb, createTestDb } from "@dues-banshee/db/testing";
import type { TestDb } from "@dues-banshee/db/testing";
import { formatINR } from "@dues-banshee/engine";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ModelSet } from "../src/models";
import { runLadder } from "../src/run-ladder";
import type { InvoiceOutcome } from "../src/run-ladder";

const TODAY = "2026-11-12";
const PROMISED = "2026-11-20";

const BANSAL = "Bansal Hardware";
const MEHTA = "Mehta Polymers";
const KUMAR = "Kumar Textiles";
const SHARMA = "Sharma Traders";
const GUPTA = "Gupta Engineering Works";
const VERMA = "Verma Auto Parts";
/** Earliest Engine due date first: Bansal 2024-03-31, Mehta 2026-05-04, Kumar 2026-08-16, Sharma 2026-10-17. */
const DRAFT_ORDER = [BANSAL, MEHTA, KUMAR, SHARMA];

const OUTPUT = {
  text: "Namaste {{buyer_name}} ji, invoice {{invoice_number}} ka {{principal}} {{due_date}} ko due tha.",
  ruleIds: ["MSMED-15"],
};

function okModel(modelId: string, beforeReply?: (options: { prompt: unknown }) => Promise<void>): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId,
    doGenerate: async (options) => {
      if (beforeReply !== undefined) await beforeReply(options);
      return {
        content: [{ type: "text", text: JSON.stringify(OUTPUT) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
}

/** Replies with a blank body (and a valid citation) for `blankSubject`, and with OUTPUT for every other invoice. */
function blankFor(modelId: string, blankSubject: string, blank: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId,
    doGenerate: async (options) => {
      const output = JSON.stringify(options.prompt).includes(blankSubject) ? { ...OUTPUT, text: blank } : OUTPUT;
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
}

function modelSet(haiku: MockLanguageModelV4): ModelSet {
  return { default: haiku, legal: okModel("mock-sonnet"), fallback: okModel("mock-luna") };
}

/** Which of `subjects` each call of `model` was about, in call order (the data block holds the name and number). */
function subjectsCalled(model: MockLanguageModelV4, subjects: readonly string[]): string[] {
  return model.doGenerateCalls.map((call) => {
    const text = JSON.stringify(call.prompt);
    const found = subjects.filter((s) => text.includes(s));
    if (found.length !== 1) throw new Error(`expected one subject in the prompt, found ${found.length}`);
    return found[0] as string;
  });
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
  /** Invoice id by buyer name. */
  idOf: (buyerName: string) => string;
}

async function seeded(): Promise<Fixture> {
  const t = await cloneTestDb(template);
  open.push(t);
  const supplierId = await findSupplierIdByUdyam(t.db, DEMO_SUPPLIER.udyamNumber);
  if (supplierId === null) throw new Error("demo supplier missing after seed");
  const rows = await t.db.select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber }).from(invoices);
  const byNumber = new Map(rows.map((r) => [r.invoiceNumber, r.id]));
  const idOf = (buyerName: string): string => {
    const demo = DEMO_INVOICES.find((i) => i.buyerName === buyerName);
    const id = demo === undefined ? undefined : byNumber.get(demo.invoiceNumber);
    if (id === undefined) throw new Error(`no demo invoice for ${buyerName}`);
    return id;
  };
  return { t, supplierId, idOf };
}

async function draftRows(t: TestDb) {
  return (await t.db.select().from(drafts)).sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Events in the order they were written. */
async function eventRows(t: TestDb) {
  const rows = await t.db.select().from(escalationEvents);
  // `created_at` can tie within a millisecond. The table is append-only, so ctid is the write order.
  const order = await t.pglite.query<{ id: string }>("select id from escalation_events order by ctid");
  const rank = new Map(order.rows.map((r, i) => [r.id, i]));
  return rows.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}

async function toolRows(t: TestDb, tool: string) {
  return (await t.db.select().from(agentRuns)).filter((r) => r.tool === tool);
}

describe("runLadder on the Demo_Seed at 2026-11-12", () => {
  it("drafts Bansal, Mehta, Kumar, Sharma in due-date order and leaves Gupta and Verma waiting", async () => {
    const { t, supplierId, idOf } = await seeded();
    const haiku = okModel("mock-haiku");

    const result = await runLadder({ db: t.db, models: modelSet(haiku) }, supplierId, TODAY);

    const rows = await draftRows(t);
    const draftIdOf = (name: string): string => {
      const row = rows.find((r) => r.invoiceId === idOf(name));
      if (row === undefined) throw new Error(`no Draft for ${name}`);
      return row.id;
    };
    expect(result).toEqual({
      supplierId,
      today: TODAY,
      invoices: {
        [idOf(BANSAL)]: { kind: "drafted", draftId: draftIdOf(BANSAL) },
        [idOf(MEHTA)]: { kind: "drafted", draftId: draftIdOf(MEHTA) },
        [idOf(KUMAR)]: { kind: "drafted", draftId: draftIdOf(KUMAR) },
        [idOf(SHARMA)]: { kind: "drafted", draftId: draftIdOf(SHARMA) },
        [idOf(GUPTA)]: { kind: "wait", reason: "not_overdue" },
        [idOf(VERMA)]: { kind: "wait", reason: "paid" },
      },
    });

    // One model call per drafted invoice, in due-date order.
    expect(subjectsCalled(haiku, DRAFT_ORDER)).toEqual(DRAFT_ORDER);

    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.status).toEqual("pending");
      expect(row.step).toEqual("whatsapp_nudge");
      expect(row.language).toEqual("hinglish");
      expect(row.modelId).toEqual("mock-haiku");
      expect(row.createdOn).toEqual(TODAY);
      expect(row.ruleIds).toEqual(["MSMED-15"]);
      expect(row.document).toBeNull();
    }
    const sharma = rows.find((r) => r.invoiceId === idOf(SHARMA));
    expect(sharma?.bodyText).toEqual(
      `Namaste Sharma Traders ji, invoice LPC/26-27/0412 ka ${formatINR(41_200_000, "full")} 17 Oct 2026 ko due tha.`,
    );

    // Four `drafted` events, written in the same order, each pointing at its Draft.
    expect(
      (await eventRows(t)).map((e) => ({
        invoiceId: e.invoiceId,
        step: e.step,
        occurredOn: e.occurredOn,
        action: e.action,
        draftId: e.draftId,
        detail: e.detail,
      })),
    ).toEqual(
      DRAFT_ORDER.map((name) => ({
        invoiceId: idOf(name),
        step: "whatsapp_nudge",
        occurredOn: TODAY,
        action: "drafted",
        draftId: draftIdOf(name),
        detail: null,
      })),
    );
  });

  it("changes no Draft or event on a second run, and makes no model call", async () => {
    const { t, supplierId, idOf } = await seeded();
    const haiku = okModel("mock-haiku");
    const deps = { db: t.db, models: modelSet(haiku) };

    await runLadder(deps, supplierId, TODAY);
    const draftsBefore = await draftRows(t);
    const eventsBefore = await eventRows(t);
    expect(haiku.doGenerateCalls).toHaveLength(4);

    const second = await runLadder(deps, supplierId, TODAY);

    const pending: InvoiceOutcome = { kind: "skip", reason: "pending_draft_exists" };
    expect(second).toEqual({
      supplierId,
      today: TODAY,
      invoices: {
        [idOf(BANSAL)]: pending,
        [idOf(MEHTA)]: pending,
        [idOf(KUMAR)]: pending,
        [idOf(SHARMA)]: pending,
        [idOf(GUPTA)]: { kind: "wait", reason: "not_overdue" },
        [idOf(VERMA)]: { kind: "wait", reason: "paid" },
      },
    });
    expect(await draftRows(t)).toEqual(draftsBefore);
    expect(await eventRows(t)).toEqual(eventsBefore);
    expect(haiku.doGenerateCalls).toHaveLength(4);
  });

  it("writes one Tool_Log row per Engine call and per model call", async () => {
    const { t, supplierId, idOf } = await seeded();
    const haiku = okModel("mock-haiku");
    const deps = { db: t.db, models: modelSet(haiku) };

    await runLadder(deps, supplierId, TODAY);

    const engineRows = await toolRows(t, "next_escalation_step");
    expect(engineRows.map((r) => r.invoiceId).sort()).toEqual(
      [BANSAL, MEHTA, KUMAR, SHARMA, GUPTA, VERMA].map(idOf).sort(),
    );
    const sharmaEngine = engineRows.find((r) => r.invoiceId === idOf(SHARMA));
    expect(sharmaEngine?.output).toEqual({
      action: "advance",
      applicable: true,
      step: "whatsapp_nudge",
      rank: 1,
      requiresApproval: false,
      ruleIds: ["MSMED-15"],
    });
    const guptaEngine = engineRows.find((r) => r.invoiceId === idOf(GUPTA));
    expect(guptaEngine?.output).toEqual({ action: "wait", applicable: true, reason: "not_overdue", ruleIds: [] });

    const modelRows = await toolRows(t, "draft_step");
    expect(modelRows).toHaveLength(haiku.doGenerateCalls.length);
    expect(modelRows.map((r) => r.invoiceId).sort()).toEqual(DRAFT_ORDER.map(idOf).sort());
    expect(modelRows.map((r) => (r.input as { attempt: string }).attempt)).toEqual(["initial", "initial", "initial", "initial"]);

    // A second run adds Engine rows only: every invoice is decided again, no model is called.
    await runLadder(deps, supplierId, TODAY);
    expect(await toolRows(t, "next_escalation_step")).toHaveLength(12);
    expect(await toolRows(t, "draft_step")).toHaveLength(4);
  });

  it("pauses Sharma on promise_active at 2026-11-12 and drafts it at 2026-11-20", async () => {
    const { t, supplierId, idOf } = await seeded();
    await t.db.insert(promises).values({
      invoiceId: idOf(SHARMA),
      promisedDate: PROMISED,
      amountPaise: 41_200_000,
      recordedOn: TODAY,
    });
    const haiku = okModel("mock-haiku");
    const deps = { db: t.db, models: modelSet(haiku) };

    const first = await runLadder(deps, supplierId, TODAY);

    expect(first.invoices[idOf(SHARMA)]).toEqual({ kind: "wait", reason: "promise_active" });
    expect(subjectsCalled(haiku, DRAFT_ORDER)).toEqual([BANSAL, MEHTA, KUMAR]);
    expect((await draftRows(t)).filter((d) => d.invoiceId === idOf(SHARMA))).toEqual([]);
    expect((await eventRows(t)).filter((e) => e.invoiceId === idOf(SHARMA))).toEqual([]);

    const second = await runLadder(deps, supplierId, PROMISED);

    const sharmaDrafts = (await draftRows(t)).filter((d) => d.invoiceId === idOf(SHARMA));
    expect(sharmaDrafts).toHaveLength(1);
    const sharmaDraft = sharmaDrafts[0];
    expect(sharmaDraft?.createdOn).toEqual(PROMISED);
    expect(sharmaDraft?.status).toEqual("pending");
    expect(second.invoices[idOf(SHARMA)]).toEqual({ kind: "drafted", draftId: sharmaDraft?.id });
    expect(
      (await eventRows(t))
        .filter((e) => e.invoiceId === idOf(SHARMA))
        .map((e) => ({ action: e.action, occurredOn: e.occurredOn, step: e.step })),
    ).toEqual([{ action: "drafted", occurredOn: PROMISED, step: "whatsapp_nudge" }]);
  });

  it("records invalid_invoice and a Tool_Log row when the Engine throws a ValidationError", async () => {
    const { t, supplierId, idOf } = await seeded();
    const [buyer] = await t.db.select().from(buyers);
    if (buyer === undefined) throw new Error("no buyer in the seed");
    // paid_on before accepted_on passes the database checks and fails the Engine's validateInvoice.
    const [bad] = await t.db
      .insert(invoices)
      .values({
        supplierId,
        buyerId: buyer.id,
        invoiceNumber: "BAD/26-27/0001",
        invoiceNumberKey: "bad/26-27/0001",
        invoiceDate: "2026-03-01",
        acceptedOn: "2026-03-01",
        agreedTermDays: 30,
        amountPaise: 1_000_000,
        paidOn: "2026-01-01",
        supplierCategory: "micro",
        supplierActivity: "manufacturing",
      })
      .returning({ id: invoices.id });
    if (bad === undefined) throw new Error("invoice not inserted");
    const haiku = okModel("mock-haiku");

    const result = await runLadder({ db: t.db, models: modelSet(haiku) }, supplierId, TODAY);

    expect(result.invoices[bad.id]).toEqual({ kind: "skip", reason: "invalid_invoice" });
    expect(subjectsCalled(haiku, DRAFT_ORDER)).toEqual(DRAFT_ORDER);
    expect(result.invoices[idOf(SHARMA)]?.kind).toEqual("drafted");

    const badRows = (await toolRows(t, "next_escalation_step")).filter((r) => r.invoiceId === bad.id);
    expect(badRows).toHaveLength(1);
    expect(badRows[0]?.output).toEqual({
      error: "validation_error",
      field: "paidOn",
      reason: "must not be before acceptedOn",
    });
    expect((badRows[0]?.input as { today: string }).today).toEqual(TODAY);
    expect(await toolRows(t, "next_escalation_step")).toHaveLength(7);
    expect((await draftRows(t)).some((d) => d.invoiceId === bad.id)).toBe(false);
  });

  it.each([["spaces", "   "], ["a newline", "\n"], ["a tab", "\t"]])(
    "inserts no Draft for a model body of %s and goes on to the next invoice",
    async (_name, blank) => {
      const { t, supplierId, idOf } = await seeded();
      const haiku = blankFor("mock-haiku", BANSAL, blank);

      const result = await runLadder({ db: t.db, models: modelSet(haiku) }, supplierId, TODAY);

      // Bansal is tried twice (initial + one Repair_Call), both blank; the other three are drafted once each.
      expect(subjectsCalled(haiku, DRAFT_ORDER)).toEqual([BANSAL, BANSAL, MEHTA, KUMAR, SHARMA]);
      expect(result.invoices[idOf(BANSAL)]).toEqual({ kind: "skip", reason: "draft_failed" });
      for (const name of [MEHTA, KUMAR, SHARMA]) expect(result.invoices[idOf(name)]?.kind).toEqual("drafted");

      const rows = await draftRows(t);
      expect(rows.map((r) => r.invoiceId).sort()).toEqual([MEHTA, KUMAR, SHARMA].map(idOf).sort());
      expect(rows.some((r) => r.invoiceId === idOf(BANSAL))).toBe(false);
      const events = await eventRows(t);
      expect(events.map((e) => e.invoiceId)).toEqual([MEHTA, KUMAR, SHARMA].map(idOf));
      expect(events.every((e) => e.action === "drafted")).toBe(true);

      const bansalModelRows = (await toolRows(t, "draft_step")).filter((r) => r.invoiceId === idOf(BANSAL));
      expect(bansalModelRows.map((r) => (r.input as { attempt: string }).attempt)).toEqual(["initial", "repair"]);
      for (const row of bansalModelRows) {
        expect(row.output).toEqual({
          modelOutput: { ...OUTPUT, text: blank },
          citation: { ok: false, reason: "empty_body", offending: null },
        });
      }
    },
  );

  it("leaves one pending Sharma Draft and one drafted event when two runs overlap", async () => {
    const { t, supplierId, idOf } = await seeded();
    // Each model call waits until both runs have asked for the same invoice, so both runs read the
    // ladder before either inserts and the conflict is decided by the Pending_Index.
    const arrivals = new Map<string, { count: number; open: () => void; gate: Promise<void> }>();
    const haiku = okModel("mock-haiku", async (options) => {
      const text = JSON.stringify(options.prompt);
      const subject = DRAFT_ORDER.find((s) => text.includes(s));
      if (subject === undefined) throw new Error("unexpected subject");
      let entry = arrivals.get(subject);
      if (entry === undefined) {
        let open: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
          open = resolve;
        });
        entry = { count: 0, open, gate };
        arrivals.set(subject, entry);
      }
      entry.count += 1;
      if (entry.count >= 2) entry.open();
      await entry.gate;
    });
    const deps = { db: t.db, models: modelSet(haiku) };

    const [a, b] = await Promise.all([
      runLadder(deps, supplierId, TODAY),
      runLadder(deps, supplierId, TODAY),
    ]);

    const rows = await draftRows(t);
    const events = await eventRows(t);
    expect(rows).toHaveLength(4);
    expect(events).toHaveLength(4);
    for (const name of DRAFT_ORDER) {
      const draftsOfInvoice = rows.filter((d) => d.invoiceId === idOf(name));
      expect(draftsOfInvoice.map((d) => d.status)).toEqual(["pending"]);
      expect(
        events.filter((e) => e.invoiceId === idOf(name)).map((e) => ({ action: e.action, draftId: e.draftId })),
      ).toEqual([{ action: "drafted", draftId: draftsOfInvoice[0]?.id }]);

      const outcomes = [a.invoices[idOf(name)], b.invoices[idOf(name)]].sort((x, y) =>
        (x?.kind ?? "").localeCompare(y?.kind ?? ""),
      );
      expect(outcomes).toEqual([
        { kind: "drafted", draftId: draftsOfInvoice[0]?.id },
        { kind: "skip", reason: "pending_draft_exists" },
      ]);
    }
    expect(a.invoices[idOf(GUPTA)]).toEqual({ kind: "wait", reason: "not_overdue" });
    expect(b.invoices[idOf(VERMA)]).toEqual({ kind: "wait", reason: "paid" });
  });
});

describe("runLadder Draft_Cap", () => {
  it("drafts 20 of 21 draftable invoices in (dueDate, id) order and caps the last with no model call", async () => {
    const { t } = await seeded();
    const [supplier] = await t.db
      .insert(suppliers)
      .values({
        name: "Cap Works",
        udyamNumber: "UDYAM-GJ-01-7654321",
        supplierCategory: "small",
        supplierActivity: "manufacturing",
        udyamRegisteredOn: "2023-01-10",
      })
      .returning();
    if (supplier === undefined) throw new Error("supplier not inserted");
    const [buyer] = await t.db
      .insert(buyers)
      .values({ supplierId: supplier.id, name: "Cap Buyer", nameKey: "cap buyer" })
      .returning();
    if (buyer === undefined) throw new Error("buyer not inserted");

    // Invoice i is accepted on 2026-06-(1 + floor(i / 2)) with a 30-day term, so invoices 2k and 2k+1
    // fall due on the same day and only the id breaks the tie. The id is 100 - i, so 2k+1 sorts first.
    const numberOf = (i: number): string => `CAP-${String(i).padStart(3, "0")}`;
    const idOfIndex = (i: number): string => `00000000-0000-4000-8000-${String(100 - i).padStart(12, "0")}`;
    const all = Array.from({ length: 21 }, (_, i) => i);
    const day = (i: number): string => `2026-06-${String(1 + Math.floor(i / 2)).padStart(2, "0")}`;
    await t.db.insert(invoices).values(
      [...all].reverse().map((i) => ({
        id: idOfIndex(i),
        supplierId: supplier.id,
        buyerId: buyer.id,
        invoiceNumber: numberOf(i),
        invoiceNumberKey: numberOf(i).toLowerCase(),
        invoiceDate: day(i),
        acceptedOn: day(i),
        agreedTermDays: 30,
        amountPaise: 1_000_000,
        supplierCategory: "small" as const,
        supplierActivity: "manufacturing" as const,
      })),
    );
    const expectedOrder = Array.from({ length: 10 }, (_, k) => [2 * k + 1, 2 * k]).flat();
    const capped = 20;
    const haiku = okModel("mock-haiku");

    const result = await runLadder({ db: t.db, models: modelSet(haiku) }, supplier.id, TODAY);

    expect(subjectsCalled(haiku, all.map(numberOf))).toEqual(expectedOrder.map(numberOf));
    expect(haiku.doGenerateCalls).toHaveLength(20);

    const rows = await draftRows(t);
    expect(rows).toHaveLength(20);
    expect(rows.map((r) => r.invoiceId).sort()).toEqual(expectedOrder.map(idOfIndex).sort());
    const draftIdByInvoice = new Map(rows.map((r) => [r.invoiceId, r.id]));
    const expectedInvoices: Record<string, InvoiceOutcome> = {};
    for (const i of expectedOrder) {
      expectedInvoices[idOfIndex(i)] = { kind: "drafted", draftId: draftIdByInvoice.get(idOfIndex(i)) ?? "missing" };
    }
    expectedInvoices[idOfIndex(capped)] = { kind: "skip", reason: "draft_cap" };
    expect(result).toEqual({ supplierId: supplier.id, today: TODAY, invoices: expectedInvoices });

    // Events: 20 `drafted`, in the same order, none for the capped invoice.
    const events = await eventRows(t);
    expect(events.map((e) => e.invoiceId)).toEqual(expectedOrder.map(idOfIndex));
    expect(events.every((e) => e.action === "drafted")).toBe(true);
    expect(events.some((e) => e.invoiceId === idOfIndex(capped))).toBe(false);
    expect(rows.some((r) => r.invoiceId === idOfIndex(capped))).toBe(false);

    // The capped invoice was still decided by the Engine (21 rows), but no model call was logged for it.
    expect(await toolRows(t, "next_escalation_step")).toHaveLength(21);
    const modelRows = await toolRows(t, "draft_step");
    expect(modelRows).toHaveLength(20);
    expect(modelRows.some((r) => r.invoiceId === idOfIndex(capped))).toBe(false);
  });
});
