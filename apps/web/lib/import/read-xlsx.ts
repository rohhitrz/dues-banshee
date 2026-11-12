import ExcelJS from "exceljs";
import type { RawRow, RawTable } from "@dues-banshee/ledger";

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

/**
 * Reads the first worksheet of an XLSX file into a Raw_Table. Row numbers are the
 * worksheet's own, so they match the numbers Excel shows. Rejects when the bytes
 * are not a loadable workbook.
 */
export async function readXlsx(bytes: Uint8Array): Promise<RawTable> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const rows: RawRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells: string[] = [];
    for (let column = 1; column <= row.cellCount; column += 1) {
      cells.push(cellText(row.getCell(column).value));
    }
    rows.push({ rowNumber, cells });
  });
  return rows;
}
