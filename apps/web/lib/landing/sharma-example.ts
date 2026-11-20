import { DEMO_INVOICES, DEMO_SUPPLIER } from "@dues-banshee/db";
import { formatDisplayDate, formatINR, taxBomb, type CalendarDate, type Invoice } from "@dues-banshee/engine";

/** The fixed date of the landing example. The page reads no clock, no `?today` and no database. */
export const EXAMPLE_DATE: CalendarDate = "2026-11-12";

const SHARMA_INVOICE_NUMBER = "LPC/26-27/0412";

export interface SharmaExample {
  /** From the seed entry, not typed here. */
  buyerName: string;
  status: "armed";
  daysLeft: number;
  deductionAtRiskPaise: number;
  /** `formatINR(deductionAtRiskPaise, "full")`. */
  deductionAtRiskText: string;
  /** `formatDisplayDate(EXAMPLE_DATE)`. */
  exampleDateText: string;
}

/** The seed entry for Sharma Traders. Throws (with no data in the message) when the seed no longer has it. */
function sharmaSeedEntry() {
  const entry = DEMO_INVOICES.find((i) => i.invoiceNumber === SHARMA_INVOICE_NUMBER);
  if (entry === undefined) throw new Error("landing: Sharma seed invoice is missing");
  return entry;
}

/** The Engine `Invoice` for Sharma Traders, built from the demo seed and the demo supplier. */
export function sharmaInvoice(): Invoice {
  const entry = sharmaSeedEntry();
  return {
    id: entry.invoiceNumber,
    amountPaise: entry.amountPaise,
    acceptedOn: entry.acceptedOn,
    ...(entry.agreedTermDays !== undefined ? { agreedTermDays: entry.agreedTermDays } : {}),
    ...(entry.paidOn !== undefined ? { paidOn: entry.paidOn } : {}),
    supplierCategory: DEMO_SUPPLIER.supplierCategory,
    supplierActivity: DEMO_SUPPLIER.supplierActivity,
    udyamRegisteredOn: DEMO_SUPPLIER.udyamRegisteredOn,
  };
}

/** The Sharma tax-bomb example at EXAMPLE_DATE. Every value comes from the Engine. */
export function sharmaExample(): SharmaExample {
  const bomb = taxBomb(sharmaInvoice(), EXAMPLE_DATE);
  if (bomb.status !== "armed") throw new Error("landing: Sharma example is no longer armed");
  return {
    buyerName: sharmaSeedEntry().buyerName,
    status: bomb.status,
    daysLeft: bomb.daysLeft,
    deductionAtRiskPaise: bomb.deductionAtRiskPaise,
    deductionAtRiskText: formatINR(bomb.deductionAtRiskPaise, "full"),
    exampleDateText: formatDisplayDate(EXAMPLE_DATE),
  };
}
