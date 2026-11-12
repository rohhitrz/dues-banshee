import { buildImport, type RawTable, type SupplierFacts } from "@dues-banshee/ledger";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { MAX_DATA_ROWS, MAX_UPLOAD_BYTES } from "@/lib/import/limits";
import { readUpload } from "@/lib/import/read-upload";

const SUPPLIER: SupplierFacts = {
  id: "supplier-1",
  supplierCategory: "micro",
  supplierActivity: "manufacturing",
};

const HEADER = "Invoice No,Party Name,Amount,Invoice Date";

const csvFile = (text: string, name = "ledger.csv"): File => new File([text], name, { type: "text/csv" });

/** A CSV with a header row and `dataRows` valid data rows. */
function csvWithDataRows(dataRows: number): string {
  const lines = [HEADER];
  for (let i = 1; i <= dataRows; i += 1) lines.push(`INV-${i},Sharma Traders,1000,2026-09-02`);
  return lines.join("\n");
}

async function readOk(file: File): Promise<RawTable> {
  const result = await readUpload(file);
  if (!result.ok) throw new Error(`readUpload failed: ${result.status} ${result.message}`);
  return result.table;
}

describe("MAX_UPLOAD_BYTES", () => {
  it("is 4 MB", () => {
    expect(MAX_UPLOAD_BYTES).toBe(4 * 1024 * 1024);
  });
});

describe("readUpload, XLSX cells (Requirements 5.2, 5.3)", () => {
  it("reads numbers, dates and formula results as text that buildImport turns into exact values", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sales");
    sheet.addRow(["Invoice No", "Party Name", "Amount", "Invoice Date", "Credit Days"]);
    const row = sheet.addRow([
      "LPC/26-27/0412",
      "Sharma Traders",
      412000.6,
      new Date(Date.UTC(2026, 8, 2)),
      { formula: "15+30", result: 45 },
    ]);
    row.getCell(3).numFmt = "#,##0";
    const buffer = await workbook.xlsx.writeBuffer();

    const table = await readOk(new File([buffer], "ledger.xlsx"));

    const dataRow = table.find((r) => r.rowNumber === 2);
    expect(dataRow?.cells).toEqual(["LPC/26-27/0412", "Sharma Traders", "412000.6", "2026-09-02", "45"]);

    const parsed = buildImport(table, SUPPLIER);
    if (!parsed.ok) throw new Error(`buildImport failed: ${JSON.stringify(parsed.fileErrors)}`);
    const [result] = parsed.rows;
    if (!result?.ok) throw new Error(`row did not map: ${JSON.stringify(result)}`);
    expect(result.invoice.amountPaise).toBe(41_200_060);
    expect(result.invoiceDate).toBe("2026-09-02");
    expect(result.invoice.agreedTermDays).toBe(45);
  });
});

describe("readUpload, rejected files (Requirement 13.2)", () => {
  it("returns 413 for a file of 4 MB + 1 byte", async () => {
    const file = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], "big.csv");
    const result = await readUpload(file);
    expect(result).toEqual({ ok: false, status: 413, message: "File is larger than 4 MB" });
  });

  it("accepts a file of exactly 4 MB at the size check", async () => {
    const file = new File([new Uint8Array(MAX_UPLOAD_BYTES).fill(0x61)], "edge.csv");
    const result = await readUpload(file);
    expect(result.ok || result.status !== 413).toBe(true);
  });

  it("returns 415 for a .txt file", async () => {
    const result = await readUpload(csvFile(csvWithDataRows(1), "ledger.txt"));
    expect(result).toEqual({ ok: false, status: 415, message: "Upload a .csv or .xlsx file" });
  });

  it("returns 422 for a CSV that is not valid UTF-8", async () => {
    const file = new File([new Uint8Array([0x41, 0x2c, 0xff, 0xfe, 0x0a])], "bad.csv");
    const result = await readUpload(file);
    expect(result).toEqual({ ok: false, status: 422, message: "File is not UTF-8 text" });
  });

  it("returns 422 for an .xlsx file without the PK header", async () => {
    const file = new File([csvWithDataRows(2)], "fake.xlsx");
    const result = await readUpload(file);
    expect(result).toEqual({ ok: false, status: 422, message: "Not a valid XLSX file" });
  });

  it("returns 422 for a table far past the row limit before any row is mapped", async () => {
    const result = await readUpload(csvFile(csvWithDataRows(MAX_DATA_ROWS + 21)));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(422);
  });
});

describe("5,001 data rows (Requirement 13.2)", () => {
  // `readUpload` only applies a coarse guard (MAX_DATA_ROWS + 20 rows, so a Tally file with
  // title rows above the header still passes). The exact count is checked after `buildImport`,
  // in `analyseUpload` (design: analyse.ts step 4, which answers 422).
  it("passes the coarse guard, then exceeds MAX_DATA_ROWS in the exact count", async () => {
    const table = await readOk(csvFile(csvWithDataRows(MAX_DATA_ROWS + 1)));
    const parsed = buildImport(table, SUPPLIER);
    if (!parsed.ok) throw new Error(`buildImport failed: ${JSON.stringify(parsed.fileErrors)}`);
    expect(parsed.rows).toHaveLength(MAX_DATA_ROWS + 1);
    expect(parsed.rows.length > MAX_DATA_ROWS).toBe(true);
  });

  it("keeps a file of exactly MAX_DATA_ROWS data rows within the limit", async () => {
    const table = await readOk(csvFile(csvWithDataRows(MAX_DATA_ROWS)));
    const parsed = buildImport(table, SUPPLIER);
    if (!parsed.ok) throw new Error(`buildImport failed: ${JSON.stringify(parsed.fileErrors)}`);
    expect(parsed.rows.length > MAX_DATA_ROWS).toBe(false);
  });
});
