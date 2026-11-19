import type { CalendarDate, Invoice, Paise } from "@dues-banshee/engine";
import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Db } from "./client";
import { toEngineInvoice } from "./invoices";
import {
  buyers,
  invoices,
  promises,
  suppliers,
  voiceCalls,
  voiceToolCalls,
  voiceTranscriptLines,
  type VoiceCallRow,
} from "./schema";

/** A Join_Token is valid for 10 minutes from creation. */
const TOKEN_TTL_MS = 600_000;
/** Call_Cap: a call lasts at most 300 seconds from `started_at`. */
const CALL_CAP_SECONDS = 300;
/** A live call with no End_Report this long after `started_at` is ended by the next read. */
const STALE_AFTER_SECONDS = 360;
/** Transcript text is cut to its first 2,000 characters. */
const TRANSCRIPT_MAX_CHARS = 2000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids that come from a request must not reach a `uuid` column unchecked: Postgres would throw. */
function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export type VoiceCallStatus = VoiceCallRow["status"];
export type VoiceCallOutcome = NonNullable<VoiceCallRow["outcome"]>;
/** The outcomes the `end_call` tool may request. */
export type RequestedCallOutcome = Extract<VoiceCallOutcome, "dispute" | "no_promise" | "consent_declined">;
export type TranscriptSpeaker = typeof voiceTranscriptLines.$inferSelect.speaker;

/** The invoice a "Start call" click is about, read only if it belongs to the supplier. */
export interface CallInvoice {
  invoiceId: string;
  buyerId: string;
  buyerName: string;
  invoiceNumber: string;
  supplierName: string;
  /** Identifies the Demo_Supplier. */
  udyamNumber: string;
}

/**
 * Reads one invoice for the start-call action, only if it belongs to `supplierId`. Returns `null`
 * for an id that is not a uuid, an unknown invoice and another supplier's invoice (all look the same).
 */
export async function findInvoiceForCall(
  db: Db,
  supplierId: string,
  invoiceId: string,
): Promise<CallInvoice | null> {
  if (!isUuid(invoiceId)) return null;
  const [row] = await db
    .select({
      invoiceId: invoices.id,
      buyerId: invoices.buyerId,
      buyerName: buyers.name,
      invoiceNumber: invoices.invoiceNumber,
      supplierName: suppliers.name,
      udyamNumber: suppliers.udyamNumber,
    })
    .from(invoices)
    .innerJoin(buyers, and(eq(buyers.id, invoices.buyerId), eq(buyers.supplierId, invoices.supplierId)))
    .innerJoin(suppliers, eq(suppliers.id, invoices.supplierId))
    .where(and(eq(invoices.supplierId, supplierId), eq(invoices.id, invoiceId)))
    .limit(1);
  return row ?? null;
}

/**
 * Counts this supplier's Voice_Calls whose `started_at` is in `[start, end)` (a Call_Day from
 * `istDayBounds`). With `buyerId` it counts that buyer's calls only (the one-call-per-buyer rule);
 * without it, every call of the supplier (the Demo_Call_Limit). Scoped through `invoices.supplier_id`.
 */
export async function countStartedCalls(
  db: Db,
  scope: { supplierId: string; buyerId?: string },
  bounds: { start: Date; end: Date },
): Promise<number> {
  if (scope.buyerId !== undefined && !isUuid(scope.buyerId)) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(voiceCalls)
    .innerJoin(invoices, eq(invoices.id, voiceCalls.invoiceId))
    .where(
      and(
        eq(invoices.supplierId, scope.supplierId),
        scope.buyerId === undefined ? undefined : eq(voiceCalls.buyerId, scope.buyerId),
        sql`${voiceCalls.startedAt} >= ${bounds.start.toISOString()}::timestamptz`,
        sql`${voiceCalls.startedAt} < ${bounds.end.toISOString()}::timestamptz`,
      ),
    );
  return row?.n ?? 0;
}

