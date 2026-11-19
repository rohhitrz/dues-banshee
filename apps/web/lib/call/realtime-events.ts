/**
 * Maps one OpenAI Realtime server event to what the Call_Client should do. Pure: no I/O, never throws,
 * whatever the input is (unknown shapes, wrong types, `null`).
 *
 * Browser code: no server-only imports.
 */

export type RealtimeAction =
  /** The model called a function: forward it to the Tool_Endpoint. */
  | { kind: "tool_call"; callId: string; name: string; arguments: string }
  /** A finished, non-empty transcript line to store. */
  | { kind: "transcript"; speaker: "buyer" | "agent"; itemId: string; text: string }
  /** A response finished: fires the end armed by a successful `end_call`. */
  | { kind: "response_done" }
  /** The Realtime session reported an error: end the call. */
  | { kind: "error" }
  | { kind: "ignore" };

const IGNORE: RealtimeAction = { kind: "ignore" };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function transcriptAction(
  speaker: "buyer" | "agent",
  event: Record<string, unknown>,
): RealtimeAction {
  const { item_id: itemId, transcript } = event;
  if (typeof itemId !== "string" || itemId === "") return IGNORE;
  if (typeof transcript !== "string" || transcript.trim() === "") return IGNORE;
  return { kind: "transcript", speaker, itemId, text: transcript };
}

export function routeRealtimeEvent(event: unknown): RealtimeAction {
  const e = asRecord(event);
  if (e === null) return IGNORE;

  switch (e.type) {
    case "response.function_call_arguments.done": {
      const { call_id: callId, name, arguments: args } = e;
      if (typeof callId !== "string" || callId === "") return IGNORE;
      if (typeof name !== "string" || name === "") return IGNORE;
      // A function call without arguments may carry an empty or missing string; the server treats
      // blank arguments as "{}".
      return { kind: "tool_call", callId, name, arguments: typeof args === "string" ? args : "" };
    }
    case "conversation.item.input_audio_transcription.completed":
      return transcriptAction("buyer", e);
    case "response.output_audio_transcript.done":
      return transcriptAction("agent", e);
    case "response.done":
      return { kind: "response_done" };
    case "error":
      return { kind: "error" };
    default:
      return IGNORE;
  }
}
