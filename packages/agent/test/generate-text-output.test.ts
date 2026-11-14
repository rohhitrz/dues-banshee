// draftStep through the real callModel and the real AI SDK generateText + Output.object, with a
// mock language model that returns JSON text. No network calls.
// Requirements: 3.1, 12.1, 12.2
import { agentRuns, getSupplier, listLadderRecords, seed, suppliers } from "@dues-banshee/db";
import type { LadderRecord, Supplier } from "@dues-banshee/db";
import { cloneTestDb, createTestDb } from "@dues-banshee/db/testing";
import type { TestDb } from "@dues-banshee/db/testing";
import { formatINR, nextEscalationStep } from "@dues-banshee/engine";
import type { BankRate, EscalationDecision } from "@dues-banshee/engine";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { engineHistory } from "../src/core/history";
import type { ModelOutput } from "../src/core/model-output";
import { DISCLAIMER } from "../src/core/final-text";
import { draftStep } from "../src/draft-step";
import type { DraftAttemptInput } from "../src/draft-step";
import { callModel } from "../src/io/model-router";
import type { ModelSet } from "../src/models";

const TODAY = "2026-11-12";
const BANK_RATE: BankRate = { annualBps: 575, asOf: "2026-10-07" };
const SHARMA_NUMBER = "LPC/26-27/0412";

/** What the mock model returns as JSON text: placeholders only, rule IDs from the allowed list. */
const FIXTURE: ModelOutput = {
  text:
    "Namaste {{buyer_name}} ji, invoice {{invoice_number}} ka {{principal}} {{due_date}} ko due tha. " +
    "Tab se {{interest}} byaaj jud chuka hai ({{rate_as_of}} ki bank rate par). " +
    "Kripya {{pay_link}} se bhugtan kar dein.",
  ruleIds: ["MSMED-15", "MSMED-16"],
};

function jsonModel(modelId: string, json: unknown): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId,
    doGenerate: {
      content: [{ type: "text", text: JSON.stringify(json) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    },
  });
}

function modelSet(
  json: unknown = FIXTURE,
): { models: ModelSet; haiku: MockLanguageModelV4; sonnet: MockLanguageModelV4; luna: MockLanguageModelV4 } {
  const haiku = jsonModel("mock-haiku", json);
  const sonnet = jsonModel("mock-sonnet", json);
  const luna = jsonModel("mock-luna", json);
  return { models: { default: haiku, legal: sonnet, fallback: luna }, haiku, sonnet, luna };
}

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

/** A seeded database and the Sharma Traders input for a whatsapp_nudge draft at 2026-11-12. */
async function sharmaInput(): Promise<{ t: TestDb; input: DraftAttemptInput; record: LadderRecord; supplier: Supplier }> {
  const t = await cloneTestDb(template);
  open.push(t);
  await seed(t.db);
  const [supplierRow] = await t.db.select({ id: suppliers.id }).from(suppliers);
  const supplierId = supplierRow?.id;
  if (supplierId === undefined) throw new Error("demo supplier missing after seed");
  const supplier = await getSupplier(t.db, supplierId);
  const records = await listLadderRecords(t.db, supplierId);
  const record = records.find((r) => r.invoiceNumber === SHARMA_NUMBER);
  if (record === undefined) throw new Error("Sharma invoice missing after seed");
  const decision: EscalationDecision = nextEscalationStep(
    record.invoice,
    engineHistory({ steps: [], promises: [] }),
    TODAY,
  );
  if (decision.action !== "advance") throw new Error("expected an advance decision");
  return {
    t,
    record,
    supplier,
    input: { record, supplier, decision, language: "hinglish", today: TODAY, bankRate: BANK_RATE },
  };
}

describe("draftStep through the real generateText + Output.object", () => {
  it("callModel parses the mock model's JSON text into the Model_Output", async () => {
    const { models, haiku, luna } = modelSet();
    const result = await callModel(models, "default", { system: "SYSTEM", prompt: "PROMPT" });
    expect(result).toEqual({
      ok: true,
      output: FIXTURE,
      modelId: "mock-haiku",
      modelKey: "default",
      usedFallback: false,
    });
    expect(haiku.doGenerateCalls).toHaveLength(1);
    expect(luna.doGenerateCalls).toHaveLength(0);
  });

  it("accepts the Sharma draft with the exact body_text and final_text", async () => {
    const { t, input } = await sharmaInput();
    const { models, haiku, sonnet, luna } = modelSet();

    const result = await draftStep({ db: t.db, models }, input);

    const principal = formatINR(41200000, "full");
    const interest = formatINR(512794, "full");
    const bodyText =
      `Namaste Sharma Traders ji, invoice LPC/26-27/0412 ka ${principal} 17 Oct 2026 ko due tha. ` +
      `Tab se ${interest} byaaj jud chuka hai (7 Oct 2026 ki bank rate par). ` +
      "Kripya [payment link added on send] se bhugtan kar dein.";
    const basis = "Basis: MSMED-15 (MSMED Act 2006, s.15); MSMED-16 (MSMED Act 2006, s.16)";
    expect(result).toEqual({
      kind: "accepted",
      draft: {
        invoiceId: input.record.invoice.id,
        step: "whatsapp_nudge",
        language: "hinglish",
        bodyText,
        finalText: `${bodyText}\n\n${basis}\n${DISCLAIMER}`,
        ruleIds: ["MSMED-15", "MSMED-16"],
        modelId: "mock-haiku",
        decision: input.decision,
        document: null,
      },
    });
    expect(haiku.doGenerateCalls).toHaveLength(1);
    expect(sonnet.doGenerateCalls).toHaveLength(0);
    expect(luna.doGenerateCalls).toHaveLength(0);
  });

  it("asks the model for JSON and logs the Zod-parsed Model_Output in one draft_step row", async () => {
    const { t, input } = await sharmaInput();
    const { models, haiku } = modelSet();

    await draftStep({ db: t.db, models }, input);

    const call = haiku.doGenerateCalls[0];
    expect(call?.responseFormat?.type).toEqual("json");

    const rows = await t.db.select().from(agentRuns);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: "draft_step",
      invoiceId: input.record.invoice.id,
      input: { attempt: "initial", modelId: "mock-haiku", language: "hinglish", step: "whatsapp_nudge", today: TODAY },
      output: { modelOutput: FIXTURE, citation: { ok: true, ruleIds: ["MSMED-15", "MSMED-16"] } },
    });
  });

  it("fails with schema_invalid, no fallback call, when the JSON does not match the schema", async () => {
    const { t, input } = await sharmaInput();
    const { models, haiku, luna } = modelSet({ text: 5, ruleIds: "MSMED-15" });

    const result = await draftStep({ db: t.db, models }, input);

    expect(result).toEqual({ kind: "failed", errorKind: "schema_invalid" });
    expect(haiku.doGenerateCalls).toHaveLength(1);
    expect(luna.doGenerateCalls).toHaveLength(0);
  });
});
