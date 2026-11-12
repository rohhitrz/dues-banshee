import { describe, expect, it } from "vitest";
import { buildImport } from "../src/build-import";
import { compareWithStored } from "../src/compare";
import type { OkRow, StoredInvoiceFacts, SupplierFacts } from "../src/types";

const DEMO_SUPPLIER: SupplierFacts = {
  id: "demo-supplier",
  supplierCategory: "micro",
  supplierActivity: "manufacturing",
  udyamRegisteredOn: "2024-04-15",
};

/** The Sharma row from the file: ₹4,12,000, invoice date 2026-09-02, acceptance defaulted to it. */
function sharmaRow(): OkRow {
  const result = buildImport(
    [
      { rowNumber: 1, cells: ["Invoice No", "Party Name", "Amount", "Invoice Date"] },
      { rowNumber: 2, cells: ["LPC/26-27/0412", "Sharma Traders", "₹4,12,000", "02/09/2026"] },
    ],
    DEMO_SUPPLIER,
  );
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.fileErrors)}`);
  const row = result.rows[0];
  if (row === undefined || !row.ok) throw new Error("expected an ok row");
  return row;
}

const MATCHING: StoredInvoiceFacts = {
  amountPaise: 41_200_000,
  invoiceDate: "2026-09-02",
  acceptedOn: "2026-09-02",
};

const DIFFERING: StoredInvoiceFacts = {
  amountPaise: 41_500_000,
  invoiceDate: "2026-09-03",
  acceptedOn: "2026-09-04",
};

type FieldName = "amount" | "invoice date" | "accepted date";

// Each of the 8 subsets of {amount, invoice date, accepted date}, in the fixed order.
const SUBSETS: readonly (readonly FieldName[])[] = [
  [],
  ["amount"],
  ["invoice date"],
  ["accepted date"],
  ["amount", "invoice date"],
  ["amount", "accepted date"],
  ["invoice date", "accepted date"],
  ["amount", "invoice date", "accepted date"],
];

function storedDifferingIn(fields: readonly FieldName[]): StoredInvoiceFacts {
  return {
    amountPaise: fields.includes("amount") ? DIFFERING.amountPaise : MATCHING.amountPaise,
    invoiceDate: fields.includes("invoice date") ? DIFFERING.invoiceDate : MATCHING.invoiceDate,
    acceptedOn: fields.includes("accepted date") ? DIFFERING.acceptedOn : MATCHING.acceptedOn,
  };
}

describe("compareWithStored (Requirement 10.6)", () => {
  it("builds a file row matching the stored facts", () => {
    const row = sharmaRow();
    expect(row.invoice.amountPaise).toBe(MATCHING.amountPaise);
    expect(row.invoiceDate).toBe(MATCHING.invoiceDate);
    expect(row.invoice.acceptedOn).toBe(MATCHING.acceptedOn);
  });

  it.each(SUBSETS.map((fields) => [fields.length === 0 ? "none" : fields.join(" + "), fields] as const))(
    "differing fields: %s",
    (_label, fields) => {
      const result = compareWithStored(sharmaRow(), storedDifferingIn(fields));
      if (fields.length === 0) {
        expect(result).toBeNull();
      } else {
        expect(result).toBe(`Differs from stored invoice: ${fields.join(", ")}`);
      }
    },
  );

  it("covers all 8 subsets", () => {
    expect(SUBSETS).toHaveLength(8);
    expect(new Set(SUBSETS.map((s) => s.join("|"))).size).toBe(8);
  });

  it("reports the Sharma ₹4,15,000 case as `Differs from stored invoice: amount` (Requirement 10.7)", () => {
    const result = buildImport(
      [
        { rowNumber: 1, cells: ["Invoice No", "Party Name", "Amount", "Invoice Date"] },
        { rowNumber: 2, cells: ["LPC/26-27/0412", "Sharma Traders", "₹4,15,000", "02/09/2026"] },
      ],
      DEMO_SUPPLIER,
    );
    if (!result.ok) throw new Error("expected ok");
    const row = result.rows[0];
    if (row === undefined || !row.ok) throw new Error("expected an ok row");
    expect(compareWithStored(row, MATCHING)).toBe("Differs from stored invoice: amount");
  });
});
