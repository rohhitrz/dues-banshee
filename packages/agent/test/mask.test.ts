import { describe, expect, it } from "vitest";
import { maskNumber } from "../src/channel/mask";

describe("maskNumber", () => {
  it("keeps the last four digits and masks every other character", () => {
    expect(maskNumber("+919000000001")).toEqual("*********0001");
    expect(maskNumber("whatsapp:+919000000001")).toEqual("******************0001");
    expect(maskNumber("+91 90000 00001")).toEqual("***********0001");
  });

  it("keeps the length and handles short and empty input", () => {
    expect(maskNumber("")).toEqual("");
    expect(maskNumber("123")).toEqual("123");
    expect(maskNumber("+1234")).toEqual("*1234");
  });
});
