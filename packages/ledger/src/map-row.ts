import { ValidationError, validateInvoice } from "@dues-banshee/engine";
import type { CalendarDate, Invoice, Paise } from "@dues-banshee/engine";
import { parseAmountLenient } from "./amount";
import { parseCreditDays } from "./credit-days";
import { parseDateLenient } from "./date";
import { dedupeKey } from "./keys";
import type {
  ColumnRef,
  HeaderMapping,
  ImportField,
  RawRow,
  RowError,
  RowResult,
  SupplierFacts,
} from "./types";

/** MSMED-15 caps the agreed credit term at 45 days. */
const MAX_TERM_DAYS = 45;

/** Reads a cell by column; a cell missing from a short row reads as "". */
function cellAt(row: RawRow, column: ColumnRef | undefined): string {
  if (column === undefined) return "";
  return row.cells[column.index] ?? "";
}

/** Required fields are always mapped by `detectHeader`; a miss here is a bug. */
function requiredColumn(mapping: HeaderMapping, field: ImportField): ColumnRef {
  const column = mapping.columns[field];
  if (column === undefined) {
    throw new Error(`mapRow: header mapping has no column for required field "${field}"`);
  }
  return column;
}

/**
 * Maps one data row to an Engine invoice.
 *
 * 1. Every field is parsed and every error is collected, each against the
 *    column header as written in the file.
 * 2. Any error returns `{ ok: false }`.
 * 3. The Invoice is built from the supplier record only. `agreedTermDays` is
 *    omitted when blank. A blank or absent acceptance date defaults to the
 *    invoice date and sets `acceptanceDateDefaulted`.
 * 4. The Engine's `validateInvoice` has the last word. Its `amountPaise`,
 *    `acceptedOn` and `agreedTermDays` errors are mapped back to columns; any
 *    other error is a bug and is rethrown.
 * 5. A term above 45 days adds an MSMED-15 warning.
 */
export function mapRow(row: RawRow, mapping: HeaderMapping, supplier: SupplierFacts): RowResult {
  const errors: RowError[] = [];

  const invoiceNumberColumn = requiredColumn(mapping, "invoiceNumber");
  const buyerNameColumn = requiredColumn(mapping, "buyerName");
  const amountColumn = requiredColumn(mapping, "amount");
  const invoiceDateColumn = requiredColumn(mapping, "invoiceDate");
  const acceptanceColumn = mapping.columns.acceptanceDate;
  const creditDaysColumn = mapping.columns.creditDays;

  const invoiceNumber = cellAt(row, invoiceNumberColumn).trim();
  if (invoiceNumber === "") {
    errors.push({ column: invoiceNumberColumn.header, reason: "is required" });
  }

  const buyerName = cellAt(row, buyerNameColumn).trim();
  if (buyerName === "") {
    errors.push({ column: buyerNameColumn.header, reason: "is required" });
  }

  let amountPaise: Paise | undefined;
  const amountCell = cellAt(row, amountColumn);
  if (amountCell.trim() === "") {
    errors.push({ column: amountColumn.header, reason: "is required" });
  } else {
    const parsed = parseAmountLenient(amountCell);
    if (parsed instanceof ValidationError) {
      errors.push({ column: amountColumn.header, reason: parsed.reason });
    } else {
      amountPaise = parsed;
    }
  }

  let invoiceDate: CalendarDate | undefined;
  const invoiceDateCell = cellAt(row, invoiceDateColumn);
  if (invoiceDateCell.trim() === "") {
    errors.push({ column: invoiceDateColumn.header, reason: "is required" });
  } else {
    const parsed = parseDateLenient(invoiceDateCell);
    if (parsed instanceof ValidationError) {
      errors.push({ column: invoiceDateColumn.header, reason: parsed.reason });
    } else {
      invoiceDate = parsed;
    }
  }

  let acceptanceDate: CalendarDate | undefined;
  const acceptanceCell = cellAt(row, acceptanceColumn);
  if (acceptanceColumn !== undefined && acceptanceCell.trim() !== "") {
    const parsed = parseDateLenient(acceptanceCell);
    if (parsed instanceof ValidationError) {
      errors.push({ column: acceptanceColumn.header, reason: parsed.reason });
    } else {
      acceptanceDate = parsed;
    }
  }

  let agreedTermDays: number | undefined;
  if (creditDaysColumn !== undefined) {
    const parsed = parseCreditDays(cellAt(row, creditDaysColumn));
    if (parsed instanceof ValidationError) {
      errors.push({ column: creditDaysColumn.header, reason: parsed.reason });
    } else {
      agreedTermDays = parsed;
    }
  }

  if (errors.length > 0) return { ok: false, rowNumber: row.rowNumber, errors };
  if (amountPaise === undefined || invoiceDate === undefined) {
    throw new Error("mapRow: a parsed field is missing although no error was recorded");
  }

  const key = dedupeKey(supplier.id, buyerName, invoiceNumber);
  const acceptanceDateDefaulted = acceptanceDate === undefined;
  const acceptedOn = acceptanceDate ?? invoiceDate;
  const invoice: Invoice = {
    id: key.value,
    amountPaise,
    acceptedOn,
    ...(agreedTermDays !== undefined ? { agreedTermDays } : {}),
    supplierCategory: supplier.supplierCategory,
    supplierActivity: supplier.supplierActivity,
    ...(supplier.udyamRegisteredOn !== undefined
      ? { udyamRegisteredOn: supplier.udyamRegisteredOn }
      : {}),
  };

  try {
    validateInvoice(invoice);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    let column: ColumnRef | undefined;
    if (error.field === "amountPaise") {
      column = amountColumn;
    } else if (error.field === "acceptedOn") {
      column = acceptanceDateDefaulted ? invoiceDateColumn : (acceptanceColumn ?? invoiceDateColumn);
    } else if (error.field === "agreedTermDays") {
      column = creditDaysColumn;
    }
    if (column === undefined) throw error;
    return {
      ok: false,
      rowNumber: row.rowNumber,
      errors: [{ column: column.header, reason: error.reason }],
    };
  }

  const warnings: string[] = [];
  if (agreedTermDays !== undefined && agreedTermDays > MAX_TERM_DAYS) {
    warnings.push(
      `Credit term of ${agreedTermDays} days is above the ${MAX_TERM_DAYS}-day limit; the due date uses ${MAX_TERM_DAYS} days (MSMED-15)`,
    );
  }

  return {
    ok: true,
    rowNumber: row.rowNumber,
    invoice,
    buyerName,
    invoiceNumber,
    invoiceDate,
    acceptanceDateDefaulted,
    dedupeKey: key,
    warnings,
  };
}
