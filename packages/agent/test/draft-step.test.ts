// draftStep: fallback on a 429, both models failing, legal_notice on the legal model with a PDF,
// a failed document render, and no secrets in the Tool_Log. Sharma Traders at Today 2026-11-12,
// Bank_Rate 575 bps as of 2026-10-07. No network: every model is a MockLanguageModelV4.
// Requirements: 3.4, 3.5, 3.6, 10.2, 10.3, 12.7
import {
  DEMO_SUPPLIER,
  agentRuns,
  findSupplierIdByUdyam,
  getSupplier,
  listLadderRecords,
  seed,
} from "@dues-banshee/db";
import type { LadderRecord, Supplier } from "@dues-banshee/db";
import { createTestDb } from "@dues-banshee/db/testing";
import type { TestDb } from "@dues-banshee/db/testing";
import type { BankRate, EscalationDecision } from "@dues-banshee/engine";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { draftStep } from "../src/draft-step";
import type { DraftAttemptInput, DraftAttemptResult } from "../src/draft-step";
import { renderDocument } from "../src/io/documents/render";
import type { ModelSet } from "../src/models";

// Real renderer by default; a test can make it throw once.
vi.mock("../src/io/documents/render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/io/documents/render")>();
  return { ...actual, renderDocument: vi.fn(actual.renderDocument) };
});

const TODAY = "2026-11-12";
const BANK_RATE: BankRate = { annualBps: 575, asOf: "2026-10-07" };
const SHARMA_NUMBER = "LPC/26-27/0412";

const SECRETS = {
  ANTHROPIC_API_KEY: "sk-ant-SENTINEL-anthropic-7f3a91",
  OPENAI_API_KEY: "sk-SENTINEL-openai-c84d02",
  LADDER_RUN_SECRET: "SENTINEL-ladder-run-secret-55be1e",
} as const;

const OUTPUT = {
  text: "Namaste {{buyer_name}} ji, invoice {{invoice_number}} ka {{principal}} {{due_date}} ko due tha.",
  ruleIds: ["MSMED-15"],
};

const NUDGE: Extract<EscalationDecision, { action: "advance" }> = {
  action: "advance",
  applicable: true,
  step: "whatsapp_nudge",
  rank: 1,
  requiresApproval: false,
  ruleIds: ["MSMED-15"],
};
const NOTICE: Extract<EscalationDecision, { action: "advance" }> = {
  action: "advance",
  applicable: true,
  step: "legal_notice",
  rank: 4,
  requiresApproval: true,
  ruleIds: ["MSMED-15"],
};

function okModel(modelId: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId,
    doGenerate: {
      content: [{ type: "text", text: JSON.stringify(OUTPUT) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    },
  });
}

/** Throws an APICallError whose message, request values and response body all carry a secret. */
function failingModel(modelId: string, statusCode: number): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId,
    doGenerate: async () => {
      throw new APICallError({
        message: `Incorrect API key ${SECRETS.ANTHROPIC_API_KEY}`,
        url: "https://example.test/v1/messages",
        requestBodyValues: { apiKey: SECRETS.OPENAI_API_KEY },
        statusCode,
        responseHeaders: { authorization: `Bearer ${SECRETS.LADDER_RUN_SECRET}` },
        responseBody: `{"error":"${SECRETS.ANTHROPIC_API_KEY}"}`,
        isRetryable: false,
      });
    },
  });
}

function models(d: MockLanguageModelV4, l: MockLanguageModelV4, f: MockLanguageModelV4): ModelSet {
  return { default: d, legal: l, fallback: f };
}

let t: TestDb;
let supplier: Supplier;
let record: LadderRecord;

