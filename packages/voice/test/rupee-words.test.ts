import { describe, expect, it } from "vitest";
import { paiseToWords } from "../src/rupee-words";

describe("paiseToWords", () => {
  it.each([
    [41_851_941, "four lakh eighteen thousand five hundred nineteen rupees and forty-one paise"],
    [41_200_000, "four lakh twelve thousand rupees"],
    [41_712_794, "four lakh seventeen thousand one hundred twenty-seven rupees and ninety-four paise"],
    [512_794, "five thousand one hundred twenty-seven rupees and ninety-four paise"],
    [20_000_000, "two lakh rupees"],
  ])("%i paise", (paise, words) => {
    expect(paiseToWords(paise)).toBe(words);
  });

  it("writes 0 paise as zero rupees", () => {
    expect(paiseToWords(0)).toBe("zero rupees");
  });

  it("writes 1 paise as one paise, with no rupee part", () => {
    expect(paiseToWords(1)).toBe("one paise");
    expect(paiseToWords(19)).toBe("nineteen paise");
    expect(paiseToWords(99)).toBe("ninety-nine paise");
  });

  it("uses the singular for exactly one rupee", () => {
    expect(paiseToWords(100)).toBe("one rupee");
    expect(paiseToWords(101)).toBe("one rupee and one paise");
    expect(paiseToWords(200)).toBe("two rupees");
  });

  it("joins tens and ones with a hyphen and leaves out 'and' inside the number", () => {
    expect(paiseToWords(2_100)).toBe("twenty-one rupees");
    expect(paiseToWords(10_100)).toBe("one hundred one rupees");
    expect(paiseToWords(10_000_000)).toBe("one lakh rupees");
    expect(paiseToWords(10_010_000)).toBe("one lakh one hundred rupees");
    expect(paiseToWords(10_100_000)).toBe("one lakh one thousand rupees");
  });

  it("uses lakh for 1,00,000 to 99,99,999 rupees", () => {
    expect(paiseToWords(999_999_900)).toBe(
      "ninety-nine lakh ninety-nine thousand nine hundred ninety-nine rupees",
    );
  });

  it("uses crore for 1,00,00,000 rupees and above", () => {
    expect(paiseToWords(1_000_000_000)).toBe("one crore rupees");
    expect(paiseToWords(1_000_000_001)).toBe("one crore rupees and one paise");
    expect(paiseToWords(12_345_678_912)).toBe(
      "twelve crore thirty-four lakh fifty-six thousand seven hundred eighty-nine rupees and twelve paise",
    );
    expect(paiseToWords(100_000_000_000)).toBe("one hundred crore rupees");
    expect(paiseToWords(123_000_000_000)).toBe("one hundred twenty-three crore rupees");
  });

  it("rejects negative, fractional and non-finite amounts", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => paiseToWords(bad)).toThrow(RangeError);
    }
  });
});
