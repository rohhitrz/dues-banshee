import { describe, expect, it } from "vitest";
import { VOICE_MODEL_IDS, realtimeModel } from "../src/models";

describe("realtimeModel", () => {
  it("selects the demo model only for the exact value gpt-realtime-2.1", () => {
    expect(realtimeModel("gpt-realtime-2.1")).toBe("gpt-realtime-2.1");
  });

  it("falls back to the mini model when unset", () => {
    expect(realtimeModel(undefined)).toBe("gpt-realtime-2.1-mini");
  });

  it("falls back to the mini model for an unknown model", () => {
    expect(realtimeModel("gpt-4o-realtime")).toBe("gpt-realtime-2.1-mini");
  });

  it("falls back to the mini model for an empty string", () => {
    expect(realtimeModel("")).toBe("gpt-realtime-2.1-mini");
  });

  it("falls back to the mini model for near-miss values", () => {
    for (const value of [
      " gpt-realtime-2.1",
      "gpt-realtime-2.1 ",
      "GPT-REALTIME-2.1",
      "gpt-realtime-2.1\n",
      "gpt-realtime-2.10",
      "gpt-realtime-2.1-mini",
    ]) {
      expect(realtimeModel(value)).toBe("gpt-realtime-2.1-mini");
    }
  });

  it("exposes the voice constants the provider relies on", () => {
    expect(VOICE_MODEL_IDS.transcribe).toBe("gpt-live-transcribe");
    expect(VOICE_MODEL_IDS.voice).toBe("marin");
  });
});
