import { describe, expect, it } from "vitest";
import { buildImport } from "../src/build-import";
import type { RawTable, RowResult, SupplierFacts } from "../src/types";

const DEMO_SUPPLIER: SupplierFacts = {
  id: "demo-supplier",
  supplierCategory: "micro",
  supplierActivity: "manufacturing",
  udyamRegisteredOn: "2024-04-15",
};

const HEADERS = ["Invoice No", "Party Name", "Amount", "Invoice Date"];

function table(...rows: string[][]): RawTable {
  return rows.map((cells, i) => ({ rowNumber: i + 1, cells }));
}

function expectParsed(table: RawTable, supplier: SupplierFacts = DEMO_SUPPLIER): RowResult[] {
  const result = buildImport(table, supplier);
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.fileErrors)}`);
  return result.rows;
}

describe("buildImport", () => {
  describe("blank rows (Requirement 5.11)", () => {
    it("skips a row whose mapped cells are all blank and produces no Row_Result for it", () => {
      const rows = expectParsed(
        table(
          HEADERS,
          ["INV-1", "Sharma Traders", "500", "02/09/2026"],
          ["", "", "", ""],
          ["INV-2", "Gupta Works", "700", "03/09/2026"],
        ),
      );
      expect(rows.map((r) => r.rowNumber)).toEqual([2, 4]);
      expect(rows.every((r) => r.ok)).toBe(true);
    });

    it("skips a row of whitespace-only cells", () => {
      const rows = expectParsed(table(HEADERS, ["  ", "\t", " ", ""]));
      expect(rows).toEqual([]);
    });

    it("skips a row that is blank in every mapped column even if an unused column has text", () => {
      const rows = expectParsed(
        table([...HEADERS, "Remarks"], ["", "", "", "", "see note"]),
      );
      expect(rows).toEqual([]);
    });

    it("does not skip a row with a single filled mapped cell; it becomes an error row", () => {
      const rows = expectParsed(table(HEADERS, ["INV-1", "", "", ""]));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ ok: false, rowNumber: 2 });
    });

    it("skips a row that is shorter than the header and empty", () => {
      const rows = expectParsed(table(HEADERS, []));
      expect(rows).toEqual([]);
    });
  });

  describe("invalid supplier (Requirement 6.9)", () => {
    const validRow = ["INV-1", "Sharma Traders", "500", "02/09/2026"];

    it("rejects category `large` with an invalid_supplier file error and maps no row", () => {
      const supplier = { ...DEMO_SUPPLIER, supplierCategory: "large" } as unknown as SupplierFacts;
      const result = buildImport(table(HEADERS, validRow), supplier);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.fileErrors).toHaveLength(1);
      expect(result.fileErrors[0]?.code).toBe("invalid_supplier");
      expect(result.fileErrors[0]?.message).toContain('"large"');
      expect(Object.hasOwn(result, "rows")).toBe(false);
    });

    it("rejects an unknown activity", () => {
      const supplier = { ...DEMO_SUPPLIER, supplierActivity: "retail" } as unknown as SupplierFacts;
      const result = buildImport(table(HEADERS, validRow), supplier);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.fileErrors.map((e) => e.code)).toEqual(["invalid_supplier"]);
    });

    it("rejects an impossible Udyam registration date", () => {
      const supplier: SupplierFacts = { ...DEMO_SUPPLIER, udyamRegisteredOn: "2024-02-30" };
      const result = buildImport(table(HEADERS, validRow), supplier);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.fileErrors.map((e) => e.code)).toEqual(["invalid_supplier"]);
    });

    it("reports the supplier error before a header error", () => {
      const supplier = { ...DEMO_SUPPLIER, supplierCategory: "large" } as unknown as SupplierFacts;
      const result = buildImport(table(["Foo", "Bar"], ["1", "2"]), supplier);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.fileErrors.map((e) => e.code)).toEqual(["invalid_supplier"]);
    });
  });

  describe("duplicates within a file (Requirements 7.2, 7.3)", () => {
    it("turns the second row with the same key into `Duplicate of row N` on the invoice-number column", () => {
      const rows = expectParsed(
        table(
          HEADERS,
          ["LPC/26-27/0412", "Sharma Traders", "₹4,12,000", "02/09/2026"],
          ["LPC/26-27/0412", "  SHARMA   traders ", "₹4,12,000", "02/09/2026"],
        ),
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ ok: true, rowNumber: 2 });
      expect(rows[1]).toEqual({
        ok: false,
        rowNumber: 3,
        errors: [{ column: "Invoice No", reason: "Duplicate of row 2" }],
      });
    });

    it("names the first row's file row number, with title rows above and rows between", () => {
      const rows = expectParsed(
        table(
          ["Sharma Co Ltd"],
          ["Bills Receivable"],
          HEADERS,
          ["INV-9", "Sharma Traders", "500", "02/09/2026"],
          ["INV-10", "Gupta Works", "700", "03/09/2026"],
          ["", "", "", ""],
          ["inv-9", "  SHARMA   traders ", "900", "05/09/2026"],
        ),
      );
      expect(rows.map((r) => r.rowNumber)).toEqual([4, 5, 7]);
      expect(rows[2]).toEqual({
        ok: false,
        rowNumber: 7,
        errors: [{ column: "Invoice No", reason: "Duplicate of row 4" }],
      });
    });

    it("uses the invoice-number header as written in the file", () => {
      const rows = expectParsed(
        table(
          ["Voucher No.", "Particulars", "Pending Amount", "Date"],
          ["V1", "Sharma", "500", "02/09/2026"],
          ["V1", "sharma", "500", "02/09/2026"],
        ),
      );
      expect(rows[1]).toMatchObject({
        ok: false,
        errors: [{ column: "Voucher No.", reason: "Duplicate of row 2" }],
      });
    });

    it("refers a third copy to the first row, not the second", () => {
      const rows = expectParsed(
        table(
          HEADERS,
          ["INV-1", "Sharma", "500", "02/09/2026"],
          ["INV-1", "Sharma", "500", "02/09/2026"],
          ["INV-1", "Sharma", "500", "02/09/2026"],
        ),
      );
      expect(rows[1]).toMatchObject({ errors: [{ reason: "Duplicate of row 2" }] });
      expect(rows[2]).toMatchObject({ errors: [{ reason: "Duplicate of row 2" }] });
    });

    it("does not treat different invoice numbers or buyers as duplicates", () => {
      const rows = expectParsed(
        table(
          HEADERS,
          ["INV-1", "Sharma", "500", "02/09/2026"],
          ["INV-2", "Sharma", "500", "02/09/2026"],
          ["INV-1", "Gupta", "500", "02/09/2026"],
        ),
      );
      expect(rows.every((r) => r.ok)).toBe(true);
    });

    it("does not count an earlier error row as the first occurrence", () => {
      const rows = expectParsed(
        table(
          HEADERS,
          ["INV-1", "Sharma", "abc", "02/09/2026"],
          ["INV-1", "Sharma", "500", "02/09/2026"],
        ),
      );
      expect(rows[0]).toMatchObject({ ok: false, rowNumber: 2 });
      expect(rows[1]).toMatchObject({ ok: true, rowNumber: 3 });
    });
  });

  it("returns the header mapping alongside the rows", () => {
    const result = buildImport(table(HEADERS, ["INV-1", "Sharma", "500", "02/09/2026"]), DEMO_SUPPLIER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mapping.headerRowNumber).toBe(1);
  });

  it("returns header errors as file errors", () => {
    const result = buildImport(table(["Foo", "Bar"], ["1", "2"]), DEMO_SUPPLIER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fileErrors.map((e) => e.code)).toEqual(["missing_headers"]);
  });
});