/**
 * Creates one Voice_Call in one transaction: sets every `created` call of the invoice's buyer to
 * `expired`, then inserts the new row with `token_expires_at` = `now` + 600 s. The buyer is read
 * from the invoice, never passed in. Returns `null` when the invoice is not this supplier's.
 * `tokenHash` is the SHA-256 hex of the Join_Token; the token itself never reaches this package.
 */
export async function createVoiceCall(
  db: Db,
  row: { supplierId: string; invoiceId: string; callToday: CalendarDate; tokenHash: string; now: Date },
): Promise<{ voiceCallId: string; buyerId: string; tokenExpiresAt: Date } | null> {
  if (!isUuid(row.invoiceId)) return null;
  return db.transaction(async (tx) => {
    const [invoice] = await tx
      .select({ buyerId: invoices.buyerId })
      .from(invoices)
      .where(and(eq(invoices.supplierId, row.supplierId), eq(invoices.id, row.invoiceId)))
      .limit(1);
    if (invoice === undefined) return null;

    await tx
      .update(voiceCalls)
      .set({ status: "expired" })
      .where(and(eq(voiceCalls.buyerId, invoice.buyerId), eq(voiceCalls.status, "created")));

    const tokenExpiresAt = new Date(row.now.getTime() + TOKEN_TTL_MS);
    const [created] = await tx
      .insert(voiceCalls)
      .values({
        invoiceId: row.invoiceId,
        buyerId: invoice.buyerId,
        callToday: row.callToday,
        tokenHash: row.tokenHash,
        tokenExpiresAt,
        status: "created",
        createdAt: row.now,
      })
      .returning({ id: voiceCalls.id });
    if (created === undefined) throw new Error("createVoiceCall: no row returned");
    return { voiceCallId: created.id, buyerId: invoice.buyerId, tokenExpiresAt };
  });
}

/**
 * The Call_Page read: the supplier name of the Voice_Call with this token hash, only while it is
 * `created` and before `token_expires_at`. `null` for every other case, so the page cannot tell them apart.
 */
