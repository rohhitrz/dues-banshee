import {
  getDraftForSupplier,
  getSupplier,
  insertDraftRows,
  insertEscalationEvent,
  listLadderRecords,
  logToolCall,
  setDraftStatus,
  updatePendingBody,
} from "@dues-banshee/db";
import type { Db, DraftWithContext, LadderRecord } from "@dues-banshee/db";
import { DEFAULT_LADDER_CONFIG, RULE_IDS, nextEscalationStep } from "@dues-banshee/engine";
import type { CalendarDate, EscalationDecision, RuleId } from "@dues-banshee/engine";
import { buildFactSheet } from "./core/fact-sheet";
import { buildFinalText } from "./core/final-text";
import { engineHistory } from "./core/history";
import type { DraftLanguage } from "./core/model-output";
import { draftStep } from "./draft-step";
import { renderDocument } from "./io/documents/render";
import { loadBankRate } from "./load-bank-rate";
import type { ModelSet } from "./models";

/**
 * Result of an owner decision on a Draft. `expired` carries the recomputed Engine Decision so
 * `apps/web` can map it to its Wait_Text or Step_Text ("This draft is out of date: ...").
 */
export type DecideResult =
  | { kind: "ok" }
  | { kind: "not_found" }
  | { kind: "already_decided" }
  | { kind: "expired"; decision: EscalationDecision }
  | { kind: "empty_body" }
  | { kind: "draft_failed" };

export interface DecideDeps {
  db: Db;
}

export interface RedraftDeps {
  db: Db;
  models: ModelSet;
}

type Advance = Extract<EscalationDecision, { action: "advance" }>;

/** The Draft's stored rule IDs were validated against `RULE_IDS` when it was written. */
function toRuleIds(ids: readonly string[]): RuleId[] {
  return ids.filter((id): id is RuleId => (RULE_IDS as readonly string[]).includes(id));
}

/** The supplier's own pending Draft, or the reason it can't be decided. */
async function loadPending(
  db: Db,
  supplierId: string,
  draftId: string,
): Promise<{ ctx: DraftWithContext } | { result: DecideResult }> {
  const ctx = await getDraftForSupplier(db, supplierId, draftId);
  if (ctx === null) return { result: { kind: "not_found" } };
  if (ctx.draft.status !== "pending") return { result: { kind: "already_decided" } };
  return { ctx };
}

/** Recomputes the Engine Decision for the Draft's invoice. The Draft's own pending status plays no part. */
async function recompute(
  db: Db,
  supplierId: string,
  ctx: DraftWithContext,
  today: CalendarDate,
): Promise<{ record: LadderRecord; decision: EscalationDecision } | null> {
  const [record] = await listLadderRecords(db, supplierId, ctx.draft.invoiceId);
  if (record === undefined) return null;
  const history = engineHistory(record);
  const decision = nextEscalationStep(record.invoice, history, today, DEFAULT_LADDER_CONFIG);
  await logToolCall(db, {
    tool: "next_escalation_step",
    invoiceId: record.invoice.id,
    input: { invoice: record.invoice, history, today, config: DEFAULT_LADDER_CONFIG },
    output: decision,
  });
  return { record, decision };
}

function isSameStep(decision: EscalationDecision, ctx: DraftWithContext): decision is Advance {
  return decision.action === "advance" && decision.step === ctx.draft.step;
}

/** The Decision no longer matches: expire the Draft and write one `expired` event, nothing else. */
async function expireStale(
  db: Db,
  supplierId: string,
  ctx: DraftWithContext,
  decision: EscalationDecision,
  today: CalendarDate,
): Promise<DecideResult> {
  const expired = await db.transaction(async (tx) => {
    if (!(await setDraftStatus(tx, supplierId, ctx.draft.id, "expired"))) return false;
    await insertEscalationEvent(tx, {
      invoiceId: ctx.draft.invoiceId,
      step: ctx.draft.step,
      occurredOn: today,
      action: "expired",
      draftId: ctx.draft.id,
    });
    return true;
  });
  return expired ? { kind: "expired", decision } : { kind: "already_decided" };
}

/**
 * Owner approves a pending Draft. The Decision is recomputed first: if it is still `advance` with
 * the Draft's step, the Draft becomes `approved` and one Approved_Step_Event is written, in one
 * transaction. Otherwise the Draft becomes `expired` with an `expired` event, and the Decision is
 * returned. The conditional update lets only one of two overlapping decisions win. Sends nothing.
 */
export async function approveDraft(
  deps: DecideDeps,
  supplierId: string,
  draftId: string,
  today: CalendarDate,
): Promise<DecideResult> {
  const { db } = deps;
  const loaded = await loadPending(db, supplierId, draftId);
  if ("result" in loaded) return loaded.result;
  const { ctx } = loaded;

  const current = await recompute(db, supplierId, ctx, today);
  if (current === null) return { kind: "not_found" };
  if (!isSameStep(current.decision, ctx)) return expireStale(db, supplierId, ctx, current.decision, today);

  const approved = await db.transaction(async (tx) => {
    if (!(await setDraftStatus(tx, supplierId, draftId, "approved"))) return false;
    await insertEscalationEvent(tx, {
      invoiceId: ctx.draft.invoiceId,
      step: ctx.draft.step,
      occurredOn: today,
      action: "approved",
      draftId,
    });
    return true;
  });
  return approved ? { kind: "ok" } : { kind: "already_decided" };
}

