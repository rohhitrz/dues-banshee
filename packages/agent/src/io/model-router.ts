import { APICallError, generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output } from "ai";
import type { LanguageModel } from "ai";
import { MODEL_OUTPUT_SCHEMA } from "../core/model-output";
import type { ModelOutput } from "../core/model-output";
import type { ModelKey, ModelSet } from "../models";

export type CallErrorKind = "api_error" | "rate_limited" | "schema_invalid";

/** `modelKey` is the key of the model that produced this result (the fallback key after a fallback). */
export type CallResult =
  | { ok: true; output: ModelOutput; modelId: string; modelKey: ModelKey; usedFallback: boolean }
  | { ok: false; errorKind: CallErrorKind; modelId: string; modelKey: ModelKey };
/** One real model call, reported to `onCall` as it finishes (so the caller can log each call). */
export interface CallRecord {
  kind: "primary" | "fallback";
  modelKey: ModelKey;
  modelId: string;
  outcome: { ok: true; output: ModelOutput } | { ok: false; errorKind: CallErrorKind };
}
export interface CallOptions {
  /** Default true. When false, a call error ends the call with no second call (used by the Repair_Call). */
  fallback?: boolean;
  onCall?: (call: CallRecord) => void;
}

type Attempt = { ok: true; output: ModelOutput } | { ok: false; errorKind: CallErrorKind };

function modelIdOf(model: LanguageModel): string {
  return typeof model === "string" ? model : model.modelId;
}

/** Classify a thrown error. Only a call error (API or network) may trigger the fallback. */
function classify(error: unknown): CallErrorKind {
  if (NoObjectGeneratedError.isInstance(error) || NoOutputGeneratedError.isInstance(error)) {
    return "schema_invalid";
  }
  if (APICallError.isInstance(error) && error.statusCode === 429) return "rate_limited";
  // APICallError, network failures (fetch TypeError, socket errors) and anything else
  // thrown while calling the provider (e.g. a missing key) are call errors.
  return "api_error";
}

async function attempt(model: LanguageModel, p: { system: string; prompt: string }): Promise<Attempt> {
  try {
    const result = await generateText({
      model,
      system: p.system,
      prompt: p.prompt,
      output: Output.object({ schema: MODEL_OUTPUT_SCHEMA }),
      maxRetries: 0,
    });
    return { ok: true, output: result.output };
  } catch (error) {
    return { ok: false, errorKind: classify(error) };
  }
}

/**
 * One model call with the Model_Output schema. A call error on a Claude model makes exactly
 * one call to `fallback` with the same system, prompt and schema, unless `options.fallback`
 * is false. A schema mismatch never falls back (Req 3.6). Calling with key "fallback" never
 * falls back again. The result carries the key of the model that produced it.
 */
export async function callModel(
  models: ModelSet,
  key: ModelKey,
  p: { system: string; prompt: string },
  options: CallOptions = {},
): Promise<CallResult> {
  const primary = models[key];
  const first = await attempt(primary, p);
  options.onCall?.({ kind: "primary", modelKey: key, modelId: modelIdOf(primary), outcome: first });
  if (first.ok) {
    return { ok: true, output: first.output, modelId: modelIdOf(primary), modelKey: key, usedFallback: false };
  }
  if (first.errorKind === "schema_invalid" || key === "fallback" || options.fallback === false) {
    return { ok: false, errorKind: first.errorKind, modelId: modelIdOf(primary), modelKey: key };
  }
  const second = await attempt(models.fallback, p);
  options.onCall?.({ kind: "fallback", modelKey: "fallback", modelId: modelIdOf(models.fallback), outcome: second });
  if (second.ok) {
    return {
      ok: true,
      output: second.output,
      modelId: modelIdOf(models.fallback),
      modelKey: "fallback",
      usedFallback: true,
    };
  }
  return { ok: false, errorKind: second.errorKind, modelId: modelIdOf(models.fallback), modelKey: "fallback" };
}
