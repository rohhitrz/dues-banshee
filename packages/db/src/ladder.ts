import type { CalendarDate, EscalationDecision, Invoice, LadderStep, Paise } from "@dues-banshee/engine";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import { toEngineInvoice } from "./invoices";
import {
  buyers,
  drafts,
  escalationEvents,
  invoices,
  promises,
  suppliers,
  type DraftRow,
  type EscalationDetail,
} from "./schema";

export type EscalationAction = typeof escalationEvents.$inferSelect.action;
export type DraftLanguage = DraftRow["language"];

/**
 * One invoice as the Ladder_Runner needs it: the Engine `Invoice`, the display fields the Engine
 * does not carry, every escalation event (with its `action`; the agent keeps only `approved` ones
 * for the Engine history), every promise, and the id of the pending Draft, if any.
 */
export interface LadderRecord {
  /** `toEngineInvoice(invoiceRow, supplierRow)`. */
  invoice: Invoice;
  invoiceDate: CalendarDate;
  acceptanceDateDefaulted: boolean;
  buyerName: string;
  invoiceNumber: string;
  /** Ordered by `occurred_on`, then row id. All actions are returned. */
  steps: { step: LadderStep; occurredOn: CalendarDate; action: EscalationAction; draftId: string | null }[];
  /** Ordered by `recorded_on`, then row id. */
  promises: { promisedDate: CalendarDate; amountPaise: Paise; recordedOn: CalendarDate }[];
  pendingDraftId: string | null;
}

/** A Draft to store. `createdOn` and the `drafted` event date come from the `today` argument of `insertDraft`. */
export interface NewDraft {
  invoiceId: string;
  step: LadderStep;
  language: DraftLanguage;
  bodyText: string;
  finalText: string;
  ruleIds: string[];
  modelId: string;
  decision: EscalationDecision;
  document: Uint8Array | null;
}

/** A Draft with the invoice, buyer and supplier facts the approval queue and the decisions need. */
export interface DraftWithContext {
  draft: DraftRow;
  /** `toEngineInvoice(invoiceRow, supplierRow)`. */
  invoice: Invoice;
  invoiceDate: CalendarDate;
  acceptanceDateDefaulted: boolean;
  /** `invoices.buyer_id`: the buyer this Draft is about (the Debtor_Page filters its Drafts by it). */
  buyerId: string;
  buyerName: string;
  invoiceNumber: string;
}

export interface NewEscalationEvent {
  invoiceId: string;
  step: LadderStep;
  occurredOn: CalendarDate;
  action: EscalationAction;
  draftId: string | null;
  detail?: EscalationDetail | null;
}

export type InsertDraftResult = { kind: "ok"; draftId: string } | { kind: "pending_exists" };

const PENDING_INDEX = "drafts_one_pending_per_invoice";
const UNIQUE_VIOLATION = "23505";

/**
 * Walks the `cause` chain (Drizzle wraps driver errors) looking for a unique violation (`23505`)
 * on the named constraint or index.
 */
export function isUniqueViolation(error: unknown, constraintName: string): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const { code, constraint, cause } = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (code === UNIQUE_VIOLATION && constraint === constraintName) return true;
    current = cause;
  }
  return false;
}

function isPendingDraftViolation(error: unknown): boolean {
  return isUniqueViolation(error, PENDING_INDEX);
}

/**
 * Reads everything the Ladder_Runner needs for one supplier, with four queries that are each
 * filtered by `invoices.supplier_id = supplierId` (events, promises and Drafts are joined through
 * `invoices`). Pass `invoiceId` to read one invoice. Returns `[]` for an unknown supplier or an
 * invoice that belongs to someone else. Ordered by invoice id, like `listGraveyardInvoices`.
 */
