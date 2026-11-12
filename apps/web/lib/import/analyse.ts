import { formatINR } from "@dues-banshee/engine";
import { findStoredInvoices, getSupplier, type Db } from "@dues-banshee/db";
import {
  buildImport,
  compareWithStored,
  type FileError,
  type OkRow,
  type RowError,
} from "@dues-banshee/ledger";
import { MAX_DATA_ROWS, tooManyRowsMessage } from "./limits";
import { readUpload } from "./read-upload";

export type PreviewStatus = "new" | "already_imported" | "error";

export interface PreviewRow {
  rowNumber: number;
  status: PreviewStatus;
  invoiceNumber?: string;
  buyerName?: string;
  amountText?: string;
  invoiceDate?: string;
  acceptedOn?: string;
  acceptanceDateDefaulted?: boolean;
  warnings: string[];
  errors: RowError[];
}

export interface PreviewResponse {
  headerRowNumber: number;
  unusedColumns: string[];
  counts: { new: number; already_imported: number; error: number };
  rows: PreviewRow[];
}

export type AnalyseResult =
  | { ok: false; status: number; message: string; fileErrors?: FileError[] }
  | { ok: true; preview: PreviewResponse; okRows: OkRow[] };

const fileErrorMessage = (fileErrors: readonly FileError[]): string =>
  fileErrors.map((e) => e.message).join(" ");

/**
 * The pipeline shared by the preview and commit routes (Requirements 10.5, 10.6, 13.3, 13.4).
 * Nothing is trusted from the browser: the file is read, mapped and compared with stored invoices
 * every time. `okRows` holds every valid row, including `already_imported` ones; the Db skips those.
 */
export async function analyseUpload(
  db: Db,
  supplierId: string,
  file: File | null,
): Promise<AnalyseResult> {
  const read = await readUpload(file);
  if (!read.ok) return { ok: false, status: read.status, message: read.message };

  const supplier = await getSupplier(db, supplierId);

  const parsed = buildImport(read.table, supplier);
  if (!parsed.ok) {
    return {
      ok: false,
      status: 422,
      message: fileErrorMessage(parsed.fileErrors),
      fileErrors: parsed.fileErrors,
    };
  }

  if (parsed.rows.length > MAX_DATA_ROWS) {
    return { ok: false, status: 422, message: tooManyRowsMessage() };
  }

  const okRows: OkRow[] = [];
  for (const result of parsed.rows) if (result.ok) okRows.push(result);

  const stored = await findStoredInvoices(
    db,
    supplierId,
    okRows.map((row) => row.dedupeKey),
  );

  const counts = { new: 0, already_imported: 0, error: 0 };
  const rows: PreviewRow[] = parsed.rows.map((result): PreviewRow => {
    if (!result.ok) {
      counts.error += 1;
      return { rowNumber: result.rowNumber, status: "error", warnings: [], errors: result.errors };
    }

    const existing = stored.get(result.dedupeKey.value);
    const warnings = [...result.warnings];
    if (existing) {
      const difference = compareWithStored(result, existing);
      if (difference !== null) warnings.push(difference);
    }
    const status: PreviewStatus = existing ? "already_imported" : "new";
    counts[status] += 1;

    return {
      rowNumber: result.rowNumber,
      status,
      invoiceNumber: result.invoiceNumber,
      buyerName: result.buyerName,
      amountText: formatINR(result.invoice.amountPaise, "full"),
      invoiceDate: result.invoiceDate,
      acceptedOn: result.invoice.acceptedOn,
      acceptanceDateDefaulted: result.acceptanceDateDefaulted,
      warnings,
      errors: [],
    };
  });

  return {
    ok: true,
    preview: {
      headerRowNumber: parsed.mapping.headerRowNumber,
      unusedColumns: parsed.mapping.unused.map((column) => column.header),
      counts,
      rows,
    },
    okRows,
  };
}
