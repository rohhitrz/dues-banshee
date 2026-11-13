import { deflateRawSync } from "node:zlib";
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

/** CRC-32 of `data`, as stored in a zip entry header. */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

type RawZipEntry = { name: string; data: Uint8Array; method?: 0 | 8 };

/**
 * Writes a zip by hand. jszip drops an entry named "" when it generates a zip, so a zip that
 * contains one can only be made this way. `method` 8 deflates the data, 0 stores it.
 */
function rawZip(entries: RawZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const push = (chunk: Uint8Array): void => {
    chunks.push(chunk);
    offset += chunk.length;
  };
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const method = entry.method ?? 8;
    const body = method === 8 ? new Uint8Array(deflateRawSync(entry.data)) : entry.data;
    const crc = crc32(entry.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, method, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, entry.data.length, true);
    local.setUint16(26, name.length, true);
    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 20, true);
    header.setUint16(10, method, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, body.length, true);
    header.setUint32(24, entry.data.length, true);
    header.setUint16(28, name.length, true);
    header.setUint32(42, offset, true);
    central.push(new Uint8Array(header.buffer), name);
    push(new Uint8Array(local.buffer));
    push(name);
    push(body);
  }
  const centralStart = offset;
  for (const chunk of central) push(chunk);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, offset - centralStart, true);
  end.setUint32(16, centralStart, true);
  push(new Uint8Array(end.buffer));
  const out = new Uint8Array(offset);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

describe("readXlsx zip edge cases", () => {
  const MiB = 1024 * 1024;
  const slow = 30_000;
  const EXPECTED_TABLE = [
    { rowNumber: 1, cells: ["Invoice No", "Party Name", "Amount", "Invoice Date"] },
    { rowNumber: 2, cells: ["INV-1", "Sharma Traders", "1000", "2026-09-02"] },
  ];

  const validZip = async (): Promise<JSZip> => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sales");
    sheet.addRow(["Invoice No", "Party Name", "Amount", "Invoice Date"]);
    sheet.addRow(["INV-1", "Sharma Traders", 1000, "2026-09-02"]);
    return JSZip.loadAsync(await workbook.xlsx.writeBuffer());
  };
  /** The entries of a valid workbook, ready for `rawZip`. */
  const validEntries = async (): Promise<RawZipEntry[]> => {
    const zip = await validZip();
    const entries: RawZipEntry[] = [];
    for (const entry of Object.values(zip.files)) {
      if (!entry.dir) entries.push({ name: entry.name, data: await entry.async("uint8array") });
    }
    return entries;
  };

  it("counts an entry named \"\" that zip.forEach skips: a 21 MiB one is SheetTooLargeError and a 422", async () => {
    const bytes = rawZip([...(await validEntries()), { name: "", data: new Uint8Array(21 * MiB).fill(0x61) }]);
    expect(bytes.length).toBeLessThan(MAX_UPLOAD_BYTES);
    const zip = await JSZip.loadAsync(bytes);
    let visited = 0;
    zip.forEach(() => {
      visited += 1;
    });
    expect(Object.values(zip.files).some((entry) => entry.name === "" && !entry.dir)).toBe(true);
    expect(visited).toBe(Object.values(zip.files).length - 1); // forEach really does skip it
    await expect(readXlsx(bytes)).rejects.toBeInstanceOf(SheetTooLargeError);
    const result = await readUpload(new File([bytes as BlobPart], "bomb.xlsx"));
    expect(result).toEqual({ ok: false, status: 422, message: sheetTooLargeMessage() });
  }, slow);

  it("parses a workbook that also has a zero-byte entry", async () => {
    const zip = await validZip();
    zip.file("docProps/empty.xml", new Uint8Array(0));
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    expect(await readXlsx(bytes)).toEqual(EXPECTED_TABLE);
    expect(await readOk(new File([bytes as BlobPart], "ledger.xlsx"))).toEqual(EXPECTED_TABLE);
  });

  it("parses a workbook whose entries are STORE (uncompressed)", async () => {
    const zip = await validZip();
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "STORE" });
    expect(await readXlsx(bytes)).toEqual(EXPECTED_TABLE);
    expect(await readOk(new File([bytes as BlobPart], "ledger.xlsx"))).toEqual(EXPECTED_TABLE);
  });

  it("returns the invalid-file 422, not a throw, when one entry's deflate bytes are corrupted", async () => {
    const zip = await validZip();
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    // jszip writes sizes in the local header (no data descriptor), so the first entry's data is easy to find.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(8, true)).toBe(8); // deflate
    const compressedSize = view.getUint32(18, true);
    const dataStart = 30 + view.getUint16(26, true) + view.getUint16(28, true);
    expect(compressedSize).toBeGreaterThan(0);
    // 0xFF starts a deflate block of the reserved type 3, which no inflater accepts.
    bytes.fill(0xff, dataStart, dataStart + compressedSize);
    await expect(readXlsx(bytes)).rejects.toThrow();
    const result = await readUpload(new File([bytes as BlobPart], "corrupt.xlsx"));
    expect(result).toEqual({ ok: false, status: 422, message: "Not a valid XLSX file" });
  });

  it("returns the invalid-file 422 for random bytes named .xlsx, with or without the PK header", async () => {
    let seed = 12345;
    const random = (size: number): Uint8Array => {
      const out = new Uint8Array(size);
      for (let i = 0; i < size; i += 1) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        out[i] = seed >>> 24;
      }
      return out;
    };
    const plain = random(4096);
    const withMagic = random(4096);
    withMagic.set([0x50, 0x4b, 0x03, 0x04]);
    for (const bytes of [plain, withMagic]) {
      const result = await readUpload(new File([bytes as BlobPart], "noise.xlsx"));
      expect(result).toEqual({ ok: false, status: 422, message: "Not a valid XLSX file" });
    }
  });
});