beforeAll(async () => {
  t = await createTestDb();
  await seed(t.db);
  const supplierId = await findSupplierIdByUdyam(t.db, DEMO_SUPPLIER.udyamNumber);
  if (supplierId === null) throw new Error("demo supplier missing after seed");
  supplier = await getSupplier(t.db, supplierId);
  const sharma = (await listLadderRecords(t.db, supplier.id, TODAY)).find((r) => r.invoiceNumber === SHARMA_NUMBER);
  if (sharma === undefined) throw new Error("Sharma invoice missing after seed");
  record = sharma;
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  for (const [name, value] of Object.entries(SECRETS)) vi.stubEnv(name, value);
  await t.db.delete(agentRuns);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function input(decision: DraftAttemptInput["decision"]): DraftAttemptInput {
  return { record, supplier, decision, language: "hinglish", today: TODAY, bankRate: BANK_RATE };
}

async function logRows(): Promise<{ input: Record<string, unknown>; output: Record<string, unknown> }[]> {
  const rows = await t.db.select().from(agentRuns);
  return rows.map((r) => ({
    input: r.input as Record<string, unknown>,
    output: r.output as Record<string, unknown>,
  }));
}

function accepted(result: DraftAttemptResult): Extract<DraftAttemptResult, { kind: "accepted" }> {
  if (result.kind !== "accepted") throw new Error(`expected accepted, got failed (${result.errorKind})`);
  return result;
}

async function expectNoSecretsLogged(): Promise<void> {
  const serialised = JSON.stringify(await t.db.select().from(agentRuns));
  for (const secret of Object.values(SECRETS)) expect(serialised).not.toContain(secret);
}

describe("draftStep model fallback", () => {
  it("makes exactly one fallback call after an Anthropic 429 and stores the fallback model ID", async () => {
    const haiku = failingModel("mock-haiku", 429);
    const sonnet = okModel("mock-sonnet");
    const luna = okModel("mock-luna");

    const result = accepted(await draftStep({ db: t.db, models: models(haiku, sonnet, luna) }, input(NUDGE)));

    expect(result.draft.modelId).toEqual("mock-luna");
    expect(result.draft.step).toEqual("whatsapp_nudge");
    expect(result.draft.ruleIds).toEqual(["MSMED-15"]);
    expect(result.draft.document).toBeNull();
    expect(haiku.doGenerateCalls).toHaveLength(1);
    expect(luna.doGenerateCalls).toHaveLength(1);
    expect(sonnet.doGenerateCalls).toHaveLength(0);

    const rows = await logRows();
    expect(rows).toHaveLength(2);
    const initial = rows.find((r) => r.input["attempt"] === "initial");
    const fallback = rows.find((r) => r.input["attempt"] === "fallback");
    expect(initial?.input["modelId"]).toEqual("mock-haiku");
    expect(initial?.output).toEqual({ errorKind: "rate_limited", citation: null });
    expect(fallback?.input["modelId"]).toEqual("mock-luna");
    expect(fallback?.output["modelOutput"]).toEqual(OUTPUT);
    await expectNoSecretsLogged();
  });

  it("returns failed when the primary and the fallback both fail, with one call each", async () => {
    const haiku = failingModel("mock-haiku", 429);
    const luna = failingModel("mock-luna", 500);

    const result = await draftStep({ db: t.db, models: models(haiku, okModel("mock-sonnet"), luna) }, input(NUDGE));

    expect(result).toEqual({ kind: "failed", errorKind: "api_error" });
    expect(haiku.doGenerateCalls).toHaveLength(1);
    expect(luna.doGenerateCalls).toHaveLength(1);

    const rows = await logRows();
    expect(rows.map((r) => r.output)).toEqual(
      expect.arrayContaining([
        { errorKind: "rate_limited", citation: null },
        { errorKind: "api_error", citation: null },
      ]),
    );
    expect(rows).toHaveLength(2);
    await expectNoSecretsLogged();
  });
});

describe("draftStep legal_notice", () => {
  it("uses the legal model and attaches a PDF document", async () => {
    const haiku = okModel("mock-haiku");
    const sonnet = okModel("mock-sonnet");
    const luna = okModel("mock-luna");

    const result = accepted(await draftStep({ db: t.db, models: models(haiku, sonnet, luna) }, input(NOTICE)));

    expect(result.draft.modelId).toEqual("mock-sonnet");
    expect(result.draft.step).toEqual("legal_notice");
    expect(sonnet.doGenerateCalls).toHaveLength(1);
    expect(haiku.doGenerateCalls).toHaveLength(0);
    expect(luna.doGenerateCalls).toHaveLength(0);

    const document = result.draft.document;
    expect(document).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(document ?? new Uint8Array()).subarray(0, 5).toString("latin1")).toEqual("%PDF-");

    const rows = await logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.input["modelId"]).toEqual("mock-sonnet");
    expect(rows[0]?.input["step"]).toEqual("legal_notice");
    await expectNoSecretsLogged();
  });

  it("returns failed with document_failed when the render throws, and logs only the error kind", async () => {
    vi.mocked(renderDocument).mockRejectedValueOnce(new Error(`render crashed ${SECRETS.LADDER_RUN_SECRET}`));
    const sonnet = okModel("mock-sonnet");

    const result = await draftStep(
      { db: t.db, models: models(okModel("mock-haiku"), sonnet, okModel("mock-luna")) },
      input(NOTICE),
    );

    expect(result).toEqual({ kind: "failed", errorKind: "document_failed" });
    expect(sonnet.doGenerateCalls).toHaveLength(1);

    const rows = await logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.output["errorKind"]).toEqual("document_failed");
    expect(rows[0]?.output["modelOutput"]).toEqual(OUTPUT);
    await expectNoSecretsLogged();
  });
});
