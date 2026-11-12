import type { SupplierFacts } from "@dues-banshee/ledger";
import { eq } from "drizzle-orm";
import type { Db } from "./client";
import { suppliers } from "./schema";

export type Supplier = SupplierFacts & { name: string; udyamNumber: string };

/**
 * Loads a supplier as the Ledger's `SupplierFacts` plus its name and Udyam number.
 * `udyamRegisteredOn` is omitted when the column is null. Throws when no supplier has `id`.
 */
export async function getSupplier(db: Db, id: string): Promise<Supplier> {
  const [row] = await db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
  if (!row) throw new Error(`supplier ${id} not found`);
  return {
    id: row.id,
    name: row.name,
    udyamNumber: row.udyamNumber,
    supplierCategory: row.supplierCategory,
    supplierActivity: row.supplierActivity,
    ...(row.udyamRegisteredOn === null ? {} : { udyamRegisteredOn: row.udyamRegisteredOn }),
  };
}

/** Returns the id of the supplier registered under `udyamNumber`, or `null` if there is none. */
export async function findSupplierIdByUdyam(db: Db, udyamNumber: string): Promise<string | null> {
  const [row] = await db
    .select({ id: suppliers.id })
    .from(suppliers)
    .where(eq(suppliers.udyamNumber, udyamNumber))
    .limit(1);
  return row?.id ?? null;
}