export async function findJoinableCall(
  db: Db,
  tokenHash: string,
  now: Date,
): Promise<{ voiceCallId: string; supplierName: string } | null> {
  const [row] = await db
    .select({ voiceCallId: voiceCalls.id, supplierName: suppliers.name })
    .from(voiceCalls)
    .innerJoin(invoices, eq(invoices.id, voiceCalls.invoiceId))
    .innerJoin(suppliers, eq(suppliers.id, invoices.supplierId))
    .where(
      and(eq(voiceCalls.tokenHash, tokenHash), eq(voiceCalls.status, "created"), gt(voiceCalls.tokenExpiresAt, now)),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Joins the call: one conditional `UPDATE … WHERE status = 'created' AND token_expires_at > now
 * RETURNING`. Sets `live` and `started_at` = `now`. Concurrent joins serialise on the row lock, so
 * only one gets a result; the rest get `null`.
 */
export async function claimJoin(db: Db, tokenHash: string, now: Date): Promise<{ voiceCallId: string } | null> {
  const rows = await db
    .update(voiceCalls)
    .set({ status: "live", startedAt: now })
    .where(
      and(eq(voiceCalls.tokenHash, tokenHash), eq(voiceCalls.status, "created"), gt(voiceCalls.tokenExpiresAt, now)),
    )
    .returning({ voiceCallId: voiceCalls.id });
  return rows[0] ?? null;
}

/** Everything the handlers need about one Voice_Call: ids, call data, and the Engine `Invoice`. */
export interface CallContext {
  voiceCallId: string;
  status: VoiceCallStatus;
  invoiceId: string;
  buyerId: string;
  supplierId: string;
  callToday: CalendarDate;
  startedAt: Date | null;
  supplierName: string;
  buyerName: string;
  invoiceNumber: string;
  /** `toEngineInvoice(invoiceRow, supplierRow)`. */
  invoice: Invoice;
}

/**
 * Reads one Voice_Call with its invoice, buyer and supplier. The invoice, supplier and `call_today`
 * come from the stored row, never from the client. `null` for an unknown id.
 */
export async function getCallContext(db: Db, voiceCallId: string): Promise<CallContext | null> {
  if (!isUuid(voiceCallId)) return null;
  const [row] = await db
    .select({ call: voiceCalls, invoice: invoices, buyerName: buyers.name, supplier: suppliers })
    .from(voiceCalls)
    .innerJoin(invoices, eq(invoices.id, voiceCalls.invoiceId))
    .innerJoin(buyers, and(eq(buyers.id, invoices.buyerId), eq(buyers.supplierId, invoices.supplierId)))
    .innerJoin(suppliers, eq(suppliers.id, invoices.supplierId))
    .where(eq(voiceCalls.id, voiceCallId))
    .limit(1);
  if (row === undefined) return null;
  return {
    voiceCallId: row.call.id,
    status: row.call.status,
    invoiceId: row.invoice.id,
    buyerId: row.call.buyerId,
    supplierId: row.invoice.supplierId,
    callToday: row.call.callToday,
    startedAt: row.call.startedAt,
    supplierName: row.supplier.name,
    buyerName: row.buyerName,
    invoiceNumber: row.invoice.invoiceNumber,
    invoice: toEngineInvoice(row.invoice, row.supplier),
  };
}

/** A `live` Voice_Call read under a row lock. */
export interface LiveCall {
  voiceCallId: string;
  invoiceId: string;
  buyerId: string;
  callToday: CalendarDate;
  startedAt: Date;
  requestedOutcome: RequestedCallOutcome | null;
}

/**
 * Locks one Voice_Call (`SELECT … FOR UPDATE`) if its id and token hash match and it is `live`.
 * Call it first in a Tool_Endpoint transaction: an End_Report waits for an in-flight promise
 * (lock order: voice call, then invoice). Pass the transaction handle as `tx`. `null` when nothing
 * matches or the call is not live.
 */
export async function lockLiveCall(tx: Db, voiceCallId: string, tokenHash: string): Promise<LiveCall | null> {
  if (!isUuid(voiceCallId)) return null;
  const [row] = await tx
    .select({
      voiceCallId: voiceCalls.id,
      invoiceId: voiceCalls.invoiceId,
      buyerId: voiceCalls.buyerId,
      callToday: voiceCalls.callToday,
      startedAt: voiceCalls.startedAt,
      requestedOutcome: voiceCalls.requestedOutcome,
    })
    .from(voiceCalls)
    .where(
      and(eq(voiceCalls.id, voiceCallId), eq(voiceCalls.tokenHash, tokenHash), eq(voiceCalls.status, "live")),
    )
    .limit(1)
    .for("update");
  if (row === undefined || row.startedAt === null) return null;
  const requested = row.requestedOutcome;
  if (requested === "promise" || requested === "incomplete") return null; // the check constraint forbids these
  return { ...row, startedAt: row.startedAt, requestedOutcome: requested };
}

/**
 * Matches a Voice_Call by id and token hash in any status, without a lock. For the End_Report and
 * transcript routes, which answer 404 only when nothing matches. `null` for no match.
 */
export async function findCallByIdAndHash(
  db: Db,
  voiceCallId: string,
  tokenHash: string,
): Promise<{ voiceCallId: string; status: VoiceCallStatus; buyerId: string; invoiceId: string } | null> {
  if (!isUuid(voiceCallId)) return null;
  const [row] = await db
    .select({
      voiceCallId: voiceCalls.id,
      status: voiceCalls.status,
      buyerId: voiceCalls.buyerId,
      invoiceId: voiceCalls.invoiceId,
    })
    .from(voiceCalls)
    .where(and(eq(voiceCalls.id, voiceCallId), eq(voiceCalls.tokenHash, tokenHash)))
    .limit(1);
  return row ?? null;
}

// Qualified column names for the `UPDATE … SET` expressions below. Plain column objects could render
// unqualified inside the `promises` subquery and bind to the wrong table.
const VC_ID = sql.raw(`"voice_calls"."id"`);
const VC_STARTED_AT = sql.raw(`"voice_calls"."started_at"`);
const VC_REQUESTED = sql.raw(`"voice_calls"."requested_outcome"`);

/** `promise` if a promise row carries this call's id, else the requested outcome, else `incomplete`. */
const OUTCOME_SQL: SQL = sql`CASE
  WHEN EXISTS (SELECT 1 FROM "promises" "p" WHERE "p"."voice_call_id" = ${VC_ID}) THEN 'promise'::voice_call_outcome
  WHEN ${VC_REQUESTED} IS NOT NULL THEN ${VC_REQUESTED}
  ELSE 'incomplete'::voice_call_outcome
END`;

/** The `SET` of an end: status, `ended_at`, duration (whole seconds, 0 to 300) and outcome. */
function endSet(endedAt: SQL): {
  status: "ended";
  endedAt: SQL;
  durationSeconds: SQL;
  outcome: SQL;
} {
  return {
    status: "ended",
    endedAt,
    durationSeconds: sql`least(${CALL_CAP_SECONDS}, greatest(0, floor(extract(epoch from (${endedAt} - ${VC_STARTED_AT})))::int))`,
    outcome: OUTCOME_SQL,
  };
}

function instant(d: Date): SQL {
  return sql`${d.toISOString()}::timestamptz`;
}

/**
 * Ends a `live` Voice_Call in one statement. The outcome comes from server data only (a promise
 * row of this call, else the requested outcome, else `incomplete`) and the duration is capped at
 * 300 s. Changes nothing for a call that is not `live`. Returns the buyer id when it ended the
 * call (for revalidation), else `null`.
 */
export async function endVoiceCall(
  db: Db,
  voiceCallId: string,
  endedAt: Date,
): Promise<{ buyerId: string } | null> {
  if (!isUuid(voiceCallId)) return null;
  const rows = await db
    .update(voiceCalls)
    .set(endSet(instant(endedAt)))
    .where(and(eq(voiceCalls.id, voiceCallId), eq(voiceCalls.status, "live")))
    .returning({ buyerId: voiceCalls.buyerId });
  return rows[0] ?? null;
}

/**
 * The End_Report path of `endVoiceCall`: one transaction that first locks the row
 * (`SELECT … FOR UPDATE`) and then runs the end `UPDATE` as a separate statement. A tool request
 * that is still recording a promise holds that lock (`lockLiveCall`), so the end waits for it, and
 * the `EXISTS (promises)` outcome check in the `UPDATE` takes a fresh snapshot after the wait
 * (Postgres READ COMMITTED: each statement sees what was committed when it started). A single
 * `UPDATE` would evaluate the `EXISTS` against the snapshot taken before the wait.
 */
export async function endVoiceCallAfterLock(
  db: Db,
  voiceCallId: string,
  endedAt: Date,
): Promise<{ buyerId: string } | null> {
  if (!isUuid(voiceCallId)) return null;
  return db.transaction(async (tx) => {
    const locked = await tx
      .select({ id: voiceCalls.id })
      .from(voiceCalls)
      .where(and(eq(voiceCalls.id, voiceCallId), eq(voiceCalls.status, "live")))
      .for("update");
    if (locked.length === 0) return null; // not live any more, or ended while this request waited
    return endVoiceCall(tx, voiceCallId, endedAt);
  });
}

/**
 * Ends every `live` call that has had no End_Report 360 s after `started_at`, with
 * `ended_at` = `started_at` + 300 s, scoped either to one call or to one supplier's buyer (through
 * `invoices.supplier_id`). Run it before reading calls. Returns the ids of the buyers whose calls ended.
 */
export async function endStaleCalls(
  db: Db,
  now: Date,
  scope: { voiceCallId: string } | { supplierId: string; buyerId: string },
): Promise<string[]> {
  let scoped: SQL | undefined;
  if ("voiceCallId" in scope) {
    if (!isUuid(scope.voiceCallId)) return [];
    scoped = eq(voiceCalls.id, scope.voiceCallId);
  } else {
    if (!isUuid(scope.buyerId)) return [];
    scoped = and(
      eq(voiceCalls.buyerId, scope.buyerId),
      inArray(
        voiceCalls.invoiceId,
        db.select({ id: invoices.id }).from(invoices).where(eq(invoices.supplierId, scope.supplierId)),
      ),
    );
  }
  const staleWhere = and(
    scoped,
    eq(voiceCalls.status, "live"),
    sql`${instant(now)} >= ${VC_STARTED_AT} + make_interval(secs => ${STALE_AFTER_SECONDS})`,
  );
  // Lock the matching rows first, then end them in a separate statement, so the outcome check sees
  // promises committed while this request waited for a tool request (see `endVoiceCallAfterLock`).
  return db.transaction(async (tx) => {
    const locked = await tx.select({ id: voiceCalls.id }).from(voiceCalls).where(staleWhere).for("update");
    if (locked.length === 0) return [];
    const rows = await tx
      .update(voiceCalls)
      .set(endSet(sql`${VC_STARTED_AT} + make_interval(secs => ${CALL_CAP_SECONDS})`))
      .where(
        and(
          inArray(
            voiceCalls.id,
            locked.map((r) => r.id),
          ),
          eq(voiceCalls.status, "live"),
        ),
      )
      .returning({ buyerId: voiceCalls.buyerId });
    return [...new Set(rows.map((r) => r.buyerId))];
  });
}

/**
 * Claims one model function call: `INSERT … ON CONFLICT DO NOTHING RETURNING`. `claimed` means this
 * request runs the tool and must call `storeToolResult`. `repeat` means the `call_id` was answered
 * before; `result` is the stored result (also a stored error result). A concurrent duplicate waits on
 * the unique key and then reads the committed row. Run it in the transaction that holds `lockLiveCall`.
 */
export async function claimToolCall(
  tx: Db,
  row: { voiceCallId: string; callId: string; tool: string; arguments: string; now: Date },
): Promise<{ kind: "claimed" } | { kind: "repeat"; result: unknown }> {
  const inserted = await tx
    .insert(voiceToolCalls)
    .values({
      voiceCallId: row.voiceCallId,
      callId: row.callId,
      tool: row.tool,
      arguments: row.arguments,
      createdAt: row.now,
    })
    .onConflictDoNothing({ target: [voiceToolCalls.voiceCallId, voiceToolCalls.callId] })
    .returning({ id: voiceToolCalls.id });
  if (inserted.length > 0) return { kind: "claimed" };

  const [existing] = await tx
    .select({ result: voiceToolCalls.result })
    .from(voiceToolCalls)
    .where(and(eq(voiceToolCalls.voiceCallId, row.voiceCallId), eq(voiceToolCalls.callId, row.callId)))
    .limit(1);
  return { kind: "repeat", result: existing?.result ?? null };
}

/** Stores the result of a claimed tool call, so a repeated `call_id` returns it. */
export async function storeToolResult(tx: Db, voiceCallId: string, callId: string, result: unknown): Promise<void> {
  await tx
    .update(voiceToolCalls)
    .set({ result: result === undefined ? null : result })
    .where(and(eq(voiceToolCalls.voiceCallId, voiceCallId), eq(voiceToolCalls.callId, callId)));
}

/** A voice promise to store. Range and window checks are the caller's job. */
export interface NewVoicePromise {
  voiceCallId: string;
  invoiceId: string;
  /** The call's `call_today`: becomes `recorded_on` and the supersede day. */
  callToday: CalendarDate;
  promisedDate: CalendarDate;
  amountPaise: Paise;
  spokenText: string;
  isPartial: boolean;
  now: Date;
}

/**
 * Records a promise in the caller's transaction: locks the invoice row (`FOR UPDATE`, after the
 * voice call lock), sets `superseded_on` = `callToday` on the invoice's Current_Promise, then inserts
 * the new `source = 'voice'` row. Afterwards the invoice has exactly one Current_Promise, also when
 * two requests overlap. A Current_Promise recorded after `callToday` is superseded on its own
 * `recorded_on` instead, because `superseded_on` can't precede `recorded_on`.
 */
export async function recordVoicePromise(tx: Db, p: NewVoicePromise): Promise<{ promiseId: string }> {
  await tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.id, p.invoiceId)).for("update");

  await tx
    .update(promises)
    .set({ supersededOn: sql`greatest(${p.callToday}::date, ${promises.recordedOn})` })
    .where(and(eq(promises.invoiceId, p.invoiceId), isNull(promises.supersededOn)));

  const [row] = await tx
    .insert(promises)
    .values({
      invoiceId: p.invoiceId,
      promisedDate: p.promisedDate,
      amountPaise: p.amountPaise,
      recordedOn: p.callToday,
      source: "voice",
      voiceCallId: p.voiceCallId,
      spokenText: p.spokenText,
      isPartial: p.isPartial,
      createdAt: p.now,
    })
    .returning({ id: promises.id });
  if (row === undefined) throw new Error("recordVoicePromise: no row returned");
  return { promiseId: row.id };
}

