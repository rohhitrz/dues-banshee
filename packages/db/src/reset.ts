import { sql } from "drizzle-orm";
import type { Db } from "./client";
import { seed, type SeedOptions } from "./seed";

/**
 * Every table except `config`, so bank-rate history set by hand survives a reset. A test asserts
 * this list equals the tables in `schema.ts` minus `config`, so a table added later fails the test
 * until the list is updated.
 */
export const RESET_TABLES = [
  "agent_runs",
  "webhook_events",
  "payment_links",
  "approvals",
  "calls",
  "messages",
  "voice_transcript_lines",
  "voice_tool_calls",
  "voice_calls",
  "promises",
  "escalation_events",
  "drafts",
  "invoices",
  "buyers",
  "suppliers",
] as const;

/**
 * Empties every table in `RESET_TABLES` and reseeds the demo data, in one transaction. If the
 * reseed fails, the truncate rolls back and the old data stays in place.
 */
export async function resetDemo(db: Db, opts?: SeedOptions): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`TRUNCATE ${RESET_TABLES.join(", ")} RESTART IDENTITY CASCADE`));
    await seed(tx, opts);
  });
}
