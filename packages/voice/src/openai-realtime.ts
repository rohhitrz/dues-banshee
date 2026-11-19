import { VOICE_MODEL_IDS } from "@dues-banshee/agent/models";
import { z } from "zod";
import type { MintResult, VoiceProvider, VoiceSessionSpec } from "./provider";

const CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
const CONNECT_URL = "https://api.openai.com/v1/realtime/calls";
const KEY_LIFETIME_SECONDS = 60;
const MINT_TIMEOUT_MS = 10_000;

/** Input languages and literal terms the transcriber is told to expect on a Hinglish collections call. */
const TRANSCRIPTION_LANGUAGES = ["hi", "en"];
const TRANSCRIPTION_KEYWORDS = [
  "haan",
  "nahi",
  "ji",
  "agle",
  "lakh",
  "hazaar",
  "rupaye",
  "paisa",
  "Friday",
  "Sharma ji",
];

const MintResponse = z.object({ value: z.string(), expires_at: z.number() });

export interface OpenAiRealtimeDeps {
  fetch: typeof fetch;
  /** The standard API key. Used only in the Authorization header. */
  apiKey: string;
  /** `realtimeModel(process.env.VOICE_REALTIME_MODEL)`. */
  model: string;
  /** Default `AbortSignal.timeout`. Tests pass a fake clock's signal. */
  timeoutSignal?: (ms: number) => AbortSignal;
}

/** The `client_secrets` request body: the key lifetime plus the whole session config. */
export function sessionConfigBody(model: string, spec: VoiceSessionSpec): unknown {
  return {
    expires_after: { anchor: "created_at", seconds: KEY_LIFETIME_SECONDS },
    session: {
      type: "realtime",
      model,
      instructions: spec.instructions,
      audio: {
        input: {
          transcription: {
            model: VOICE_MODEL_IDS.transcribe,
            languages: TRANSCRIPTION_LANGUAGES,
            keywords: TRANSCRIPTION_KEYWORDS,
          },
          noise_reduction: { type: "far_field" },
          turn_detection: { type: "semantic_vad", eagerness: "high" },
        },
        output: { voice: VOICE_MODEL_IDS.voice },
      },
      tools: spec.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
      tool_choice: "auto",
    },
  };
}

function isTimeout(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

export function createOpenAiRealtime(deps: OpenAiRealtimeDeps): VoiceProvider {
  const timeoutSignal = deps.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));
  return {
    name: "openai_realtime",
    connectUrl: CONNECT_URL,
    async mintKey(spec: VoiceSessionSpec): Promise<MintResult> {
      const signal = timeoutSignal(MINT_TIMEOUT_MS);
      let status: number;
      let bodyText: string;
      try {
        const response = await deps.fetch(CLIENT_SECRETS_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${deps.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(sessionConfigBody(deps.model, spec)),
          signal,
        });
        status = response.status;
        if (!response.ok) return { ok: false, error: "http", httpStatus: status };
        bodyText = await response.text();
      } catch (err) {
        return { ok: false, error: isTimeout(err, signal) ? "timeout" : "network", httpStatus: null };
      }
      let json: unknown;
      try {
        json = JSON.parse(bodyText);
      } catch {
        return { ok: false, error: "bad_response", httpStatus: status };
      }
      const parsed = MintResponse.safeParse(json);
      if (!parsed.success) return { ok: false, error: "bad_response", httpStatus: status };
      return { ok: true, value: parsed.data.value, expiresAt: parsed.data.expires_at };
    },
  };
}
