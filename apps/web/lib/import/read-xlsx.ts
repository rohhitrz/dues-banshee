import ExcelJS from "exceljs";
import type { RawRow, RawTable } from "@dues-banshee/ledger";
import { HEADER_SCAN_ROWS, MAX_COLUMNS, MAX_DATA_ROWS, MAX_SHEET_XML_BYTES } from "./limits";

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
export type ReadXlsxLimits = { maxSheetXmlBytes?: number; maxRows?: number; maxColumns?: number };
const SHEET_PART = /^xl\/worksheets\/[^/]+\.xml$/;
/**
 * Largest declared uncompressed size of a worksheet part, read from the zip central directory
 * without inflating anything. A zip64 entry (size field 0xFFFFFFFF) counts as infinite.
 * shortcut: the declared size is the writer's claim; jszip still inflates what is really there,
 * so a lying header is only bounded by the 4 MB upload cap and its deflate ratio.
 */
export function declaredSheetXmlBytes(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("no zip directory");
  const entries = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  let largest = 0;
  for (let n = 0; n < entries; n += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new Error("bad zip directory");
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (SHEET_PART.test(name)) largest = Math.max(largest, size === 0xffffffff ? Infinity : size);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return largest;
}
/**
 * Reads the first worksheet of an XLSX file into a Raw_Table. Row numbers are the
 * worksheet's own, so they match the numbers Excel shows. Rejects when the bytes
 * are not a loadable workbook, with `SheetTooLargeError` before anything is inflated
 * and `TooManyRowsError` as soon as the row cap is passed.
 * Cells beyond `maxColumns` are ignored.
 */
export async function readXlsx(bytes: Uint8Array, limits: ReadXlsxLimits = {}): Promise<RawTable> {
  const maxSheetXmlBytes = limits.maxSheetXmlBytes ?? MAX_SHEET_XML_BYTES;
  const maxRows = limits.maxRows ?? MAX_DATA_ROWS + HEADER_SCAN_ROWS;
  const maxColumns = limits.maxColumns ?? MAX_COLUMNS;
  if (declaredSheetXmlBytes(bytes) > maxSheetXmlBytes) throw new SheetTooLargeError();
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
