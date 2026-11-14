import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import type { LadderStep } from "@dues-banshee/engine";
import type { LanguageModel } from "ai";

/**
 * The only place a provider model ID string may appear (tech.md). Each ID is in the
 * installed @ai-sdk/anthropic / @ai-sdk/openai model-ID unions.
 */
export const MODEL_IDS = {
  /** Claude Haiku 5.5: escalation drafts for WhatsApp, voice call briefs. */
  default: "claude-haiku-5-5",
  /** Claude Sonnet 5.5: careful legal wording (legal notice, ODR pack). */
  legal: "claude-sonnet-5-5",
  /** OpenAI GPT-5.6 Luna: used when the Claude call errors or is rate limited. */
  fallback: "gpt-5.6-luna",
} as const;

export type ModelKey = keyof typeof MODEL_IDS;

/** The three models the router can call. Tests pass mock models here. */
export type ModelSet = {
  default: LanguageModel;
  legal: LanguageModel;
  fallback: LanguageModel;
};

export function productionModels(): ModelSet {
  return {
    default: anthropic(MODEL_IDS.default),
    legal: anthropic(MODEL_IDS.legal),
    fallback: openai(MODEL_IDS.fallback),
  };
}

/** Legal wording steps use the careful model; every other step uses the default one. */
export function primaryFor(step: LadderStep): "default" | "legal" {
  return step === "legal_notice" || step === "odr_pack" ? "legal" : "default";
}
