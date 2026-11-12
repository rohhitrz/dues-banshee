import { sql } from "drizzle-orm";
import type { Db } from "./client";
import { seed } from "./seed";

/**
 * Every table except `config`, so bank-rate history set by hand survives a reset. A test asserts
 * this list equals the tables in `schema.ts` minus `config`, so a table added later fails the test
 * until the list is updated.
 */
export const RESET_TABLES = [
  "agent_runs",
  "payment_links",
  "approvals",
  "calls",
  "messages",
  "promises",
  "escalation_events",
  "invoices",
  "buyers",
  "suppliers",
] as const;

/**
 * Empties every table in `RESET_TABLES` and reseeds the demo data, in one transaction. If the
 * reseed fails, the truncate rolls back and the old data stays in place.
 */
export async function resetDemo(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`TRUNCATE ${RESET_TABLES.join(", ")} RESTART IDENTITY CASCADE`));
    await seed(tx);
  });
}
