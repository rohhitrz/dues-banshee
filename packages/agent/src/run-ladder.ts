import { getSupplier, insertDraft, listLadderRecords, logToolCall } from "@dues-banshee/db";
import type { Db, LadderRecord } from "@dues-banshee/db";
import { DEFAULT_LADDER_CONFIG, ValidationError, dueDate, nextEscalationStep } from "@dues-banshee/engine";
import type { CalendarDate, EscalationDecision, WaitReason } from "@dues-banshee/engine";
import { draftStep } from "./draft-step";
import { loadBankRate } from "./load-bank-rate";
import { engineHistory } from "./core/history";
import { classify, planRun } from "./core/plan-run";
import type { Classified } from "./core/plan-run";
import type { ModelSet } from "./models";

export type InvoiceOutcome =
  | { kind: "drafted"; draftId: string }
  | { kind: "wait"; reason: WaitReason }
  | { kind: "skip"; reason: "pending_draft_exists" | "draft_failed" | "draft_cap" | "invalid_invoice" };

export interface LadderRunResult {
  supplierId: string;
  today: CalendarDate;
  /** One outcome per invoice id of the supplier. */
  invoices: Record<string, InvoiceOutcome>;
}

type Advance = Extract<EscalationDecision, { action: "advance" }>;

/**
 * One Ladder_Run for one supplier. For each invoice the Engine decides (`nextEscalationStep`);
 * this function only reads the Decision's action, step and reason. Draftable invoices are ordered
 * and capped by `planRun`, then drafted one after another in Hinglish. Each Draft is inserted with
 * its `drafted` event; nothing is sent. A `SupplierNotFoundError` from `getSupplier` propagates.
 */
export async function runLadder(
  deps: { db: Db; models: ModelSet },
  supplierId: string,
  today: CalendarDate,
): Promise<LadderRunResult> {
  const { db, models } = deps;
  const supplier = await getSupplier(db, supplierId);
  const bankRate = await loadBankRate(db, today);
  const records = await listLadderRecords(db, supplierId, today);

  const outcomes: Record<string, InvoiceOutcome> = {};
  const classified: Classified[] = [];
  const advances = new Map<string, { record: LadderRecord; decision: Advance }>();

  for (const record of records) {
    const invoiceId = record.invoice.id;
    const history = engineHistory(record);
    let decision: EscalationDecision;
    let due: CalendarDate | null = null;
    try {
      decision = nextEscalationStep(record.invoice, history, today, DEFAULT_LADDER_CONFIG);
      if (decision.action === "advance") {
        const d = dueDate(record.invoice);
        due = d.applicable ? d.dueDate : null;
      }
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      await logToolCall(db, {
        tool: "next_escalation_step",
        invoiceId,
        input: { invoice: record.invoice, history, today, config: DEFAULT_LADDER_CONFIG },
        output: { error: "ValidationError", field: err.field, message: err.message },
      });
      classified.push({ invoiceId, kind: "skip", reason: "invalid_invoice" });
      continue;
    }
    await logToolCall(db, {
      tool: "next_escalation_step",
      invoiceId,
      input: { invoice: record.invoice, history, today, config: DEFAULT_LADDER_CONFIG },
      output: decision,
    });
    if (decision.action === "advance") advances.set(invoiceId, { record, decision });
    classified.push({ invoiceId, ...classify(decision, record.pendingDraftId, due) });
  }

  for (const item of classified) {
    if (item.kind === "wait") outcomes[item.invoiceId] = { kind: "wait", reason: item.reason };
    else if (item.kind === "skip") outcomes[item.invoiceId] = { kind: "skip", reason: item.reason };
  }

  const { attempts, capped } = planRun(classified);
  for (const invoiceId of capped) outcomes[invoiceId] = { kind: "skip", reason: "draft_cap" };

  for (const attempt of attempts) {
    const entry = advances.get(attempt.invoiceId);
    if (entry === undefined) continue;
    const result = await draftStep(
      { db, models },
      { record: entry.record, supplier, decision: entry.decision, language: "hinglish", today, bankRate },
    );
    if (result.kind === "failed") {
      outcomes[attempt.invoiceId] = { kind: "skip", reason: "draft_failed" };
      continue;
    }
    const inserted = await insertDraft(db, result.draft, today);
    outcomes[attempt.invoiceId] =
      inserted.kind === "ok"
        ? { kind: "drafted", draftId: inserted.draftId }
        : { kind: "skip", reason: "pending_draft_exists" };
  }

  return { supplierId, today, invoices: outcomes };
}
