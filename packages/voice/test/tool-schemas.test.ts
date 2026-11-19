import { describe, expect, it } from "vitest";
import { CALL_TOOLS } from "../src/tool-schemas";

describe("record_promise_to_pay description", () => {
  const description = CALL_TOOLS.find((t) => t.name === "record_promise_to_pay")?.description ?? "";

  it("asks for a read-back in rupees, in words, and the date as written in the date_list", () => {
    expect(description).toContain("read the amount back in rupees, in words (amount_words style)");
    expect(description).toContain("the date exactly as its date_list entry is written");
    expect(description).toContain("heard a clear yes from the buyer");
    expect(description).toContain("not a vague answer such as shayad");
  });

  it("does not mention digits", () => {
    expect(description).not.toMatch(/digit/i);
  });
});
