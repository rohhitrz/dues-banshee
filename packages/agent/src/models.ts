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
  /** OpenAI GPT-6 Luna: used when the Claude call errors or is rate limited. */
  fallback: "gpt-6-luna",
} as const;

export type ModelKey = keyof typeof MODEL_IDS;

/** Voice call model IDs (tech.md: IDs live only here). Not used by the text router. */
export const VOICE_MODEL_IDS = {
  /** Default speech-to-speech model. */
  realtime: "gpt-realtime-2.1-mini",
  /** Switched on for the demo via the env override. */
  realtimeDemo: "gpt-realtime-2.1",
  /** Input transcription model (Hinglish). */
  transcribe: "gpt-live-transcribe",
  /** Realtime voice. */
  voice: "marin",
} as const;

/**
 * Picks the realtime model from an env value. Exactly "gpt-realtime-2.1" selects the demo
 * model; anything else, including unset, selects the default mini model.
 */
export function realtimeModel(envValue: string | undefined): string {
  return envValue === VOICE_MODEL_IDS.realtimeDemo
    ? VOICE_MODEL_IDS.realtimeDemo
    : VOICE_MODEL_IDS.realtime;
}

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
