import {
  SUPPLIER_ACTIVITIES,
  SUPPLIER_CATEGORIES,
  isValidCalendarDate,
} from "@dues-banshee/engine";
import { detectHeader } from "./headers";
import { mapRow } from "./map-row";
import type {
  FileError,
  HeaderMapping,
  ImportParse,
  RawRow,
  RawTable,
  RowResult,
  SupplierFacts,
} from "./types";

/** Checks the supplier against the Engine's own constants and calendar check. */
function supplierErrors(supplier: SupplierFacts): FileError[] {
  const errors: FileError[] = [];
  const categories: readonly string[] = SUPPLIER_CATEGORIES;
  const activities: readonly string[] = SUPPLIER_ACTIVITIES;
  if (!categories.includes(supplier.supplierCategory)) {
    errors.push({
      code: "invalid_supplier",
      message: `Supplier category ${JSON.stringify(supplier.supplierCategory)} is not one of: ${categories.join(", ")}`,
    });
  }
  if (!activities.includes(supplier.supplierActivity)) {
    errors.push({
      code: "invalid_supplier",
      message: `Supplier activity ${JSON.stringify(supplier.supplierActivity)} is not one of: ${activities.join(", ")}`,
    });
  }
  if (supplier.udyamRegisteredOn !== undefined && !isValidCalendarDate(supplier.udyamRegisteredOn)) {
    errors.push({
      code: "invalid_supplier",
      message: `Supplier Udyam registration date ${JSON.stringify(supplier.udyamRegisteredOn)} is not a real calendar day`,
    });
  }
  return errors;
}

/** True when every mapped cell of the row is blank (Requirement 5.11). */
function isBlankRow(row: RawRow, mapping: HeaderMapping): boolean {
  for (const column of Object.values(mapping.columns)) {
    if (column === undefined) continue;
    if ((row.cells[column.index] ?? "").trim() !== "") return false;
  }
  return true;
}

/**
 * Turns a Raw_Table into per-row results.
 *
 * 1. The supplier is checked first; a bad supplier is a file error and no row
 *    is mapped.
 * 2. The header row is detected.
 * 3. Rows after the header row are skipped when all mapped cells are blank,
 *    otherwise mapped.
 * 4. A later `ok` row with an already-seen Dedupe_Key becomes an error row
 *    naming the first row's number.
 */
export function buildImport(table: RawTable, supplier: SupplierFacts): ImportParse {
  const invalidSupplier = supplierErrors(supplier);
  if (invalidSupplier.length > 0) return { ok: false, fileErrors: invalidSupplier };

  const header = detectHeader(table);
  if (!header.ok) return { ok: false, fileErrors: header.errors };
  const { mapping } = header;

  const mapped: RowResult[] = [];
  for (const row of table) {
    if (row.rowNumber <= mapping.headerRowNumber) continue;
    if (isBlankRow(row, mapping)) continue;
    mapped.push(mapRow(row, mapping, supplier));
  }

  const invoiceNumberColumn = mapping.columns.invoiceNumber;
  if (invoiceNumberColumn === undefined) {
    throw new Error('buildImport: header mapping has no column for required field "invoiceNumber"');
  }

  const firstRowByKey = new Map<string, number>();
  const rows = mapped.map((result): RowResult => {
    if (!result.ok) return result;
    const first = firstRowByKey.get(result.dedupeKey.value);
    if (first === undefined) {
      firstRowByKey.set(result.dedupeKey.value, result.rowNumber);
      return result;
    }
    return {
      ok: false,
      rowNumber: result.rowNumber,
      errors: [{ column: invoiceNumberColumn.header, reason: `Duplicate of row ${first}` }],
    };
  });

  return { ok: true, mapping, rows };
}
