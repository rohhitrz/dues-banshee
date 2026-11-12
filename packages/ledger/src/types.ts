import type {
  CalendarDate,
  Invoice,
  Paise,
  SupplierActivity,
  SupplierCategory,
} from "@dues-banshee/engine";

export type ImportField =
  | "invoiceNumber"
  | "buyerName"
  | "amount"
  | "invoiceDate"
  | "acceptanceDate"
  | "creditDays";

/** rowNumber is 1-based: the row number the owner sees when the file is opened in Excel. */
export interface RawRow {
  rowNumber: number;
  cells: readonly string[];
}
export type RawTable = readonly RawRow[];

export interface SupplierFacts {
  id: string;
  supplierCategory: SupplierCategory;
  supplierActivity: SupplierActivity;
  udyamRegisteredOn?: CalendarDate;
}

/** header is trimmed, as written in the file. */
export interface ColumnRef {
  index: number;
  header: string;
}

export interface HeaderMapping {
  headerRowNumber: number;
  /** Required fields are always present. */
  columns: { [F in ImportField]?: ColumnRef };
  unused: ColumnRef[];
}

/** column is the header as written in the file. */
export interface RowError {
  column: string;
  reason: string;
}

export interface DedupeKey {
  supplierId: string;
  buyerKey: string;
  invoiceNumberKey: string;
  value: string;
}

export interface OkRow {
  ok: true;
  rowNumber: number;
  invoice: Invoice;
  buyerName: string;
  invoiceNumber: string;
  invoiceDate: CalendarDate;
  acceptanceDateDefaulted: boolean;
  dedupeKey: DedupeKey;
  warnings: string[];
}

export interface ErrorRow {
  ok: false;
  rowNumber: number;
  errors: RowError[];
}

export type RowResult = OkRow | ErrorRow;

export type FileErrorCode =
  | "csv_syntax"
  | "missing_headers"
  | "duplicate_header"
  | "invalid_supplier";

export interface FileError {
  code: FileErrorCode;
  message: string;
}

export type ImportParse =
  | { ok: false; fileErrors: FileError[] }
  | { ok: true; mapping: HeaderMapping; rows: RowResult[] };

export interface StoredInvoiceFacts {
  amountPaise: Paise;
  invoiceDate: CalendarDate;
  acceptedOn: CalendarDate;
}
