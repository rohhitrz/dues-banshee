import { headerKey } from "./keys";
import type {
  ColumnRef,
  FileError,
  HeaderMapping,
  ImportField,
  RawRow,
  RawTable,
} from "./types";

/** Acceptance_Group: the day of acceptance as written. */
const ACCEPTANCE_GROUP = ["Acceptance Date", "Accepted On", "Date of Acceptance"] as const;

/**
 * Delivery_Group: MSMED Act s.2(b) defines the day of acceptance as the day of
 * actual delivery, so these map to `acceptanceDate` too.
 */
const DELIVERY_GROUP = ["Delivery Date", "Date of Delivery", "Delivered On"] as const;

export const HEADER_ALIASES = {
  invoiceNumber: [
    "Invoice No",
    "Invoice No.",
    "Invoice Number",
    "Invoice #",
    "Bill No",
    "Bill Number",
    "Voucher No",
    "Voucher No.",
    "Voucher Number",
    "Ref. No.",
    "Reference No",
  ],
  buyerName: [
    "Party Name",
    "Party's Name",
    "Buyer",
    "Buyer Name",
    "Customer",
    "Customer Name",
    "Particulars",
  ],
  amount: [
    "Amount",
    "Invoice Value",
    "Invoice Amount",
    "Bill Amount",
    "Total",
    "Gross Total",
    "Pending Amount",
  ],
  invoiceDate: ["Invoice Date", "Bill Date", "Voucher Date", "Date"],
  acceptanceDate: [...ACCEPTANCE_GROUP, ...DELIVERY_GROUP],
  creditDays: ["Credit Days", "Credit Period", "Terms", "Payment Terms"],
} as const satisfies Record<ImportField, readonly string[]>;

export const REQUIRED_FIELDS = ["invoiceNumber", "buyerName", "amount", "invoiceDate"] as const;

/** Rows scanned for the header row. */
const HEADER_SCAN_ROWS = 20;

interface HeaderTarget {
  field: ImportField;
  /** True for a Delivery_Group alias of `acceptanceDate`. */
  delivery: boolean;
}

const DELIVERY_KEYS: ReadonlySet<string> = new Set(DELIVERY_GROUP.map(headerKey));

/** Header_Key -> field. Built once at module load. */
const TARGET_BY_KEY: ReadonlyMap<string, HeaderTarget> = (() => {
  const map = new Map<string, HeaderTarget>();
  for (const field of Object.keys(HEADER_ALIASES) as ImportField[]) {
    for (const alias of HEADER_ALIASES[field]) {
      const key = headerKey(alias);
      map.set(key, { field, delivery: DELIVERY_KEYS.has(key) });
    }
  }
  return map;
})();

interface Hit extends HeaderTarget {
  column: ColumnRef;
}

interface RowScan {
  row: RawRow;
  /** Every non-blank cell, in column order. */
  cells: ColumnRef[];
  hits: Hit[];
  /** Required fields with at least one matching column. */
  requiredMatched: ImportField[];
}

function scanRow(row: RawRow): RowScan {
  const cells: ColumnRef[] = [];
  const hits: Hit[] = [];
  row.cells.forEach((cell, index) => {
    const header = cell.trim();
    if (header === "") return;
    const column: ColumnRef = { index, header };
    cells.push(column);
    const target = TARGET_BY_KEY.get(headerKey(header));
    if (target !== undefined) hits.push({ ...target, column });
  });
  const matched = new Set(hits.map((hit) => hit.field));
  return {
    row,
    cells,
    hits,
    requiredMatched: REQUIRED_FIELDS.filter((field) => matched.has(field)),
  };
}

function quoteList(headers: readonly string[]): string {
  const quoted = headers.map((h) => `"${h}"`);
  const last = quoted[quoted.length - 1] ?? "";
  if (quoted.length === 1) return last;
  return `${quoted.slice(0, -1).join(", ")} and ${last}`;
}

function duplicateError(field: ImportField, hits: readonly Hit[]): FileError {
  const verb = hits.length === 2 ? "both map to" : "all map to";
  return {
    code: "duplicate_header",
    message: `Columns ${quoteList(hits.map((h) => h.column.header))} ${verb} ${field}. Rename or delete one.`,
  };
}

function missingError(scan: RowScan | undefined): FileError {
  const matched = new Set(scan?.requiredMatched ?? []);
  const parts = REQUIRED_FIELDS.filter((field) => !matched.has(field)).map(
    (field) => `${field} (accepted: ${HEADER_ALIASES[field].join(", ")})`,
  );
  return { code: "missing_headers", message: `Missing columns: ${parts.join("; ")}` };
}

/**
 * Finds the header row in the first 20 rows and maps its columns.
 *
 * 1. Each row's non-blank cells are matched by Header_Key. The row with the most
 *    required fields (first on a tie) is remembered.
 * 2. At the first row matching all four required fields, conflicts are
 *    resolved and the scan stops. One column per field is mapped. Exactly one
 *    Acceptance_Group plus exactly one Delivery_Group column maps the
 *    acceptance column and leaves the delivery column unused. Any other
 *    repeated field is a `duplicate_header` error naming every column.
 * 3. With no qualifying row, `missing_headers` is reported against the best row.
 * 4. `unused` is every other non-blank header cell.
 */
export function detectHeader(
  table: RawTable,
): { ok: true; mapping: HeaderMapping } | { ok: false; errors: FileError[] } {
  let best: RowScan | undefined;
  let qualifying: RowScan | undefined;

  for (const row of table.slice(0, HEADER_SCAN_ROWS)) {
    const scan = scanRow(row);
    if (best === undefined || scan.requiredMatched.length > best.requiredMatched.length) {
      best = scan;
    }
    if (scan.requiredMatched.length === REQUIRED_FIELDS.length) {
      qualifying = scan;
      break;
    }
  }

  if (qualifying === undefined) return { ok: false, errors: [missingError(best)] };

  const byField = new Map<ImportField, Hit[]>();
  for (const hit of qualifying.hits) {
    const list = byField.get(hit.field);
    if (list === undefined) byField.set(hit.field, [hit]);
    else list.push(hit);
  }

  const columns: { [F in ImportField]?: ColumnRef } = {};
  const errors: FileError[] = [];
  const mappedIndexes = new Set<number>();

  for (const [field, hits] of byField) {
    let chosen: Hit | undefined;
    if (hits.length === 1) {
      chosen = hits[0];
    } else if (
      field === "acceptanceDate" &&
      hits.length === 2 &&
      hits.filter((h) => h.delivery).length === 1
    ) {
      chosen = hits.find((h) => !h.delivery);
    } else {
      errors.push(duplicateError(field, hits));
      continue;
    }
    if (chosen !== undefined) {
      columns[field] = chosen.column;
      mappedIndexes.add(chosen.column.index);
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    mapping: {
      headerRowNumber: qualifying.row.rowNumber,
      columns,
      unused: qualifying.cells.filter((cell) => !mappedIndexes.has(cell.index)),
    },
  };
}
