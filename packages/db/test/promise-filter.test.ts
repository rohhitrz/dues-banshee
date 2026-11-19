import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getDebtorData, listGraveyardInvoices } from "../src/graveyard";
import { listLadderRecords } from "../src/ladder";
import { invoices, promises, suppliers } from "../src/schema";
import { seed } from "../src/seed";
import { cloneTestDb, createTestDb, type TestDb } from "../src/testing";

// Engine_History promise filter: a promise counts on `today` only if recorded_on <= today and
// (superseded_on is null or superseded_on > today). Requirements: 9.1, 9.2.

const SHARMA = "LPC/26-27/0412";

let template: TestDb;
const open: TestDb[] = [];

beforeAll(async () => {
  template = await createTestDb();
});
afterAll(async () => {
  await template.close();
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((t) => t.close()));
});

async function world() {
  const t = await cloneTestDb(template);
  open.push(t);
  await seed(t.db);
  const [supplier] = await t.db.select({ id: suppliers.id }).from(suppliers);
  const [sharma] = await t.db
    .select({ id: invoices.id, buyerId: invoices.buyerId })
    .from(invoices)
    .where(eq(invoices.invoiceNumber, SHARMA));
  if (!supplier || !sharma) throw new Error("seed missing");
  return { t, supplierId: supplier.id, invoiceId: sharma.id, buyerId: sharma.buyerId };
}

/** The promise dates Sharma's Engine_History holds, read through every path that applies the filter. */
async function visible(w: Awaited<ReturnType<typeof world>>, today: string) {
  const ladder = (await listLadderRecords(w.t.db, w.supplierId, today, w.invoiceId))[0]?.promises.map((p) => p.promisedDate);
  const graveyard = (await listGraveyardInvoices(w.t.db, w.supplierId, today))
    .find((r) => r.invoiceNumber === SHARMA)
    ?.history.flatMap((e) => (e.kind === "promise" ? [e.promisedDate] : []));
  const debtor = (await getDebtorData(w.t.db, w.supplierId, w.buyerId, today))?.records
    .find((r) => r.invoiceNumber === SHARMA)
    ?.history.flatMap((e) => (e.kind === "promise" ? [e.promisedDate] : []));
  expect(graveyard).toEqual(ladder);
  expect(debtor).toEqual(ladder);
  return ladder;
}

describe("Engine_History promise filter", () => {
  it("leaves out a promise recorded after today", async () => {
    const w = await world();
    await w.t.db.insert(promises).values({
      invoiceId: w.invoiceId,
      promisedDate: "2026-11-20",
      amountPaise: 41_200_000,
      recordedOn: "2026-11-13",
    });
    expect(await visible(w, "2026-11-12")).toEqual([]);
    expect(await visible(w, "2026-11-13")).toEqual(["2026-11-20"]);
  });

  it("counts a promise from its recorded day until the day after it is superseded", async () => {
    const w = await world();
    await w.t.db.insert(promises).values({
      invoiceId: w.invoiceId,
      promisedDate: "2026-11-20",
      amountPaise: 41_200_000,
      recordedOn: "2026-11-12",
      supersededOn: "2026-11-14",
    });
    expect(await visible(w, "2026-11-11")).toEqual([]);
    expect(await visible(w, "2026-11-12")).toEqual(["2026-11-20"]);
    expect(await visible(w, "2026-11-13")).toEqual(["2026-11-20"]);
    expect(await visible(w, "2026-11-14")).toEqual([]);
  });

  it("shows only the promise that was current on each day when one replaced another", async () => {
    const w = await world();
    await w.t.db.insert(promises).values([
      { invoiceId: w.invoiceId, promisedDate: "2026-11-20", amountPaise: 100, recordedOn: "2026-11-12", supersededOn: "2026-11-14" },
      { invoiceId: w.invoiceId, promisedDate: "2026-11-25", amountPaise: 200, recordedOn: "2026-11-14" },
    ]);
    expect(await visible(w, "2026-11-13")).toEqual(["2026-11-20"]);
    expect(await visible(w, "2026-11-14")).toEqual(["2026-11-25"]);
  });
});
