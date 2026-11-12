import { describe, expect, it } from "vitest";
import { dedupeKey, headerKey, textKey } from "../src/keys";

describe("headerKey (Requirement 5.4)", () => {
  it.each<[string, string]>([
    ["Party's Name", "partysname"],
    ["Invoice #", "invoice"],
    ["Ref. No.", "refno"],
    ["INVOICE   NO", "invoiceno"],
  ])("normalises %j to %j", (input, expected) => {
    expect(headerKey(input)).toBe(expected);
  });
});

describe("textKey (Requirement 7.1)", () => {
  it("ignores case, outer whitespace and repeated whitespace", () => {
    expect(textKey("  SHARMA   traders ")).toBe(textKey("Sharma Traders"));
    expect(textKey("  SHARMA   traders ")).toBe("sharma traders");
  });

  it("keeps punctuation, so INV/001 and INV-001 differ", () => {
    expect(textKey("INV/001")).not.toBe(textKey("INV-001"));
  });
});

describe("dedupeKey (Requirements 7.1, 7.2)", () => {
  const supplier = "supplier-1";

  it("gives the same value for names that differ only in case and spacing", () => {
    const a = dedupeKey(supplier, "  SHARMA   traders ", "LPC/0412");
    const b = dedupeKey(supplier, "Sharma Traders", "lpc/0412");
    expect(a.value).toBe(b.value);
    expect(a.buyerKey).toBe("sharma traders");
    expect(a.invoiceNumberKey).toBe("lpc/0412");
    expect(a.supplierId).toBe(supplier);
  });

  it("gives different values for INV/001 and INV-001", () => {
    const a = dedupeKey(supplier, "Sharma Traders", "INV/001");
    const b = dedupeKey(supplier, "Sharma Traders", "INV-001");
    expect(a.value).not.toBe(b.value);
  });

  it("gives different values for different suppliers", () => {
    const a = dedupeKey("supplier-1", "Sharma Traders", "INV-001");
    const b = dedupeKey("supplier-2", "Sharma Traders", "INV-001");
    expect(a.value).not.toBe(b.value);
  });

  it("stays distinct when a buyer name contains a quote or a comma", () => {
    const plain = dedupeKey(supplier, "Sharma", "INV-001");
    const quoted = dedupeKey(supplier, 'Sharma "Traders"', "INV-001");
    const comma = dedupeKey(supplier, "Sharma, Traders", "INV-001");
    const values = [plain.value, quoted.value, comma.value];
    expect(new Set(values).size).toBe(3);
  });

  it("cannot be forged by moving a delimiter between buyer and invoice number", () => {
    const a = dedupeKey(supplier, 'a","b', "c");
    const b = dedupeKey(supplier, "a", 'b","c');
    expect(a.value).not.toBe(b.value);
    expect(JSON.parse(a.value)).toEqual([supplier, 'a","b', "c"]);
  });
});