export async function listLadderRecords(db: Db, supplierId: string, invoiceId?: string): Promise<LadderRecord[]> {
  const invoiceScope =
    invoiceId === undefined
      ? eq(invoices.supplierId, supplierId)
      : and(eq(invoices.supplierId, supplierId), eq(invoices.id, invoiceId));

  const invoiceRows = await db
    .select({ invoice: invoices, buyerName: buyers.name, supplier: suppliers })
    .from(invoices)
    .innerJoin(buyers, and(eq(buyers.id, invoices.buyerId), eq(buyers.supplierId, invoices.supplierId)))
    .innerJoin(suppliers, eq(suppliers.id, invoices.supplierId))
    .where(invoiceScope)
    .orderBy(asc(invoices.id));

  const stepRows = await db
    .select({
      invoiceId: escalationEvents.invoiceId,
      step: escalationEvents.step,
      occurredOn: escalationEvents.occurredOn,
      action: escalationEvents.action,
      draftId: escalationEvents.draftId,
    })
    .from(escalationEvents)
    .innerJoin(invoices, eq(invoices.id, escalationEvents.invoiceId))
    .where(invoiceScope)
    .orderBy(asc(escalationEvents.occurredOn), asc(escalationEvents.id));

  const promiseRows = await db
    .select({
      invoiceId: promises.invoiceId,
      promisedDate: promises.promisedDate,
      amountPaise: promises.amountPaise,
      recordedOn: promises.recordedOn,
    })
    .from(promises)
    .innerJoin(invoices, eq(invoices.id, promises.invoiceId))
    .where(invoiceScope)
    .orderBy(asc(promises.recordedOn), asc(promises.id));

  const pendingRows = await db
    .select({ invoiceId: drafts.invoiceId, draftId: drafts.id })
    .from(drafts)
    .innerJoin(invoices, eq(invoices.id, drafts.invoiceId))
    .where(and(invoiceScope, eq(drafts.status, "pending")));

  const stepsBy = new Map<string, LadderRecord["steps"]>();
  for (const s of stepRows) {
    const item = { step: s.step, occurredOn: s.occurredOn, action: s.action, draftId: s.draftId };
    const list = stepsBy.get(s.invoiceId);
    if (list) list.push(item);
    else stepsBy.set(s.invoiceId, [item]);
  }
  const promisesBy = new Map<string, LadderRecord["promises"]>();
  for (const p of promiseRows) {
    const item = { promisedDate: p.promisedDate, amountPaise: p.amountPaise, recordedOn: p.recordedOn };
    const list = promisesBy.get(p.invoiceId);
    if (list) list.push(item);
    else promisesBy.set(p.invoiceId, [item]);
  }
  const pendingBy = new Map<string, string>();
  for (const p of pendingRows) pendingBy.set(p.invoiceId, p.draftId);

  return invoiceRows.map((r) => ({
    invoice: toEngineInvoice(r.invoice, r.supplier),
    invoiceDate: r.invoice.invoiceDate,
    acceptanceDateDefaulted: r.invoice.acceptanceDateDefaulted,
    buyerName: r.buyerName,
    invoiceNumber: r.invoice.invoiceNumber,
    steps: stepsBy.get(r.invoice.id) ?? [],
    promises: promisesBy.get(r.invoice.id) ?? [],
    pendingDraftId: pendingBy.get(r.invoice.id) ?? null,
  }));
}

/** Every supplier a daily run covers. `udyamNumber` lets the caller pick out the demo supplier. */
export async function listRunSuppliers(db: Db): Promise<{ id: string; udyamNumber: string }[]> {
  return db
    .select({ id: suppliers.id, udyamNumber: suppliers.udyamNumber })
    .from(suppliers)
    .orderBy(asc(suppliers.createdAt), asc(suppliers.id));
}

/**
 * Stores a `pending` Draft and its `drafted` Escalation_Event in one transaction. If the invoice
 * already has a pending Draft (`drafts_one_pending_per_invoice`), the transaction rolls back, so no
 * event is written, and `pending_exists` is returned. Any other error is rethrown.
 */
export async function insertDraft(db: Db, d: NewDraft, today: CalendarDate): Promise<InsertDraftResult> {
  try {
    const draftId = await db.transaction((tx) => insertDraftRows(tx, d, today));
    return { kind: "ok", draftId };
  } catch (error) {
    if (isPendingDraftViolation(error)) return { kind: "pending_exists" };
    throw error;
  }
}

/**
 * The transaction-friendly part of `insertDraft`: inserts the `pending` Draft and its `drafted`
 * event on the handle it is given, so a caller can combine it with other writes (a redraft expires
 * the old Draft first, in the same transaction). A pending-Draft unique violation is thrown, not caught.
 */
export async function insertDraftRows(tx: Db, d: NewDraft, today: CalendarDate): Promise<string> {
  const [row] = await tx
    .insert(drafts)
    .values({
      invoiceId: d.invoiceId,
      step: d.step,
      language: d.language,
      bodyText: d.bodyText,
      finalText: d.finalText,
      ruleIds: d.ruleIds,
      modelId: d.modelId,
      decision: d.decision,
      document: d.document,
      createdOn: today,
    })
    .returning({ id: drafts.id });
  if (row === undefined) throw new Error("insertDraft: no row returned");
  await insertEscalationEvent(tx, {
    invoiceId: d.invoiceId,
    step: d.step,
    occurredOn: today,
    action: "drafted",
    draftId: row.id,
  });
  return row.id;
}