/**
 * Stores the outcome the `end_call` tool asked for, replacing an earlier one. Only a `live` call
 * changes. Returns whether a row changed.
 */
export async function setRequestedOutcome(
  tx: Db,
  voiceCallId: string,
  outcome: RequestedCallOutcome,
): Promise<boolean> {
  const rows = await tx
    .update(voiceCalls)
    .set({ requestedOutcome: outcome })
    .where(and(eq(voiceCalls.id, voiceCallId), eq(voiceCalls.status, "live")))
    .returning({ id: voiceCalls.id });
  return rows.length > 0;
}

/**
 * Stores one Transcript_Line. Empty (blank) text is skipped, longer text is cut to its first 2,000
 * characters, and a repeated Realtime `itemId` is dropped. `receivedAt` is the instant the server
 * received it. Returns what happened. The caller has already matched a `live` call.
 */
export async function insertTranscriptLine(
  db: Db,
  line: { voiceCallId: string; speaker: TranscriptSpeaker; itemId: string; text: string; now: Date },
): Promise<"inserted" | "duplicate" | "skipped"> {
  if (line.text.trim() === "") return "skipped";
  // Cut by code point, so a surrogate pair is never split into text Postgres would reject.
  const text = Array.from(line.text).slice(0, TRANSCRIPT_MAX_CHARS).join("");
  const rows = await db
    .insert(voiceTranscriptLines)
    .values({
      voiceCallId: line.voiceCallId,
      speaker: line.speaker,
      itemId: line.itemId,
      text,
      receivedAt: line.now,
    })
    .onConflictDoNothing({ target: [voiceTranscriptLines.voiceCallId, voiceTranscriptLines.itemId] })
    .returning({ id: voiceTranscriptLines.id });
  return rows.length > 0 ? "inserted" : "duplicate";
}

