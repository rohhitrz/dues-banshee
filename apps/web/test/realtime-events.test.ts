import { describe, expect, it } from "vitest";
import { routeRealtimeEvent } from "@/lib/call/realtime-events";

describe("routeRealtimeEvent", () => {
  it("maps a function call to a tool call", () => {
    expect(
      routeRealtimeEvent({
        type: "response.function_call_arguments.done",
        call_id: "call_1",
        name: "get_invoice_facts",
        arguments: "{}",
        item_id: "item_1",
      }),
    ).toEqual({ kind: "tool_call", callId: "call_1", name: "get_invoice_facts", arguments: "{}" });
  });

  it("maps a missing arguments string to an empty one", () => {
    expect(
      routeRealtimeEvent({ type: "response.function_call_arguments.done", call_id: "c", name: "end_call" }),
    ).toEqual({ kind: "tool_call", callId: "c", name: "end_call", arguments: "" });
  });

  it("maps buyer and agent transcripts, and drops empty ones", () => {
    expect(
      routeRealtimeEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "i1",
        transcript: "haan, Friday ko",
      }),
    ).toEqual({ kind: "transcript", speaker: "buyer", itemId: "i1", text: "haan, Friday ko" });
    expect(
      routeRealtimeEvent({ type: "response.output_audio_transcript.done", item_id: "i2", transcript: "Namaste" }),
    ).toEqual({ kind: "transcript", speaker: "agent", itemId: "i2", text: "Namaste" });
    expect(
      routeRealtimeEvent({ type: "response.output_audio_transcript.done", item_id: "i2", transcript: "  \n" }),
    ).toEqual({ kind: "ignore" });
  });

  it("maps response.done and error", () => {
    expect(routeRealtimeEvent({ type: "response.done" })).toEqual({ kind: "response_done" });
    expect(routeRealtimeEvent({ type: "error", error: { message: "x" } })).toEqual({ kind: "error" });
  });

  it("ignores unknown and malformed input without throwing", () => {
    for (const input of [
      null,
      undefined,
      42,
      "response.done",
      [],
      {},
      { type: 7 },
      { type: "session.created" },
      { type: "response.function_call_arguments.done", call_id: 5, name: "x" },
      { type: "response.function_call_arguments.done", call_id: "c" },
      { type: "conversation.item.input_audio_transcription.completed", transcript: "no item id" },
      { type: "response.output_audio_transcript.done", item_id: "i", transcript: 3 },
    ]) {
      expect(routeRealtimeEvent(input)).toEqual({ kind: "ignore" });
    }
  });
});
