import { count } from "drizzle-orm";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importInvoices } from "../src/invoices";
import { invoices, suppliers } from "../src/schema";
import { cloneTestDb, createTestDb, type TestDb } from "../src/testing";
import { arbImportCount, arbImportRows, demoSupplierFacts } from "./arbitraries";

let template: TestDb;
let supplierId: string;

beforeAll(async () => {
  template = await createTestDb();
  const [supplier] = await template.db
    .insert(suppliers)
    .values({
      name: "Laxmi Precision Components (Demo)",
      udyamNumber: "UDYAM-MH-00-0000000",
      supplierCategory: "micro",
      supplierActivity: "manufacturing",
      udyamRegisteredOn: "2024-04-15",
    })
    .returning({ id: suppliers.id });
  if (supplier === undefined) throw new Error("supplier not inserted");
  supplierId = supplier.id;
}, 60_000);

afterAll(async () => {
  await template.close();
});

describe("importInvoices", () => {
  // Feature: ledger-import, Property 2: Re-importing never adds invoices
  // Validates: Requirements 7.1, 7.2, 8.5, 10.1, 10.2, 10.8
  it("leaves one invoice per distinct Dedupe_Key however often the list is imported", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbImportRows(demoSupplierFacts(supplierId)),
        arbImportCount,
        async (rows, n) => {
          const t = await cloneTestDb(template);
          try {
            const results: { inserted: number; skipped: number }[] = [];
            for (let i = 0; i < n; i++) results.push(await importInvoices(t.db, supplierId, rows));

            const distinct = new Set(rows.map((r) => r.dedupeKey.value)).size;
            const [stored] = await t.db.select({ n: count() }).from(invoices);
            expect(stored?.n).toBe(distinct);
            expect(results[0]?.inserted).toBe(distinct);
            for (const later of results.slice(1)) {
              expect(later).toEqual({ inserted: 0, skipped: rows.length });
            }
          } finally {
            await t.close();
          }
        },
      ),
      { numRuns: 50 },
    );
  }, 300_000);
});
