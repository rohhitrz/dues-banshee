import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { callModel } from "../src/io/model-router";
import { MODEL_IDS, primaryFor } from "../src/models";
import type { ModelSet } from "../src/models";

const FIXTURE = { text: "Namaste {{buyer_name}} ji, a reminder.", ruleIds: ["MSMED-15"] };
const PARAMS = { system: "SYSTEM", prompt: "PROMPT" };

function okModel(modelId: string, json: unknown = FIXTURE): MockLanguageModelV4 {
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

function failingModel(modelId: string, statusCode: number): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId,
    doGenerate: async () => {
      throw new APICallError({
        message: "boom",
        url: "https://example.test",
        requestBodyValues: {},
        statusCode,
        isRetryable: false,
      });
    },
  });
}

function set(d: MockLanguageModelV4, l: MockLanguageModelV4, f: MockLanguageModelV4): ModelSet {
  return { default: d, legal: l, fallback: f };
}

describe("primaryFor", () => {
  it("uses the legal model only for legal_notice and odr_pack", () => {
    expect(primaryFor("whatsapp_nudge")).toBe("default");
    expect(primaryFor("voice_call")).toBe("default");
    expect(primaryFor("whatsapp_paylink")).toBe("default");
    expect(primaryFor("legal_notice")).toBe("legal");
    expect(primaryFor("odr_pack")).toBe("legal");
  });
});

describe("MODEL_IDS", () => {
  it("names the three provider models", () => {
    expect(MODEL_IDS).toEqual({
      default: "claude-haiku-5-5",
      legal: "claude-sonnet-5-5",
      fallback: "gpt-5.6-luna",
    });
  });
});

describe("callModel", () => {
  it("returns the primary output without calling the fallback", async () => {
    const fallback = okModel("mock-luna");
    const result = await callModel(set(okModel("mock-haiku"), okModel("mock-sonnet"), fallback), "default", PARAMS);
    expect(result).toEqual({ ok: true, output: FIXTURE, modelId: "mock-haiku", modelKey: "default", usedFallback: false });
    expect(fallback.doGenerateCalls).toHaveLength(0);
  });

  it("calls the fallback exactly once when the primary throws a 429", async () => {
    const primary = failingModel("mock-haiku", 429);
    const fallback = okModel("mock-luna");
    const result = await callModel(set(primary, okModel("mock-sonnet"), fallback), "default", PARAMS);
    expect(result).toEqual({ ok: true, output: FIXTURE, modelId: "mock-luna", modelKey: "fallback", usedFallback: true });
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(fallback.doGenerateCalls).toHaveLength(1);
  });

  it("falls back from the legal model on a network error", async () => {
    const legal = new MockLanguageModelV4({
      modelId: "mock-sonnet",
      doGenerate: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const fallback = okModel("mock-luna");
    const result = await callModel(set(okModel("mock-haiku"), legal, fallback), "legal", PARAMS);
    expect(result).toEqual({ ok: true, output: FIXTURE, modelId: "mock-luna", modelKey: "fallback", usedFallback: true });
    expect(fallback.doGenerateCalls).toHaveLength(1);
  });

  it("returns ok:false when the primary and the fallback both fail", async () => {
    const fallback = failingModel("mock-luna", 500);
    const result = await callModel(set(failingModel("mock-haiku", 429), okModel("mock-sonnet"), fallback), "default", PARAMS);
    expect(result).toEqual({ ok: false, errorKind: "api_error", modelId: "mock-luna", modelKey: "fallback" });
    expect(fallback.doGenerateCalls).toHaveLength(1);
  });

  it("returns schema_invalid with no fallback call when the primary output mismatches the schema", async () => {
    const fallback = okModel("mock-luna");
    const bad = okModel("mock-haiku", { text: 5, ruleIds: "MSMED-15" });
    const result = await callModel(set(bad, okModel("mock-sonnet"), fallback), "default", PARAMS);
    expect(result).toEqual({ ok: false, errorKind: "schema_invalid", modelId: "mock-haiku", modelKey: "default" });
    expect(fallback.doGenerateCalls).toHaveLength(0);
  });

  it("does not fall back again when the key is already fallback", async () => {
    const fallback = failingModel("mock-luna", 429);
    const result = await callModel(set(okModel("mock-haiku"), okModel("mock-sonnet"), fallback), "fallback", PARAMS);
    expect(result).toEqual({ ok: false, errorKind: "rate_limited", modelId: "mock-luna", modelKey: "fallback" });
    expect(fallback.doGenerateCalls).toHaveLength(1);
  });

  it("sends the same system and prompt to the fallback", async () => {
    const fallback = okModel("mock-luna");
    await callModel(set(failingModel("mock-haiku", 503), okModel("mock-sonnet"), fallback), "default", PARAMS);
    expect(JSON.stringify(fallback.doGenerateCalls[0]?.prompt)).toContain("SYSTEM");
    expect(JSON.stringify(fallback.doGenerateCalls[0]?.prompt)).toContain("PROMPT");
  });
  it("makes no fallback call and reports each call when fallback is disabled", async () => {
    const fallback = okModel("mock-luna");
    const calls: string[] = [];
    const result = await callModel(
      set(failingModel("mock-haiku", 429), okModel("mock-sonnet"), fallback),
      "default",
      PARAMS,
      { fallback: false, onCall: (c) => calls.push(`${c.kind}:${c.modelKey}:${c.modelId}`) },
    );
    expect(result).toEqual({ ok: false, errorKind: "rate_limited", modelId: "mock-haiku", modelKey: "default" });
    expect(fallback.doGenerateCalls).toHaveLength(0);
    expect(calls).toEqual(["primary:default:mock-haiku"]);
  });
});