/**
 * Owner edits the Body_Text of a pending Draft. The Final_Text is rebuilt from the new body, the
 * stored rule IDs and the Disclaimer; a `legal_notice` or `odr_pack` Document is re-rendered from it.
 * The Draft stays `pending`; one `edited` event holds `{ before, after }`. The edited text is the
 * owner's own and is not re-validated. The event is dated `today`, the day of the edit.
 */
export async function editDraft(
  deps: DecideDeps,
  supplierId: string,
  draftId: string,
  body: string,
  today: CalendarDate,
): Promise<DecideResult> {
  const { db } = deps;
  if (body.trim() === "") return { kind: "empty_body" };
  const loaded = await loadPending(db, supplierId, draftId);
  if ("result" in loaded) return loaded.result;
  const { draft } = loaded.ctx;
  const ruleIds = toRuleIds(draft.ruleIds);
  const finalText = buildFinalText(body, ruleIds);

  let document: Uint8Array | null = null;
  if (draft.step === "legal_notice" || draft.step === "odr_pack") {
    try {
      const supplier = await getSupplier(db, supplierId);
      const bankRate = await loadBankRate(db, draft.createdOn);
      const facts = buildFactSheet(loaded.ctx, draft.createdOn, bankRate);
      document = await renderDocument(draft.step, {
        supplier,
        facts,
        ruleIds,
        finalText,
        caveat: draft.decision.action === "advance" ? draft.decision.caveat : undefined,
      });
    } catch {
      return { kind: "draft_failed" };
    }
  }

  const edited = await db.transaction(async (tx) => {
    const updated = await updatePendingBody(tx, supplierId, draftId, body, finalText, document);
    if (updated === null) return false;
    await insertEscalationEvent(tx, {
      invoiceId: draft.invoiceId,
      step: draft.step,
      occurredOn: today,
      action: "edited",
      draftId,
      detail: { before: updated.before, after: body },
    });
    return true;
  });
  return edited ? { kind: "ok" } : { kind: "already_decided" };
}

/** Owner rejects a pending Draft; one `rejected` event holds the optional reason. */
export async function rejectDraft(
  deps: DecideDeps,
  supplierId: string,
  draftId: string,
  reason: string | null,
  today: CalendarDate,
): Promise<DecideResult> {
  const { db } = deps;
  const loaded = await loadPending(db, supplierId, draftId);
  if ("result" in loaded) return loaded.result;
  const { draft } = loaded.ctx;
  const trimmed = reason === null ? "" : reason.trim();

  const rejected = await db.transaction(async (tx) => {
    if (!(await setDraftStatus(tx, supplierId, draftId, "rejected"))) return false;
    await insertEscalationEvent(tx, {
      invoiceId: draft.invoiceId,
      step: draft.step,
      occurredOn: today,
      action: "rejected",
      draftId,
      detail: { reason: trimmed === "" ? null : trimmed },
    });
    return true;
  });
  return rejected ? { kind: "ok" } : { kind: "already_decided" };
}

/**
 * Owner asks for a new wording of a pending Draft. One Draft_Attempt runs first; only if it is
 * accepted does one transaction expire the old Draft (with its `expired` event) and insert the new
 * `pending` Draft with its `drafted` event, so the Pending_Index holds. If the attempt fails the old
 * Draft stays `pending`. A Decision that no longer matches expires the Draft, as in `approveDraft`.
 */
export async function redraft(
  deps: RedraftDeps,
  supplierId: string,
  draftId: string,
  language: DraftLanguage,
  today: CalendarDate,
): Promise<DecideResult> {
  const { db, models } = deps;
  const loaded = await loadPending(db, supplierId, draftId);
  if ("result" in loaded) return loaded.result;
  const { ctx } = loaded;

  const current = await recompute(db, supplierId, ctx, today);
  if (current === null) return { kind: "not_found" };
  if (!isSameStep(current.decision, ctx)) return expireStale(db, supplierId, ctx, current.decision, today);

  const supplier = await getSupplier(db, supplierId);
  const bankRate = await loadBankRate(db, today);
  const attempt = await draftStep(
    { db, models },
    { record: current.record, supplier, decision: current.decision, language, today, bankRate },
  );
  if (attempt.kind === "failed") return { kind: "draft_failed" };

  const replaced = await db.transaction(async (tx) => {
    if (!(await setDraftStatus(tx, supplierId, draftId, "expired"))) return false;
    await insertEscalationEvent(tx, {
      invoiceId: ctx.draft.invoiceId,
      step: ctx.draft.step,
      occurredOn: today,
      action: "expired",
      draftId,
    });
    await insertDraftRows(tx, attempt.draft, today);
    return true;
  });
  return replaced ? { kind: "ok" } : { kind: "already_decided" };
}
