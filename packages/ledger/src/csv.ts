import type { FileError, RawRow, RawTable } from "./types";

const BOM = "\uFEFF";
const QUOTE = '"';
const COMMA = ",";
const LF = "\n";
const CR = "\r";

/**
 * Parses CSV text (RFC 4180) into a Raw_Table of plain-string cells.
 *
 * - A leading U+FEFF byte-order mark is removed.
 * - The delimiter is a comma.
 * - A field that starts with `"` is quoted: `""` means `"`, and commas and
 *   line breaks inside it are kept.
 * - Records end at CRLF, LF or a lone CR. A final line break does not create
 *   an empty record.
 * - An unterminated quote returns a `csv_syntax` error naming the record.
 * - No type inference: every cell is the text as written.
 *
 * `rowNumber` is the 1-based record number, so a quoted cell that spans two
 * text lines still counts as one row, as it does in Excel.
 */
export function parseCsv(
  text: string,
): { ok: true; table: RawTable } | { ok: false; error: FileError } {
  const input = text.startsWith(BOM) ? text.slice(BOM.length) : text;

  const rows: RawRow[] = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  /** Record number in which the currently open quote began. */
  let quoteOpenedIn = 0;
  /** True until the first character of a record is consumed. */
  let atRecordStart = true;
  /** True when the current field began with a quote (so `""` is a real empty cell). */
  let fieldIsQuoted = false;

  const endField = (): void => {
    cells.push(field);
    field = "";
    fieldIsQuoted = false;
  };
  const endRecord = (): void => {
    endField();
    rows.push({ rowNumber: rows.length + 1, cells });
    cells = [];
    atRecordStart = true;
  };

  let i = 0;
  while (i < input.length) {
    const ch = input.charAt(i);

    if (inQuotes) {
      if (ch === QUOTE) {
        if (input.charAt(i + 1) === QUOTE) {
          field += QUOTE;
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }

    if (ch === COMMA) {
      endField();
      atRecordStart = false;
      i += 1;
    } else if (ch === LF) {
      endRecord();
      i += 1;
    } else if (ch === CR) {
      endRecord();
      i += input.charAt(i + 1) === LF ? 2 : 1;
    } else if (ch === QUOTE && field === "" && !fieldIsQuoted) {
      inQuotes = true;
      fieldIsQuoted = true;
      quoteOpenedIn = rows.length + 1;
      atRecordStart = false;
      i += 1;
    } else {
      // A quote in the middle of an unquoted field, or text after a closing
      // quote, is kept literally.
      field += ch;
      atRecordStart = false;
      i += 1;
    }
  }

  if (inQuotes) {
    return {
      ok: false,
      error: {
        code: "csv_syntax",
        message: `Unterminated quoted field in row ${quoteOpenedIn}: the closing " is missing`,
      },
    };
  }

  // Final record without a trailing line break. Nothing is added after a
  // final line break, because the record was already ended there.
  if (!atRecordStart) endRecord();

  return { ok: true, table: rows };
}