function toDraftWithContext(r: {
  draft: DraftRow;
  invoice: typeof invoices.$inferSelect;
  supplier: typeof suppliers.$inferSelect;
  buyerName: string;
}): DraftWithContext {
  return {
    draft: r.draft,
    invoice: toEngineInvoice(r.invoice, r.supplier),
    invoiceDate: r.invoice.invoiceDate,
    acceptanceDateDefaulted: r.invoice.acceptanceDateDefaulted,
    buyerId: r.invoice.buyerId,
    buyerName: r.buyerName,
    invoiceNumber: r.invoice.invoiceNumber,
  };
}

/** One Draft, only if its invoice belongs to `supplierId`; otherwise `null` (same as "does not exist"). */
export async function getDraftForSupplier(
  db: Db,
  supplierId: string,
  draftId: string,
): Promise<DraftWithContext | null> {
  const [row] = await db
    .select({ draft: drafts, invoice: invoices, supplier: suppliers, buyerName: buyers.name })
    .from(drafts)
    .innerJoin(invoices, eq(invoices.id, drafts.invoiceId))
    .innerJoin(buyers, and(eq(buyers.id, invoices.buyerId), eq(buyers.supplierId, invoices.supplierId)))
    .innerJoin(suppliers, eq(suppliers.id, invoices.supplierId))
    .where(and(eq(invoices.supplierId, supplierId), eq(drafts.id, draftId)))
    .limit(1);
  return row === undefined ? null : toDraftWithContext(row);
}

/** The supplier's pending Drafts, oldest first (`created_at`, then id). */
export async function listPendingDrafts(db: Db, supplierId: string): Promise<DraftWithContext[]> {
  const rows = await db
    .select({ draft: drafts, invoice: invoices, supplier: suppliers, buyerName: buyers.name })
    .from(drafts)
    .innerJoin(invoices, eq(invoices.id, drafts.invoiceId))
    .innerJoin(buyers, and(eq(buyers.id, invoices.buyerId), eq(buyers.supplierId, invoices.supplierId)))
    .innerJoin(suppliers, eq(suppliers.id, invoices.supplierId))
    .where(and(eq(invoices.supplierId, supplierId), eq(drafts.status, "pending")))
    .orderBy(asc(drafts.createdAt), asc(drafts.id));
  return rows.map(toDraftWithContext);
}

/**
 * Moves a `pending` Draft of this supplier to `to`. Returns `false` when the Draft does not exist,
 * belongs to another supplier or is no longer pending, so two overlapping decisions can't both win.
 */
export async function setDraftStatus(
  tx: Db,
  supplierId: string,
  draftId: string,
  to: "approved" | "rejected" | "expired",
): Promise<boolean> {
  const rows = await tx
    .update(drafts)
    .set({ status: to, decidedAt: sql`now()` })
    .from(invoices)
    .where(
      and(
        eq(drafts.invoiceId, invoices.id),
        eq(invoices.supplierId, supplierId),
        eq(drafts.id, draftId),
        eq(drafts.status, "pending"),
      ),
    )
    .returning({ id: drafts.id });
  return rows.length > 0;
}

/**
 * Replaces the body, Final_Text and document of a `pending` Draft of this supplier and returns the
 * body it had before, or `null` when the Draft does not exist, belongs to another supplier or is no
 * longer pending. The row is read `FOR UPDATE` first (inside the caller's transaction the lock is
 * held until commit), then updated with the same conditions, so `before` is the text it replaced.
 */
export async function updatePendingBody(
  tx: Db,
  supplierId: string,
  draftId: string,
  body: string,
  finalText: string,
  document: Uint8Array | null,
): Promise<{ before: string } | null> {
  const [current] = await tx
    .select({ bodyText: drafts.bodyText })
    .from(drafts)
    .innerJoin(invoices, eq(invoices.id, drafts.invoiceId))
    .where(and(eq(invoices.supplierId, supplierId), eq(drafts.id, draftId), eq(drafts.status, "pending")))
    .for("update", { of: drafts });
  if (current === undefined) return null;

  const rows = await tx
    .update(drafts)
    .set({ bodyText: body, finalText, document })
    .from(invoices)
    .where(
      and(
        eq(drafts.invoiceId, invoices.id),
        eq(invoices.supplierId, supplierId),
        eq(drafts.id, draftId),
        eq(drafts.status, "pending"),
      ),
    )
    .returning({ id: drafts.id });
  return rows.length > 0 ? { before: current.bodyText } : null;
}

/** Appends one row to the escalation audit trail. Only `action = 'approved'` rows count as ladder steps. */
export async function insertEscalationEvent(tx: Db, e: NewEscalationEvent): Promise<void> {
  await tx.insert(escalationEvents).values({
    invoiceId: e.invoiceId,
    step: e.step,
    occurredOn: e.occurredOn,
    action: e.action,
    draftId: e.draftId,
    detail: e.detail ?? null,
  });
}
