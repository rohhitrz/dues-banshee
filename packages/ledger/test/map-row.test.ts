import { MAX_PAISE } from "@dues-banshee/engine";
import { describe, expect, it } from "vitest";
import { detectHeader } from "../src/headers";
import { mapRow } from "../src/map-row";
import type { HeaderMapping, OkRow, RawRow, RowResult, SupplierFacts } from "../src/types";

/** The demo supplier from Requirement 11.2. */
const DEMO_SUPPLIER: SupplierFacts = {
  id: "demo-supplier",
  supplierCategory: "micro",
  supplierActivity: "manufacturing",
  udyamRegisteredOn: "2024-04-15",
};

const BASE_HEADERS = ["Invoice No", "Party Name", "Amount", "Invoice Date"];

function mappingFor(headers: string[]): HeaderMapping {
  const result = detectHeader([{ rowNumber: 1, cells: headers }]);
  if (!result.ok) throw new Error(`expected a mapping, got ${JSON.stringify(result.errors)}`);
  return result.mapping;
}

function dataRow(cells: string[], rowNumber = 2): RawRow {
  return { rowNumber, cells };
}

function expectOk(result: RowResult): OkRow {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.errors)}`);
  return result;
}

function expectErrors(result: RowResult) {
  if (result.ok) throw new Error("expected errors, got an ok row");
  return result.errors;
}

describe("mapRow", () => {
  describe("Sharma Traders row (Requirement 6.10)", () => {
    const mapping = mappingFor([...BASE_HEADERS, "Credit Days"]);
    const row = dataRow(["LPC/26-27/0412", "Sharma Traders", "₹4,12,000", "02/09/2026", "45"], 7);
    const result = expectOk(mapRow(row, mapping, DEMO_SUPPLIER));

    it("builds the engine invoice from the row and the supplier", () => {
      expect(result.rowNumber).toBe(7);
      expect(result.invoice.amountPaise).toBe(41_200_000);
      expect(result.invoice.acceptedOn).toBe("2026-09-02");
      expect(result.invoice.agreedTermDays).toBe(45);
      expect(result.invoice.supplierCategory).toBe("micro");
      expect(result.invoice.supplierActivity).toBe("manufacturing");
      expect(result.invoice.udyamRegisteredOn).toBe("2024-04-15");
      expect(Object.hasOwn(result.invoice, "paidOn")).toBe(false);
      expect(result.invoice.id).toBe(result.dedupeKey.value);
      expect(result.invoice.id).not.toBe("");
    });

    it("returns the trimmed names, invoice date, defaulted flag and no warnings", () => {
      expect(result.buyerName).toBe("Sharma Traders");
      expect(result.invoiceNumber).toBe("LPC/26-27/0412");
      expect(result.invoiceDate).toBe("2026-09-02");
      expect(result.acceptanceDateDefaulted).toBe(true);
      expect(result.warnings).toEqual([]);
    });
  });

  it("omits agreedTermDays and udyamRegisteredOn when they are absent", () => {
    const mapping = mappingFor(BASE_HEADERS);
    const supplier: SupplierFacts = {
      id: "s2",
      supplierCategory: "small",
      supplierActivity: "services",
    };
    const result = expectOk(
      mapRow(dataRow(["INV-1", "Gupta", "500", "2026-09-02"]), mapping, supplier),
    );
    expect(Object.hasOwn(result.invoice, "agreedTermDays")).toBe(false);
    expect(Object.hasOwn(result.invoice, "udyamRegisteredOn")).toBe(false);
    expect(result.invoice.supplierCategory).toBe("small");
    expect(result.invoice.supplierActivity).toBe("services");
  });

  describe("field errors (Requirement 6.3)", () => {
    it("reports a blank buyer and a bad amount as two errors, one per column", () => {
      const mapping = mappingFor(BASE_HEADERS);
      const errors = expectErrors(
        mapRow(dataRow(["INV-1", "   ", "abc", "02/09/2026"]), mapping, DEMO_SUPPLIER),
      );
      expect(errors).toEqual([
        { column: "Party Name", reason: "is required" },
        { column: "Amount", reason: 'not a recognised amount: "abc"' },
      ]);
    });

    it("names the column header as written in the file", () => {
      const mapping = mappingFor(["Voucher No.", "Particulars", "Pending Amount", "Date"]);
      const errors = expectErrors(mapRow(dataRow(["", "Sharma", "", ""]), mapping, DEMO_SUPPLIER));
      expect(errors.map((e) => e.column)).toEqual(["Voucher No.", "Pending Amount", "Date"]);
      expect(errors.every((e) => e.reason === "is required")).toBe(true);
    });

    it("reports a bad invoice date on the invoice-date column when there is no acceptance column", () => {
      const mapping = mappingFor(BASE_HEADERS);
      const errors = expectErrors(
        mapRow(dataRow(["INV-1", "Sharma", "500", "31/02/2026"]), mapping, DEMO_SUPPLIER),
      );
      expect(errors).toEqual([
        { column: "Invoice Date", reason: 'not a real calendar day: "31/02/2026"' },
      ]);
    });
  });

  describe("Engine validation mapped to columns (Requirement 6.6)", () => {
    const mapping = mappingFor([...BASE_HEADERS, "Credit Days"]);

    it("rejects an amount of 0 on the amount column with the Engine's reason", () => {
      const errors = expectErrors(
        mapRow(dataRow(["INV-1", "Sharma", "0", "02/09/2026", "45"]), mapping, DEMO_SUPPLIER),
      );
      expect(errors).toEqual([
        { column: "Amount", reason: `must be an integer between 1 and ${MAX_PAISE} paise` },
      ]);
    });

    it("rejects an amount above MAX_PAISE on the amount column", () => {
      const errors = expectErrors(
        mapRow(
          dataRow(["INV-1", "Sharma", "₹1,000.01 crore", "02/09/2026", "45"]),
          mapping,
          DEMO_SUPPLIER,
        ),
      );
      expect(errors).toEqual([
        { column: "Amount", reason: `must be an integer between 1 and ${MAX_PAISE} paise` },
      ]);
    });

    it("rejects a credit term of 0 days on the credit-days column", () => {
      const errors = expectErrors(
        mapRow(dataRow(["INV-1", "Sharma", "500", "02/09/2026", "0"]), mapping, DEMO_SUPPLIER),
      );
      expect(errors).toEqual([{ column: "Credit Days", reason: "must be a positive integer" }]);
    });
  });

  describe("credit term above 45 days (Requirement 6.8)", () => {
    it("returns ok with the MSMED-15 warning", () => {
      const mapping = mappingFor([...BASE_HEADERS, "Credit Days"]);
      const result = expectOk(
        mapRow(dataRow(["INV-1", "Sharma", "500", "02/09/2026", "60"]), mapping, DEMO_SUPPLIER),
      );
      expect(result.invoice.agreedTermDays).toBe(60);
      expect(result.warnings).toEqual([
        "Credit term of 60 days is above the 45-day limit; the due date uses 45 days (MSMED-15)",
      ]);
    });

    it("adds no warning at exactly 45 days", () => {
      const mapping = mappingFor([...BASE_HEADERS, "Credit Days"]);
      const result = expectOk(
        mapRow(dataRow(["INV-1", "Sharma", "500", "02/09/2026", "45"]), mapping, DEMO_SUPPLIER),
      );
      expect(result.warnings).toEqual([]);
    });
  });

  describe("acceptance date (Requirement 6.5)", () => {
    it("uses a Delivery Date cell as acceptedOn and does not flag it as defaulted", () => {
      const mapping = mappingFor([...BASE_HEADERS, "Delivery Date"]);
      const result = expectOk(
        mapRow(
          dataRow(["INV-1", "Sharma", "500", "02/09/2026", "05/09/2026"]),
          mapping,
          DEMO_SUPPLIER,
        ),
      );
      expect(result.invoice.acceptedOn).toBe("2026-09-05");
      expect(result.invoiceDate).toBe("2026-09-02");
      expect(result.acceptanceDateDefaulted).toBe(false);
    });

    it("defaults acceptedOn to the invoice date when the acceptance cell is blank", () => {
      const mapping = mappingFor([...BASE_HEADERS, "Delivery Date"]);
      const result = expectOk(
        mapRow(dataRow(["INV-1", "Sharma", "500", "02/09/2026", ""]), mapping, DEMO_SUPPLIER),
      );
      expect(result.invoice.acceptedOn).toBe("2026-09-02");
      expect(result.acceptanceDateDefaulted).toBe(true);
    });

    it("reports a bad acceptance date on the acceptance column", () => {
      const mapping = mappingFor([...BASE_HEADERS, "Delivery Date"]);
      const errors = expectErrors(
        mapRow(
          dataRow(["INV-1", "Sharma", "500", "02/09/2026", "31/02/2026"]),
          mapping,
          DEMO_SUPPLIER,
        ),
      );
      expect(errors).toEqual([
        { column: "Delivery Date", reason: 'not a real calendar day: "31/02/2026"' },
      ]);
    });
  });

  it("reads a cell missing from a short row as blank", () => {
    const mapping = mappingFor(BASE_HEADERS);
    const errors = expectErrors(mapRow(dataRow(["INV-1", "Sharma"]), mapping, DEMO_SUPPLIER));
    expect(errors).toEqual([
      { column: "Amount", reason: "is required" },
      { column: "Invoice Date", reason: "is required" },
    ]);
  });
});
