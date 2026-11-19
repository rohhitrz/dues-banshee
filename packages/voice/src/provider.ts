/**
 * The seam between the call logic and a realtime voice vendor. OpenAI Realtime is the only provider
 * today; Sarvam or GPT-Live can be added behind this interface later.
 */

/** What the server hands the provider to open a session: persona text and the tools the model may call. */
export interface VoiceSessionSpec {
  instructions: string;
  tools: readonly { name: string; description: string; parameters: unknown }[];
}

/** Result of minting a short-lived browser key. `expiresAt` is unix seconds. Never carries the standard API key. */
export type MintResult =
  | { ok: true; value: string; expiresAt: number }
  | { ok: false; error: "http" | "network" | "timeout" | "bad_response"; httpStatus: number | null };

export interface VoiceProvider {
  readonly name: "openai_realtime";
  /** Where the browser posts its SDP offer. */
  readonly connectUrl: string;
  /** Mints an ephemeral key holding the whole session config. Never throws. */
  mintKey(spec: VoiceSessionSpec): Promise<MintResult>;
}
