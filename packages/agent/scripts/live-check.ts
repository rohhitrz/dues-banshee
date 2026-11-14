// Manual live check (Requirement 12.12). Not a test: it is outside the `test` script and the
// Vitest include globs (test/** only), and CI never runs it.
//
//   pnpm --filter @dues-banshee/agent exec tsx scripts/live-check.ts
//
// Drafts the Sharma Traders `whatsapp_nudge` with the production models (Claude Haiku, GPT
// fallback) through the real draftStep and Model_Router, at Today 2026-11-12 with the demo
// Bank_Rate (575 bps as of 2026-10-07). It prints the Citation_Validator result and the
// Final_Text. It only reads the database: draftStep gets a Db stub that keeps its Tool_Log rows in
// memory and discards them, and insertDraft is never called. It never prints an env var value.
import { DEMO_SUPPLIER, createDb, findSupplierIdByUdyam, getSupplier, listLadderRecords } from "@dues-banshee/db";
import type { Db } from "@dues-banshee/db";
import { nextEscalationStep } from "@dues-banshee/engine";
import type { BankRate, CalendarDate } from "@dues-banshee/engine";
import { engineHistory } from "../src/core/history";
import { draftStep } from "../src/draft-step";
import { productionModels } from "../src/models";

const TODAY: CalendarDate = "2026-11-12";
const BANK_RATE: BankRate = { annualBps: 575, asOf: "2026-10-07" };
const SHARMA_INVOICE_NUMBER = "LPC/26-27/0412";
const REQUIRED_ENV = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DATABASE_URL"] as const;

/** Names (never values) of the required variables that are unset or empty. */
function missingVariables(): string[] {
  return REQUIRED_ENV.filter((name) => {
    const value = process.env[name];
    return value === undefined || value === "";
  });
}

/**
 * The only Db draftStep sees. draftStep's sole write is `db.insert(agentRuns).values(row)` (Tool_Log).
 * This stub keeps each row in `rows` (memory only) and persists nothing. Reads go through the real Db.
 */
function discardingDb(): { db: Db; rows: Record<string, unknown>[] } {
  const rows: Record<string, unknown>[] = [];
  const stub = {
    insert: () => ({
      values: (row: Record<string, unknown>): Promise<void> => {
        rows.push(row);
        return Promise.resolve();
      },
    }),
  };
  return { db: stub as unknown as Db, rows };
}

async function main(): Promise<number> {
  const missing = missingVariables();
  if (missing.length > 0) {
    console.error(`live-check: missing required environment variable(s): ${missing.join(", ")}`);
    console.error("Set them locally (for example in your shell) and run again. Nothing was called or written.");
    return 1;
  }

  const url = process.env["DATABASE_URL"] ?? "";
  const { db: realDb, close } = createDb(url);
  try {
    // Reads only.
    const supplierId = await findSupplierIdByUdyam(realDb, DEMO_SUPPLIER.udyamNumber);
    if (supplierId === null) {
      console.error("live-check: demo supplier not found. Seed the demo data first (pnpm --filter @dues-banshee/db db:seed).");
      return 1;
    }
    const supplier = await getSupplier(realDb, supplierId);
    const records = await listLadderRecords(realDb, supplierId);
    const record = records.find((r) => r.invoiceNumber === SHARMA_INVOICE_NUMBER);
    if (record === undefined) {
      console.error(`live-check: invoice ${SHARMA_INVOICE_NUMBER} (Sharma Traders) not found for the demo supplier.`);
      return 1;
    }

    // Fixed empty history so the check always drafts the first step, whatever the DB holds.
    const decision = nextEscalationStep(record.invoice, engineHistory({ steps: [], promises: [] }), TODAY);
    if (decision.action !== "advance" || decision.step !== "whatsapp_nudge") {
      console.error(`live-check: expected an advance to whatsapp_nudge, the Engine returned action "${decision.action}".`);
      return 1;
    }

    const { db: logDb, rows } = discardingDb();
    console.log(`Drafting ${decision.step} for ${record.buyerName} (${record.invoiceNumber}) at ${TODAY}, Bank_Rate ${BANK_RATE.annualBps} bps as of ${BANK_RATE.asOf}...`);
    const result = await draftStep(
      { db: logDb, models: productionModels() },
      { record, supplier, decision, language: "hinglish", today: TODAY, bankRate: BANK_RATE },
    );

    console.log("\nLLM calls (in memory only, not stored):");
    for (const row of rows) {
      const input = row["input"] as { attempt?: string; modelId?: string };
      const output = row["output"] as { errorKind?: string; citation?: unknown };
      console.log(`- ${input.attempt ?? "?"} on ${input.modelId ?? "?"}`);
      if (output.errorKind !== undefined) console.log(`  error kind: ${output.errorKind}`);
      console.log(`  Citation_Validator: ${JSON.stringify(output.citation ?? null)}`);
    }

    if (result.kind === "failed") {
      console.log(`\nResult: FAILED (${result.errorKind}). No Draft was produced.`);
      return 1;
    }
    console.log(`\nResult: ACCEPTED on ${result.draft.modelId}. Rule IDs: ${result.draft.ruleIds.join(", ")}`);
    console.log("\nFinal_Text:\n");
    console.log(result.draft.finalText);
    console.log("\nNothing was written to the database.");
    return 0;
  } finally {
    await close();
  }
}

process.exitCode = await main();
