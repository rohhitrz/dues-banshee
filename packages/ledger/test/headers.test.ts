import { describe, expect, it } from "vitest";
import { detectHeader, HEADER_ALIASES, REQUIRED_FIELDS } from "../src/headers";
import { headerKey } from "../src/keys";
import type { HeaderMapping, RawTable } from "../src/types";

/** Builds a table whose row numbers start at 1. */
function table(...rows: string[][]): RawTable {
  return rows.map((cells, i) => ({ rowNumber: i + 1, cells }));
}

const REQUIRED_HEADERS = ["Invoice No", "Party Name", "Amount", "Invoice Date"];

function mappingOf(...rows: string[][]): HeaderMapping {
  const result = detectHeader(table(...rows));
  if (!result.ok) throw new Error(`expected a mapping, got ${JSON.stringify(result.errors)}`);
  return result.mapping;
}

function errorsOf(...rows: string[][]) {
  const result = detectHeader(table(...rows));
  if (result.ok) throw new Error("expected header errors");
  return result.errors;
}

describe("HEADER_ALIASES (Requirement 5.4)", () => {
  it("lists no Header_Key under two fields", () => {
    const owner = new Map<string, string>();
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      for (const alias of aliases) {
        const key = headerKey(alias);
        const previous = owner.get(key);
        if (previous !== undefined && previous !== field) {
          throw new Error(`"${alias}" is under both ${previous} and ${field}`);
        }
        owner.set(key, field);
      }
    }
    expect(owner.size).toBeGreaterThan(0);
  });

  it("maps `Invoice #` and `Invoice` to invoiceNumber", () => {
    for (const header of ["Invoice #", "Invoice"]) {
      const mapping = mappingOf(["Party Name", "Amount", "Invoice Date", header]);
      expect(mapping.columns.invoiceNumber).toEqual({ index: 3, header });
    }
  });

  it("requires exactly the four required fields", () => {
    expect([...REQUIRED_FIELDS]).toEqual(["invoiceNumber", "buyerName", "amount", "invoiceDate"]);
  });
});

describe("detectHeader: Tally bills-receivable export (Requirement 5.12)", () => {
  const tally = table(
    ["Laxmi Precision Components"],
    ["Bills Receivable"],
    ["1-Apr-26 to 12-Nov-26"],
    [
      "Date",
      "Ref. No.",
      "Party's Name",
      "Opening Amount",
      "Pending Amount",
      "Due on",
      "Overdue by days",
    ],
    ["2-Sep-26", "LPC/26-27/0412", "Sharma Traders", "4,12,000", "4,12,000", "", "0"],
  );

  it("finds the header on row 4 and maps the four required columns", () => {
    const result = detectHeader(tally);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { mapping } = result;
    expect(mapping.headerRowNumber).toBe(4);
    expect(mapping.columns).toEqual({
      invoiceDate: { index: 0, header: "Date" },
      invoiceNumber: { index: 1, header: "Ref. No." },
      buyerName: { index: 2, header: "Party's Name" },
      amount: { index: 4, header: "Pending Amount" },
    });
  });

  it("leaves Opening Amount, Due on and Overdue by days unused", () => {
    const result = detectHeader(tally);
    if (!result.ok) throw new Error("expected a mapping");
    expect(result.mapping.unused).toEqual([
      { index: 3, header: "Opening Amount" },
      { index: 5, header: "Due on" },
      { index: 6, header: "Overdue by days" },
    ]);
  });
});

