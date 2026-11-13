import { parseCsv, type RawTable } from "@dues-banshee/ledger";
import {
  HEADER_SCAN_ROWS,
  MAX_DATA_ROWS,
  MAX_UPLOAD_BYTES,
  sheetTooLargeMessage,
  tooManyRowsMessage,
  uploadTooLargeMessage,
} from "./limits";
import { readXlsx, SheetTooLargeError, TooManyRowsError } from "./read-xlsx";

export type ReadUploadResult =
  | { ok: true; table: RawTable }
  | { ok: false; status: number; message: string };


/** "PK\x03\x04", the start of every zip archive and so of every XLSX file. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;

const fail = (status: number, message: string): ReadUploadResult => ({ ok: false, status, message });

const hasZipMagic = (bytes: Uint8Array): boolean => ZIP_MAGIC.every((byte, i) => bytes[i] === byte);

/** Turns an uploaded file into a Raw_Table, or an HTTP status and message. Checks run in this order. */
export async function readUpload(file: File | null): Promise<ReadUploadResult> {
  if (!file || file.size > MAX_UPLOAD_BYTES) return fail(413, uploadTooLargeMessage());

  const name = file.name.toLowerCase();
  let table: RawTable;

  if (name.endsWith(".csv")) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return fail(422, "File is not UTF-8 text");
    }
    const parsed = parseCsv(text);
    if (!parsed.ok) return fail(422, parsed.error.message);
    table = parsed.table;
  } else if (name.endsWith(".xlsx")) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!hasZipMagic(bytes)) return fail(422, "Not a valid XLSX file");
    try {
      table = await readXlsx(bytes);
    } catch (error) {
      if (error instanceof SheetTooLargeError) return fail(422, sheetTooLargeMessage());
      if (error instanceof TooManyRowsError) return fail(422, tooManyRowsMessage());
      return fail(422, "Not a valid XLSX file");
    }
  } else {
    return fail(415, "Upload a .csv or .xlsx file");
  }

  if (table.length > MAX_DATA_ROWS + HEADER_SCAN_ROWS) return fail(422, tooManyRowsMessage());
  return { ok: true, table };
}
