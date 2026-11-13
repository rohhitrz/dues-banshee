import { describe, expect, it } from "vitest";
import { RULE_IDS, RULE_SOURCES } from "../src/rule-ids";

describe("RULE_IDS", () => {
  it("lists exactly the seven rule IDs in order, MSMED-2B last", () => {
    expect([...RULE_IDS]).toEqual([
      "MSMED-15",
      "MSMED-16",
      "MSMED-18",
      "IT-43BH",
      "MSMED-SCOPE",
      "MSMED-ODR",
      "MSMED-2B",
    ]);
  });

  it("has a frozen source string for every rule ID", () => {
    expect(Object.isFrozen(RULE_SOURCES)).toBe(true);
    expect(Object.keys(RULE_SOURCES)).toEqual([...RULE_IDS]);
    expect(RULE_SOURCES["MSMED-2B"]).toBe("MSMED Act 2006, s.2(b) and Explanation");
    expect(RULE_SOURCES["IT-43BH"]).toBe(
      "Income-tax Act 1961, s.43B(h); Income-tax Act 2025, s.37(2)(g)",
    );
  });
});