/** One joined Voice_Call of a buyer, with its transcript and tool calls, for the Debtor_Page. */
export interface BuyerVoiceCall {
  id: string;
  invoiceId: string;
  callToday: CalendarDate;
  status: VoiceCallStatus;
  startedAt: Date;
  endedAt: Date | null;
  durationSeconds: number | null;
  outcome: VoiceCallOutcome | null;
  /** Ordered by `received_at`, then row id. */
  transcript: { id: string; speaker: TranscriptSpeaker; text: string; receivedAt: Date }[];
  /** Ordered by `created_at`, then row id. */
  toolCalls: { id: string; callId: string; tool: string; arguments: string; result: unknown; createdAt: Date }[];
}

/**
 * Reads the joined calls (`started_at` set) of one of the supplier's buyers, oldest first. Ends
 * stale calls first, so a call nobody reported on shows as `ended`. Every query is scoped through
 * `invoices.supplier_id`; another supplier's buyer returns `[]`.
 */
export async function listBuyerVoiceCalls(
  db: Db,
  supplierId: string,
  buyerId: string,
  now: Date,
): Promise<BuyerVoiceCall[]> {
  if (!isUuid(buyerId)) return [];
  await endStaleCalls(db, now, { supplierId, buyerId });

  const callRows = await db
    .select({
      id: voiceCalls.id,
      invoiceId: voiceCalls.invoiceId,
      callToday: voiceCalls.callToday,
      status: voiceCalls.status,
      startedAt: voiceCalls.startedAt,
      endedAt: voiceCalls.endedAt,
      durationSeconds: voiceCalls.durationSeconds,
      outcome: voiceCalls.outcome,
    })
    .from(voiceCalls)
    .innerJoin(invoices, eq(invoices.id, voiceCalls.invoiceId))
    .where(
      and(eq(invoices.supplierId, supplierId), eq(voiceCalls.buyerId, buyerId), isNotNull(voiceCalls.startedAt)),
    )
    .orderBy(asc(voiceCalls.startedAt), asc(voiceCalls.id));
  if (callRows.length === 0) return [];
  const ids = callRows.map((c) => c.id);

  const lineRows = await db
    .select({
      id: voiceTranscriptLines.id,
      voiceCallId: voiceTranscriptLines.voiceCallId,
      speaker: voiceTranscriptLines.speaker,
      text: voiceTranscriptLines.text,
      receivedAt: voiceTranscriptLines.receivedAt,
    })
    .from(voiceTranscriptLines)
    .where(inArray(voiceTranscriptLines.voiceCallId, ids))
    .orderBy(asc(voiceTranscriptLines.receivedAt), asc(voiceTranscriptLines.id));

  const toolRows = await db
    .select({
      id: voiceToolCalls.id,
      voiceCallId: voiceToolCalls.voiceCallId,
      callId: voiceToolCalls.callId,
      tool: voiceToolCalls.tool,
      arguments: voiceToolCalls.arguments,
      result: voiceToolCalls.result,
      createdAt: voiceToolCalls.createdAt,
    })
    .from(voiceToolCalls)
    .where(inArray(voiceToolCalls.voiceCallId, ids))
    .orderBy(asc(voiceToolCalls.createdAt), asc(voiceToolCalls.id));

  const result: BuyerVoiceCall[] = [];
  for (const c of callRows) {
    if (c.startedAt === null) continue; // excluded by the query; narrows the type
    result.push({
      id: c.id,
      invoiceId: c.invoiceId,
      callToday: c.callToday,
      status: c.status,
      startedAt: c.startedAt,
      endedAt: c.endedAt,
      durationSeconds: c.durationSeconds,
      outcome: c.outcome,
      transcript: lineRows
        .filter((l) => l.voiceCallId === c.id)
        .map((l) => ({ id: l.id, speaker: l.speaker, text: l.text, receivedAt: l.receivedAt })),
      toolCalls: toolRows
        .filter((t) => t.voiceCallId === c.id)
        .map((t) => ({
          id: t.id,
          callId: t.callId,
          tool: t.tool,
          arguments: t.arguments,
          result: t.result,
          createdAt: t.createdAt,
        })),
    });
  }
  return result;
}