describe("detectHeader: Delivery_Group (Requirements 5.5, 5.6)", () => {
  it.each(["Delivery Date", "Date of Delivery", "Delivered On"])(
    "maps %s alone to acceptanceDate",
    (header) => {
      const mapping = mappingOf([...REQUIRED_HEADERS, header]);
      expect(mapping.columns.acceptanceDate).toEqual({ index: 4, header });
      expect(mapping.unused).toEqual([]);
    },
  );

  it("maps Acceptance Date and leaves Delivery Date unused when both are present", () => {
    const mapping = mappingOf([...REQUIRED_HEADERS, "Acceptance Date", "Delivery Date"]);
    expect(mapping.columns.acceptanceDate).toEqual({ index: 4, header: "Acceptance Date" });
    expect(mapping.unused).toEqual([{ index: 5, header: "Delivery Date" }]);
  });

  it("maps Acceptance Date when the Delivery Date column comes first", () => {
    const mapping = mappingOf([...REQUIRED_HEADERS, "Delivery Date", "Acceptance Date"]);
    expect(mapping.columns.acceptanceDate).toEqual({ index: 5, header: "Acceptance Date" });
    expect(mapping.unused).toEqual([{ index: 4, header: "Delivery Date" }]);
  });
});

describe("detectHeader: duplicate headers (Requirement 5.7)", () => {
  it.each<[string, string[], string, string]>([
    ["two Delivery_Group columns", ["Delivery Date", "Delivered On"], "Delivery Date", "Delivered On"],
    ["two Acceptance_Group columns", ["Acceptance Date", "Accepted On"], "Acceptance Date", "Accepted On"],
  ])("rejects %s", (_name, extra, first, second) => {
    const errors = errorsOf([...REQUIRED_HEADERS, ...extra]);
    expect(errors).toEqual([
      {
        code: "duplicate_header",
        message: `Columns "${first}" and "${second}" both map to acceptanceDate. Rename or delete one.`,
      },
    ]);
  });

  it("rejects Amount and Total, naming both columns", () => {
    const errors = errorsOf([...REQUIRED_HEADERS, "Total"]);
    expect(errors).toEqual([
      {
        code: "duplicate_header",
        message: 'Columns "Amount" and "Total" both map to amount. Rename or delete one.',
      },
    ]);
  });

  it("names every column when three map to one field", () => {
    const errors = errorsOf([...REQUIRED_HEADERS, "Total", "Bill Amount"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("duplicate_header");
    expect(errors[0]?.message).toBe(
      'Columns "Amount", "Total" and "Bill Amount" all map to amount. Rename or delete one.',
    );
  });
});

describe("detectHeader: missing headers (Requirement 5.9)", () => {
  it("reports each missing field with its aliases", () => {
    const errors = errorsOf(["Invoice No", "Party Name", "Remarks"]);
    expect(errors).toHaveLength(1);
    const error = errors[0];
    expect(error?.code).toBe("missing_headers");
    expect(error?.message).toBe(
      `Missing columns: amount (accepted: ${HEADER_ALIASES.amount.join(", ")}); ` +
        `invoiceDate (accepted: ${HEADER_ALIASES.invoiceDate.join(", ")})`,
    );
  });

  it("reports all four fields for a file with no recognised header", () => {
    const errors = errorsOf(["foo", "bar"]);
    expect(errors[0]?.message).toContain("invoiceNumber (accepted:");
    expect(errors[0]?.message).toContain("buyerName (accepted:");
    expect(errors[0]?.message).toContain("amount (accepted:");
    expect(errors[0]?.message).toContain("invoiceDate (accepted:");
  });

  it("reports missing_headers for an empty table", () => {
    const result = detectHeader([]);
    expect(result.ok).toBe(false);
  });

  it("ignores a valid header on row 21, because only the first 20 rows are scanned", () => {
    const filler = Array.from({ length: 20 }, (_, i) => [`Note ${i + 1}`]);
    const errors = errorsOf(...filler, REQUIRED_HEADERS);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("missing_headers");
    for (const field of REQUIRED_FIELDS) {
      expect(errors[0]?.message).toContain(`${field} (accepted:`);
    }
  });

  it("finds a valid header on row 20", () => {
    const filler = Array.from({ length: 19 }, (_, i) => [`Note ${i + 1}`]);
    const mapping = mappingOf(...filler, REQUIRED_HEADERS);
    expect(mapping.headerRowNumber).toBe(20);
  });
});
