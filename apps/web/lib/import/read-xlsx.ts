import ExcelJS from "exceljs";
import type { RawRow, RawTable } from "@dues-banshee/ledger";
import JSZip from "jszip";
import { HEADER_SCAN_ROWS, MAX_COLUMNS, MAX_DATA_ROWS, MAX_XLSX_INFLATED_BYTES } from "./limits";

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Converts one exceljs cell value to text (Requirement 5.2).
 *
 * Numbers use `String(value)`, never the cell's display text, so a number format
 * such as `#,##0` can't round paise away. Dates use the UTC year, month and day.
 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  if (typeof value === "string" || typeof value === "boolean") return String(value);
  if (value instanceof Date) {
    return `${pad(value.getUTCFullYear(), 4)}-${pad(value.getUTCMonth() + 1, 2)}-${pad(value.getUTCDate(), 2)}`;
  }
  if (!isRecord(value)) return "";
  if ("formula" in value || "sharedFormula" in value) return cellText(value["result"]);
  if (Array.isArray(value["richText"])) {
    return value["richText"]
      .map((part: unknown) => (isRecord(part) && typeof part["text"] === "string" ? part["text"] : ""))
      .join("");
  }
  if ("hyperlink" in value) return cellText(value["text"]);
  if (typeof value["error"] === "string") return value["error"];
  return "";
}

export class SheetTooLargeError extends Error {}
export class TooManyRowsError extends Error {
  constructor(readonly rowsRead: number) {
    super("too many rows");
  }
}
export type ReadXlsxLimits = { maxRows?: number; maxColumns?: number };

/** The part of jszip's stream helper used here. `internalStream` is public API but missing from jszip's typings. */
type EntryStream = {
  on(event: "data", listener: (chunk: Uint8Array) => void): EntryStream;
  on(event: "error", listener: (error: Error) => void): EntryStream;
  on(event: "end", listener: () => void): EntryStream;
  pause(): EntryStream;
  resume(): EntryStream;
};
type StreamableEntry = JSZip.JSZipObject & { internalStream(type: "uint8array"): EntryStream };

/**
 * Inflates every non-directory entry of the zip, counting the bytes that really come out, and
 * throws `SheetTooLargeError` as soon as the running total passes `maxBytes`. Sizes and the entry
 * count in the zip headers are never read. The entries are `Object.values(zip.files)`, the list
 * exceljs iterates and inflates (exceljs loads the same jszip), so a hidden entry, a lying entry
 * count or an odd entry name (even an empty one) cannot dodge the check. Each entry is streamed, so at most one inflate chunk is held beyond the cap.
 */
async function assertInflatedWithin(bytes: Uint8Array, maxBytes: number): Promise<void> {
  const zip = await JSZip.loadAsync(bytes);
  // Not zip.forEach: it skips an entry whose name is "", which exceljs still inflates.
  const entries = Object.values(zip.files).filter((entry) => !entry.dir) as StreamableEntry[];
  let total = 0;
  for (const entry of entries) {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const stream = entry.internalStream("uint8array");
      stream
        .on("data", (chunk) => {
          if (settled) return;
          total += chunk.length;
          if (total > maxBytes) {
            settled = true;
            stream.pause();
            reject(new SheetTooLargeError());
          }
        })
        .on("error", (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        })
        .on("end", () => {
          if (settled) return;
          settled = true;
          resolve();
        })
        .resume();
    });
  }
}

/**
 * Reads the first worksheet of an XLSX file into a Raw_Table. Row numbers are the
 * worksheet's own, so they match the numbers Excel shows. Rejects when the bytes
 * are not a loadable workbook, with `SheetTooLargeError` when the zip inflates past
 * `MAX_XLSX_INFLATED_BYTES` (checked before exceljs parses anything) and `TooManyRowsError`
 * as soon as the row cap is passed. Cells beyond `maxColumns` are ignored.
 * shortcut: the row and column caps apply inside `eachRow`, after exceljs has loaded the sheet;
 * the inflated-size cap is what bounds that work.
 */
export async function readXlsx(bytes: Uint8Array, limits: ReadXlsxLimits = {}): Promise<RawTable> {
  const maxRows = limits.maxRows ?? MAX_DATA_ROWS + HEADER_SCAN_ROWS;
  const maxColumns = limits.maxColumns ?? MAX_COLUMNS;
  await assertInflatedWithin(bytes, MAX_XLSX_INFLATED_BYTES);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];
  const rows: RawRow[] = [];
  // eachRow is a plain loop, so throwing stops it; no row past the cap is converted.
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rows.length >= maxRows) throw new TooManyRowsError(rows.length + 1);
    const cells: string[] = [];
    const last = Math.min(row.cellCount, maxColumns);
    for (let column = 1; column <= last; column += 1) {
      cells.push(cellText(row.getCell(column).value));
    }
    rows.push({ rowNumber, cells });
  });
  return rows;
}
