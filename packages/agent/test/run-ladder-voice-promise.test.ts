// A voice promise pauses the ladder through the Engine history until its date (Demo_Seed, PGlite,
// mock models, no network). Requirements: 9.1, 9.2, 11.5
import {
  DEMO_INVOICES,
  DEMO_SUPPLIER,
  agentRuns,
  claimJoin,
  createVoiceCall,
  drafts,
  findSupplierIdByUdyam,
  invoices,
  listLadderRecords,
  recordVoicePromise,
  seed,
} from "@dues-banshee/db";
import { cloneTestDb, createTestDb } from "@dues-banshee/db/testing";
import type { TestDb } from "@dues-banshee/db/testing";
import { DEFAULT_LADDER_CONFIG, nextEscalationStep } from "@dues-banshee/engine";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { engineHistory } from "../src/core/history";
import type { ModelSet } from "../src/models";
import { runLadder } from "../src/run-ladder";

const RECORDED = "2026-11-12";
const PROMISED = "2026-11-20";
const SHARMA_BUYER = "Sharma Traders";
const HASH = "c".repeat(64);
const NOW = new Date("2026-11-12T05:00:00.000Z");

const OUTPUT = {
  text: "Namaste {{buyer_name}} ji, invoice {{invoice_number}} ka {{principal}} {{due_date}} ko due tha.",
  ruleIds: ["MSMED-15"],
};

function okModel(modelId: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId,
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(OUTPUT) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  });
}

function modelSet(): ModelSet {
  return { default: okModel("mock-haiku"), legal: okModel("mock-sonnet"), fallback: okModel("mock-luna") };
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

/** The Demo_Seed with a voice promise for Sharma Traders recorded 2026-11-12, promised for 2026-11-20. */
async function withVoicePromise() {
  const t = await cloneTestDb(template);
  open.push(t);
  const supplierId = await findSupplierIdByUdyam(t.db, DEMO_SUPPLIER.udyamNumber);
  if (supplierId === null) throw new Error("demo supplier missing after seed");
  const demo = DEMO_INVOICES.find((i) => i.buyerName === SHARMA_BUYER);
  const rows = await t.db.select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber }).from(invoices);
  const invoiceId = rows.find((r) => r.invoiceNumber === demo?.invoiceNumber)?.id;
  if (invoiceId === undefined) throw new Error("Sharma invoice missing");

  const created = await createVoiceCall(t.db, { supplierId, invoiceId, callToday: RECORDED, tokenHash: HASH, now: NOW });
  if (created === null) throw new Error("voice call not created");
  await claimJoin(t.db, HASH, NOW);
  await t.db.transaction((tx) =>
    recordVoicePromise(tx, {
      voiceCallId: created.voiceCallId,
      invoiceId,
      callToday: RECORDED,
      promisedDate: PROMISED,
      amountPaise: 41_200_000,
      spokenText: "haan, agle Friday tak",
      isPartial: false,
      now: NOW,
    }),
  );
  return { t, supplierId, invoiceId };
}

async function sharmaDecisionLogs(t: TestDb, invoiceId: string) {
  return (await t.db.select().from(agentRuns)).filter((r) => r.tool === "next_escalation_step" && r.invoiceId === invoiceId);
}

describe("runLadder with a voice promise for Sharma Traders", () => {
  it("records promise_active and creates no Draft at 2026-11-12", async () => {
    const { t, supplierId, invoiceId } = await withVoicePromise();

    const result = await runLadder({ db: t.db, models: modelSet() }, supplierId, RECORDED);

    expect(result.invoices[invoiceId]).toEqual({ kind: "wait", reason: "promise_active" });
    expect((await t.db.select().from(drafts)).filter((d) => d.invoiceId === invoiceId)).toEqual([]);
    const logs = await sharmaDecisionLogs(t, invoiceId);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.output).toMatchObject({ action: "wait", reason: "promise_active" });
  });

  it("records the Engine's own Decision, not promise_active, at 2026-11-20", async () => {
    const { t, supplierId, invoiceId } = await withVoicePromise();
    await runLadder({ db: t.db, models: modelSet() }, supplierId, RECORDED);

    const result = await runLadder({ db: t.db, models: modelSet() }, supplierId, PROMISED);

    // The oracle is the Engine itself, fed the same invoice and the promise as stored.
    const [record] = await listLadderRecords(t.db, supplierId, PROMISED, invoiceId);
    if (record === undefined) throw new Error("record missing");
    expect(record.promises).toEqual([{ promisedDate: PROMISED, amountPaise: 41_200_000, recordedOn: RECORDED }]);
    const expected = nextEscalationStep(record.invoice, engineHistory(record), PROMISED, DEFAULT_LADDER_CONFIG);
    expect(expected).toMatchObject({ action: "advance", step: "whatsapp_nudge" });

    const logs = await sharmaDecisionLogs(t, invoiceId);
    expect(logs).toHaveLength(2);
    const onPromisedDay = logs.filter((l) => (l.input as { today: string }).today === PROMISED);
    expect(onPromisedDay).toHaveLength(1);
    expect(onPromisedDay[0]?.output).toEqual(expected);
    expect(onPromisedDay[0]?.output).not.toMatchObject({ reason: "promise_active" });

    const sharmaDrafts = (await t.db.select().from(drafts)).filter((d) => d.invoiceId === invoiceId);
    expect(sharmaDrafts).toHaveLength(1);
    expect(sharmaDrafts[0]?.createdOn).toEqual(PROMISED);
    expect(result.invoices[invoiceId]).toEqual({ kind: "drafted", draftId: sharmaDrafts[0]?.id });
  });
});
