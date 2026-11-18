import type { CalendarDate, Paise, SupplierActivity, SupplierCategory } from "@dues-banshee/engine";
import { textKey } from "@dues-banshee/ledger";
import { and, eq } from "drizzle-orm";
import { BANK_RATE_KEY } from "./bank-rate";
import type { Db } from "./client";
import { insertInvoiceRows, upsertBuyers, type InvoiceInsert } from "./invoices";
import { buyers, config, suppliers } from "./schema";

/** The demo supplier (Requirement 11.2). Sign-in finds it by `udyamNumber`. */
export const DEMO_SUPPLIER: {
  readonly name: string;
  readonly udyamNumber: string;
  readonly supplierCategory: SupplierCategory;
  readonly supplierActivity: SupplierActivity;
  readonly udyamRegisteredOn: CalendarDate;
} = {
  name: "Laxmi Precision Components (Demo)",
  udyamNumber: "UDYAM-MH-00-0000000",
  supplierCategory: "micro",
  supplierActivity: "manufacturing",
  udyamRegisteredOn: "2024-04-15",
};

/** The E.164 shape of `buyers.whatsapp_number` (the same pattern as the database check). */
const BUYER_WHATSAPP_PATTERN = /^\+[1-9][0-9]{7,14}$/;
/** The buyer that gets `DEMO_BUYER_WHATSAPP`. */
const DEMO_WHATSAPP_BUYER = "Sharma Traders";
const DEMO_WHATSAPP_WARNING = "DEMO_BUYER_WHATSAPP is unset or not E.164; demo buyer has no WhatsApp number";
export interface SeedOptions {
  /** Stored on Sharma Traders when it is a valid E.164 number; otherwise every Buyer_Number stays null. */
  readonly demoBuyerWhatsapp?: string;
}
/** The demo bank rate (Requirement 11.3): 5.75% from 2026-10-07. */
const DEMO_BANK_RATE = { valueInt: 575, effectiveFrom: "2026-10-07" } as const;

export interface DemoInvoice {
  readonly buyerName: string;
  readonly invoiceNumber: string;
  readonly amountPaise: Paise;
  /** Also the invoice date (Requirement 11.6). */
  readonly acceptedOn: CalendarDate;
  readonly agreedTermDays?: number;
  readonly paidOn?: CalendarDate;
}

/** The six demo invoices of Requirement 11.4, one per legal state. */
export const DEMO_INVOICES: readonly DemoInvoice[] = [
  {
    buyerName: "Sharma Traders",
    invoiceNumber: "LPC/26-27/0412",
    amountPaise: 41_200_000,
    acceptedOn: "2026-09-02",
    agreedTermDays: 45,
  },
  {
    buyerName: "Gupta Engineering Works",
    invoiceNumber: "LPC/26-27/0466",
    amountPaise: 18_500_000,
    acceptedOn: "2026-11-01",
  },
  {
    buyerName: "Kumar Textiles",
    invoiceNumber: "LPC/26-27/0301",
    amountPaise: 24_000_000,
    acceptedOn: "2026-07-02",
    agreedTermDays: 45,
  },
  {
    buyerName: "Verma Auto Parts",
    invoiceNumber: "LPC/26-27/0377",
    amountPaise: 8_500_000,
    acceptedOn: "2026-08-10",
    agreedTermDays: 30,
    paidOn: "2026-09-05",
  },
  {
    buyerName: "Mehta Polymers",
    invoiceNumber: "LPC/25-26/0388",
    amountPaise: 16_000_000,
    acceptedOn: "2026-03-20",
    agreedTermDays: 45,
  },
  {
    buyerName: "Bansal Hardware",
    invoiceNumber: "LPC/23-24/0098",
    amountPaise: 5_500_000,
    acceptedOn: "2024-03-01",
    agreedTermDays: 30,
  },
];

/**
 * Creates the demo supplier, bank rate, buyers and invoices, or leaves them unchanged when they
 * already exist (Requirement 11.1). Runs in one transaction, which is a savepoint when `db` is
 * already a transaction.
 */
export async function seed(db: Db, opts?: SeedOptions): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(suppliers).values(DEMO_SUPPLIER).onConflictDoNothing({ target: suppliers.udyamNumber });
    const [supplierRow] = await tx
      .select()
      .from(suppliers)
      .where(eq(suppliers.udyamNumber, DEMO_SUPPLIER.udyamNumber))
      .limit(1);
    if (!supplierRow) throw new Error(`seed: supplier ${DEMO_SUPPLIER.udyamNumber} missing after insert`);

    await tx
      .insert(config)
      .values({ key: BANK_RATE_KEY, ...DEMO_BANK_RATE })
      .onConflictDoNothing({ target: [config.key, config.effectiveFrom] });

    const names = new Map<string, string>();
    for (const inv of DEMO_INVOICES) {
      const nameKey = textKey(inv.buyerName);
      if (!names.has(nameKey)) names.set(nameKey, inv.buyerName);
    }
    const buyerIds = await upsertBuyers(tx, supplierRow.id, names);

    const rows = DEMO_INVOICES.map((inv): InvoiceInsert => {
      const buyerId = buyerIds.get(textKey(inv.buyerName));
      if (buyerId === undefined) throw new Error(`seed: no buyer id for ${inv.buyerName}`);
      return {
        buyerId,
        invoiceNumber: inv.invoiceNumber,
        invoiceNumberKey: textKey(inv.invoiceNumber),
        invoiceDate: inv.acceptedOn,
        acceptedOn: inv.acceptedOn,
        acceptanceDateDefaulted: false,
        ...(inv.agreedTermDays === undefined ? {} : { agreedTermDays: inv.agreedTermDays }),
        amountPaise: inv.amountPaise,
        ...(inv.paidOn === undefined ? {} : { paidOn: inv.paidOn }),
      };
    });
    await insertInvoiceRows(tx, supplierRow, rows);
    const whatsapp = opts?.demoBuyerWhatsapp;
    if (whatsapp !== undefined && BUYER_WHATSAPP_PATTERN.test(whatsapp)) {
      const sharmaKey = textKey(DEMO_WHATSAPP_BUYER);
      await tx
        .update(buyers)
        .set({ whatsappNumber: whatsapp })
        .where(and(eq(buyers.supplierId, supplierRow.id), eq(buyers.nameKey, sharmaKey)));
    } else {
      // Never print the value: it may be a real number.
      console.warn(DEMO_WHATSAPP_WARNING);
    }
  });
}
