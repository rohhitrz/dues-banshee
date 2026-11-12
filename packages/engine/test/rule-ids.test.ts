import { describe, expect, it } from "vitest";
import { RULE_IDS } from "../src/rule-ids";

describe("RULE_IDS", () => {
  it("lists exactly the six rule IDs in order", () => {
    expect([...RULE_IDS]).toEqual([
      "MSMED-15",
      "MSMED-16",
      "MSMED-18",
      "IT-43BH",
      "MSMED-SCOPE",
      "MSMED-ODR",
    ]);
  });
});
