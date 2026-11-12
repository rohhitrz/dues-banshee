import { detectHeader, mapRow, type HeaderMapping, type OkRow, type SupplierFacts } from "@dues-banshee/ledger";
import fc from "fast-check";

/**
 * Buyer names with spacing and case variants. Variants of one name share a Buyer_Key, so the
 * generated rows repeat Dedupe_Keys often.
 */
const BUYER_VARIANTS: readonly (readonly string[])[] = [
  ["Sharma Traders", "  SHARMA traders", "sharma  Traders "],
  ["Gupta Steel", "GUPTA STEEL", " gupta   steel"],
  ["Patel Industries", "patel industries  ", "PATEL  Industries"],
];

/** Invoice numbers with case variants; variants of one number share an Invoice_Number_Key. */
const INVOICE_NUMBER_VARIANTS: readonly (readonly string[])[] = [
  ["INV-001", "inv-001", "Inv-001"],
  ["INV-002", "inv-002", "iNV-002"],
  ["GST/26/17", "gst/26/17", "Gst/26/17"],
  ["A-17", "a-17", " A-17 "],
  ["TX9", "tx9", "Tx9"],
];

const HEADERS = ["Invoice No", "Party Name", "Amount", "Invoice Date", "Credit Days"];

function headerMapping(): HeaderMapping {
  const result = detectHeader([{ rowNumber: 1, cells: HEADERS }]);
  if (!result.ok) throw new Error(`test headers did not map: ${JSON.stringify(result.errors)}`);
  return result.mapping;
}

const arbVariant = (pool: readonly (readonly string[])[]): fc.Arbitrary<string> =>
  fc.constantFrom(...pool).chain((variants) => fc.constantFrom(...variants));

/** Paise rendered as plain rupees text, e.g. 41200050 → "412000.50", 100 → "1". */
function rupeesText(paise: number): string {
  const rupees = BigInt(paise) / 100n;
  const rest = BigInt(paise) % 100n;
  return rest === 0n ? rupees.toString() : `${rupees}.${rest.toString().padStart(2, "0")}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** A real calendar day in 2025–2026, written `DD/MM/YYYY`. */
const arbDateText: fc.Arbitrary<string> = fc
  .record({ year: fc.integer({ min: 2025, max: 2026 }), month: fc.integer({ min: 1, max: 12 }) })
  .chain(({ year, month }) =>
    fc
      .integer({ min: 1, max: daysInMonth(year, month) })
      .map((day) => `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`),
  );

const arbRawCells: fc.Arbitrary<string[]> = fc
  .record({
    invoiceNumber: arbVariant(INVOICE_NUMBER_VARIANTS),
    buyer: arbVariant(BUYER_VARIANTS),
    amount: fc.integer({ min: 1, max: 1_000_000_000 }).map(rupeesText),
    date: arbDateText,
    creditDays: fc.option(fc.integer({ min: 1, max: 60 }).map(String), { nil: undefined }),
  })
  .map((r) => [r.invoiceNumber, r.buyer, r.amount, r.date, r.creditDays ?? ""]);

/** The demo supplier's facts (Requirement 11.2) under the given supplier id. */
export function demoSupplierFacts(id: string): SupplierFacts {
  return { id, supplierCategory: "micro", supplierActivity: "manufacturing", udyamRegisteredOn: "2024-04-15" };
}

/**
 * 0–30 rows mapped by the Ledger's `mapRow` for `supplier`, keeping only `ok` rows. Buyer names
 * and invoice numbers come from small pools, so Dedupe_Keys repeat within one list.
 */
export function arbImportRows(supplier: SupplierFacts): fc.Arbitrary<OkRow[]> {
  const mapping = headerMapping();
  return fc.array(arbRawCells, { minLength: 0, maxLength: 30 }).map((rows) =>
    rows
      .map((cells, i) => mapRow({ rowNumber: i + 2, cells }, mapping, supplier))
      .filter((r): r is OkRow => r.ok),
  );
}

/** How many times the same list is imported. */
export const arbImportCount: fc.Arbitrary<number> = fc.integer({ min: 1, max: 5 });
