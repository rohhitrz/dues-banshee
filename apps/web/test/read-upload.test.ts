import { buildImport, type RawTable, type SupplierFacts } from "@dues-banshee/ledger";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { MAX_COLUMNS, MAX_DATA_ROWS, MAX_UPLOAD_BYTES, MAX_XLSX_INFLATED_BYTES, sheetTooLargeMessage, tooManyRowsMessage } from "@/lib/import/limits";
import { readUpload } from "@/lib/import/read-upload";
import { readXlsx, SheetTooLargeError, TooManyRowsError } from "@/lib/import/read-xlsx";

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

describe("readXlsx limits", () => {
  const build = async (fill: (sheet: ExcelJS.Worksheet) => void): Promise<Uint8Array> => {
    const workbook = new ExcelJS.Workbook();
    fill(workbook.addWorksheet("Sales"));
    return new Uint8Array(await workbook.xlsx.writeBuffer());
  };

  it("stops at the row cap instead of converting every row", async () => {
    const bytes = await build((sheet) => {
      for (let i = 1; i <= 200; i += 1) sheet.addRow([`INV-${i}`, "A", 1]);
    });
    const error = await readXlsx(bytes, { maxRows: 10 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TooManyRowsError);
    expect((error as TooManyRowsError).rowsRead).toBe(11);
  });

  it("returns 422 with the row message when an XLSX has too many rows", async () => {
    const bytes = await build((sheet) => {
      for (let i = 1; i <= MAX_DATA_ROWS + 25; i += 1) sheet.addRow([i]);
    });
    const result = await readUpload(new File([bytes as BlobPart], "big.xlsx"));
    expect(result).toEqual({ ok: false, status: 422, message: tooManyRowsMessage() });
  });

  it("ignores cells beyond MAX_COLUMNS and stays fast with a cell in column XFD", async () => {
    const bytes = await build((sheet) => {
      sheet.addRow(["Invoice No", "Party Name", "Amount", "Invoice Date"]);
      for (let i = 1; i <= 5000; i += 1) sheet.addRow([`INV-${i}`, "Sharma Traders", 1000, "2026-09-02"]);
      sheet.getCell("XFD3").value = "stray";
    });
    const started = performance.now();
    const result = await readUpload(new File([bytes as BlobPart], "wide.xlsx"));
    const elapsed = performance.now() - started;
    if (!result.ok) throw new Error(result.message);
    expect(result.table).toHaveLength(5001);
    expect(result.table.every((r) => r.cells.length <= MAX_COLUMNS)).toBe(true);
    expect(result.table.find((r) => r.rowNumber === 3)?.cells).toHaveLength(MAX_COLUMNS);
    expect(result.table.find((r) => r.rowNumber === 3)?.cells.includes("stray")).toBe(false);
    expect(elapsed).toBeLessThan(5000);
  });
});

describe("readXlsx inflated-size cap (all zip entries, real bytes)", () => {
  const MiB = 1024 * 1024;
  const over = 21 * MiB;
  const slow = 30_000;

  const validXlsx = async (): Promise<Uint8Array> => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sales");
    sheet.addRow(["Invoice No", "Party Name", "Amount", "Invoice Date"]);
    sheet.addRow(["INV-1", "Sharma Traders", 1000, "2026-09-02"]);
    return new Uint8Array(await workbook.xlsx.writeBuffer());
  };
  const filler = (size: number): Uint8Array => new Uint8Array(size).fill(0x61);
  const zipped = (zip: JSZip): Promise<Uint8Array> =>
    zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  /** A valid workbook plus one extra entry of `size` repeated bytes. It deflates to a few tens of KB. */
  const withEntry = async (name: string, size: number): Promise<Uint8Array> => {
    const zip = await JSZip.loadAsync(await validXlsx());
    zip.file(name, filler(size));
    return zipped(zip);
  };

  it.each([
    ["xl/sharedStrings.xml", "xl/sharedStrings.xml"],
    ["a worksheet named with a leading slash", "/xl/worksheets/sheet1.xml"],
    ["docProps/custom.xml", "docProps/custom.xml"],
  ])("rejects 21 MiB in %s", async (_label, name) => {
    const bytes = await withEntry(name, over);
    expect(bytes.length).toBeLessThan(MAX_UPLOAD_BYTES);
    await expect(readXlsx(bytes)).rejects.toBeInstanceOf(SheetTooLargeError);
    const result = await readUpload(new File([bytes as BlobPart], "bomb.xlsx"));
    expect(result).toEqual({ ok: false, status: 422, message: sheetTooLargeMessage() });
  }, slow);

  it("rejects a hidden second entry when the end-of-directory record claims only one entry", async () => {
    const zip = new JSZip();
    zip.file("a.xml", "<a/>");
    zip.file("b.xml", filler(over));
    const bytes = await zipped(zip);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = bytes.length - 22; // no zip comment, so the record is the last 22 bytes
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    expect(view.getUint16(eocd + 10, true)).toBe(2);
    view.setUint16(eocd + 8, 1, true); // entries on this disk
    view.setUint16(eocd + 10, 1, true); // total entries
    await expect(readXlsx(bytes)).rejects.toBeInstanceOf(SheetTooLargeError);
  }, slow);

  it("still parses the valid XLSX rows", async () => {
    const table = await readXlsx(await validXlsx());
    expect(table).toEqual([
      { rowNumber: 1, cells: ["Invoice No", "Party Name", "Amount", "Invoice Date"] },
      { rowNumber: 2, cells: ["INV-1", "Sharma Traders", "1000", "2026-09-02"] },
    ]);
  });

  it("parses a valid sheet when the inflated total is one byte under the cap", async () => {
    const zip = await JSZip.loadAsync(await validXlsx());
    let existing = 0;
    for (const entry of Object.values(zip.files)) {
      if (!entry.dir) existing += (await entry.async("uint8array")).length;
    }
    const extra = MAX_XLSX_INFLATED_BYTES - 1 - existing;
    expect(extra).toBeGreaterThan(0);
    zip.file("docProps/custom.xml", filler(extra));
    const table = await readXlsx(await zipped(zip));
    expect(table.map((r) => r.rowNumber)).toEqual([1, 2]);
  }, slow);

  it("rejects when the inflated total is exactly one byte over the cap", async () => {
    const zip = await JSZip.loadAsync(await validXlsx());
    let existing = 0;
    for (const entry of Object.values(zip.files)) {
      if (!entry.dir) existing += (await entry.async("uint8array")).length;
    }
    zip.file("docProps/custom.xml", filler(MAX_XLSX_INFLATED_BYTES + 1 - existing));
    await expect(readXlsx(await zipped(zip))).rejects.toBeInstanceOf(SheetTooLargeError);
  }, slow);
});
