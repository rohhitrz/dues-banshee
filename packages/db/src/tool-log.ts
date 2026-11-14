import type { Db } from "./client";
import { agentRuns } from "./schema";

/**
 * Writes one Tool_Log row: the tool name, its input and output as JSON, and the invoice it was
 * about (or `null`). The caller must not pass secrets; nothing here filters them.
 */
export async function logToolCall(
  db: Db,
  row: { tool: string; invoiceId: string | null; input: unknown; output: unknown },
): Promise<void> {
  await db.insert(agentRuns).values({
    tool: row.tool,
    input: row.input,
    output: row.output === undefined ? null : row.output,
    invoiceId: row.invoiceId,
  });
}
