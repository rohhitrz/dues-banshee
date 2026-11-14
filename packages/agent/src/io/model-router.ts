import { APICallError, generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output } from "ai";
import type { LanguageModel } from "ai";
import { MODEL_OUTPUT_SCHEMA } from "../core/model-output";
import type { ModelOutput } from "../core/model-output";
import type { ModelKey, ModelSet } from "../models";

export type CallErrorKind = "api_error" | "rate_limited" | "schema_invalid";

export type CallResult =
  | { ok: true; output: ModelOutput; modelId: string; usedFallback: boolean }
  | { ok: false; errorKind: CallErrorKind; modelId: string };

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
 * one call to `fallback` with the same system, prompt and schema. A schema mismatch never
 * falls back (Req 3.6). Calling with key "fallback" never falls back again.
 */
export async function callModel(
  models: ModelSet,
  key: ModelKey,
  p: { system: string; prompt: string },
): Promise<CallResult> {
  const primary = models[key];
  const first = await attempt(primary, p);
  if (first.ok) {
    return { ok: true, output: first.output, modelId: modelIdOf(primary), usedFallback: false };
  }
  if (first.errorKind === "schema_invalid" || key === "fallback") {
    return { ok: false, errorKind: first.errorKind, modelId: modelIdOf(primary) };
  }

  const second = await attempt(models.fallback, p);
  if (second.ok) {
    return { ok: true, output: second.output, modelId: modelIdOf(models.fallback), usedFallback: true };
  }
  return { ok: false, errorKind: second.errorKind, modelId: modelIdOf(models.fallback) };
}
