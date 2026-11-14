import { logToolCall } from "@dues-banshee/db";
import type { Db, LadderRecord, NewDraft, Supplier } from "@dues-banshee/db";
import { RULE_IDS } from "@dues-banshee/engine";
import type { BankRate, CalendarDate, EscalationDecision } from "@dues-banshee/engine";
import { allowedRuleIds } from "./core/allowed-rule-ids";
import { validateCitations } from "./core/citations";
import type { CitationResult } from "./core/citations";
import { buildFactSheet, fillPlaceholders } from "./core/fact-sheet";
import { buildFinalText } from "./core/final-text";
import type { DraftLanguage, ModelOutput } from "./core/model-output";
import { renderDocument } from "./io/documents/render";
import { callModel } from "./io/model-router";
import type { CallErrorKind, CallRecord } from "./io/model-router";
import { primaryFor } from "./models";
import type { ModelSet } from "./models";
import { draftPrompt } from "./prompts/draft-step";

export interface DraftAttemptInput {
  record: LadderRecord;
  supplier: Supplier;
  decision: Extract<EscalationDecision, { action: "advance" }>;
  language: DraftLanguage;
  today: CalendarDate;
  bankRate: BankRate | null;
}

/** Why a Draft_Attempt failed. Only this enum is ever logged, never an SDK error message. */
export type DraftErrorKind = CallErrorKind | "citation_blocked" | "document_failed";

export type DraftAttemptResult =
  | { kind: "accepted"; draft: NewDraft }
  | { kind: "failed"; errorKind: DraftErrorKind };

export type AttemptKind = "initial" | "fallback" | "repair";

/** One LLM call waiting to be written to the Tool_Log. */
interface PendingRow {
  attempt: AttemptKind;
  modelId: string;
  outcome: CallRecord["outcome"];
  citation: CitationResult | null;
  /** Set on the accepted row when the PDF render failed. */
  documentFailed: boolean;
}

/**
 * One Draft_Attempt, at most three LLM calls (initial, one fallback, one repair).
 * Returns the Draft to store; it does not insert it. Writes one `draft_step` Tool_Log row per
 * LLM call. A row holds the attempt kind, model ID, language, step, today, and the Model_Output
 * or an error kind enum; nothing from the environment, headers or keys.
 */
export async function draftStep(
  deps: { db: Db; models: ModelSet },
  input: DraftAttemptInput,
): Promise<DraftAttemptResult> {
  const rows: PendingRow[] = [];
  try {
    return await attemptDraft(deps.models, input, rows);
  } finally {
    for (const row of rows) {
      await logToolCall(deps.db, {
        tool: "draft_step",
        invoiceId: input.record.invoice.id,
        input: {
          attempt: row.attempt,
          modelId: row.modelId,
          language: input.language,
          step: input.decision.step,
          today: input.today,
        },
        output: row.outcome.ok
          ? {
              modelOutput: row.outcome.output,
              citation: row.citation,
              ...(row.documentFailed ? { errorKind: "document_failed" } : {}),
            }
          : { errorKind: row.outcome.errorKind, citation: null },
      });
    }
  }
}

async function attemptDraft(
  models: ModelSet,
  input: DraftAttemptInput,
  rows: PendingRow[],
): Promise<DraftAttemptResult> {
  const { record, supplier, decision, language, today, bankRate } = input;
  const step = decision.step;

  // 1. Allowed rule IDs, Fact_Sheet and prompt.
  const allowed = allowedRuleIds(record, decision, today, bankRate);
  const facts = buildFactSheet(record, today, bankRate);
  const promptBase = {
    step,
    language,
    allowed,
    hasBankRate: bankRate !== null,
    caveat: decision.caveat,
    buyerName: record.buyerName,
    invoiceNumber: record.invoiceNumber,
  };
  const collect =
    (phase: "initial" | "repair") =>
    (c: CallRecord): void => {
      const attempt: AttemptKind = phase === "repair" ? "repair" : c.kind === "fallback" ? "fallback" : "initial";
      rows.push({ attempt, modelId: c.modelId, outcome: c.outcome, citation: null, documentFailed: false });
    };

  // 2. Initial call on the primary model (the router makes the one fallback call, if needed).
  const first = await callModel(models, primaryFor(step), draftPrompt(promptBase), { onCall: collect("initial") });
  if (!first.ok) return { kind: "failed", errorKind: first.errorKind };

  // 3. Validate; on a block make one Repair_Call on the same model key, with no fallback.
  let output: ModelOutput = first.output;
  let modelId = first.modelId;
  let citation = validateCitations(output, allowed, RULE_IDS, bankRate !== null);
  setCitation(rows, citation);
  if (!citation.ok) {
    const repair = await callModel(
      models,
      first.modelKey,
      draftPrompt({ ...promptBase, repair: { reason: citation.reason, offending: citation.offending } }),
      { fallback: false, onCall: collect("repair") },
    );
    if (!repair.ok) return { kind: "failed", errorKind: repair.errorKind };
    output = repair.output;
    modelId = repair.modelId;
    citation = validateCitations(output, allowed, RULE_IDS, bankRate !== null);
    setCitation(rows, citation);
    if (!citation.ok) return { kind: "failed", errorKind: "citation_blocked" };
  }

  // 4. Accepted: fill Placeholders, build the Final_Text, render the document for steps 4-5.
  const bodyText = fillPlaceholders(output.text, facts);
  const finalText = buildFinalText(bodyText, citation.ruleIds);
  let document: Uint8Array | null = null;
  if (step === "legal_notice" || step === "odr_pack") {
    try {
      document = await renderDocument(step, {
        supplier,
        facts,
        ruleIds: citation.ruleIds,
        finalText,
        caveat: decision.caveat,
      });
    } catch {
      const last = rows[rows.length - 1];
      if (last !== undefined) last.documentFailed = true;
      return { kind: "failed", errorKind: "document_failed" };
    }
  }
  return {
    kind: "accepted",
    draft: {
      invoiceId: record.invoice.id,
      step,
      language,
      bodyText,
      finalText,
      ruleIds: citation.ruleIds,
      modelId,
      decision,
      document,
    },
  };
}

/** The citation result belongs to the call that produced the Model_Output: the last successful row. */
function setCitation(rows: PendingRow[], citation: CitationResult): void {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row !== undefined && row.outcome.ok) {
      row.citation = citation;
      return;
    }
  }
}
