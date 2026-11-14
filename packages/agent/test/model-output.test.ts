import { describe, expect, it } from "vitest";
import { MODEL_OUTPUT_SCHEMA } from "../src/core/model-output";

describe("MODEL_OUTPUT_SCHEMA", () => {
  it("accepts invented rule IDs so they reach the validator", () => {
    const input = { text: "Namaste Sharma ji", ruleIds: ["MADE-UP"] };
    expect(MODEL_OUTPUT_SCHEMA.parse(input)).toEqual({
      text: "Namaste Sharma ji",
      ruleIds: ["MADE-UP"],
    });
  });

  it("accepts an empty rule ID list", () => {
    expect(MODEL_OUTPUT_SCHEMA.parse({ text: "Hello", ruleIds: [] })).toEqual({
      text: "Hello",
      ruleIds: [],
    });
  });

  it("rejects a missing text", () => {
    const result = MODEL_OUTPUT_SCHEMA.safeParse({ ruleIds: ["MSMED-16"] });
    expect(result.success).toBe(false);
  });

  it("rejects ruleIds that is not an array", () => {
    const result = MODEL_OUTPUT_SCHEMA.safeParse({
      text: "Hello",
      ruleIds: "MSMED-16",
    });
    expect(result.success).toBe(false);
  });
});
