import type {
  CalendarDate,
  EscalationDecision,
  LadderStep,
  WaitReason,
} from "@dues-banshee/engine";

/** Draft_Cap: the most Draft_Attempts one Ladder_Run makes for a supplier (Req 1.10-1.11). */
export const MAX_DRAFTS_PER_RUN = 20;

export type DraftableItem = {
  invoiceId: string;
  kind: "draftable";
  step: LadderStep;
  dueDate: CalendarDate;
};

export type Classified =
  | DraftableItem
  | { invoiceId: string; kind: "wait"; reason: WaitReason }
  | {
      invoiceId: string;
      kind: "skip";
      reason: "pending_draft_exists" | "invalid_invoice";
    };

/** Distributes Omit over each member of the union, so `kind` still narrows the result. */
type WithoutInvoiceId<T> = T extends unknown ? Omit<T, "invoiceId"> : never;

/**
 * Maps one Engine Decision to a run outcome (Req 1.3-1.5).
 * `due` is the Engine due date; `null` means it could not be computed, so the
 * invoice cannot be ordered or drafted and is skipped as `invalid_invoice`.
 */
export function classify(
  decision: EscalationDecision,
  pendingDraftId: string | null,
  due: CalendarDate | null,
): WithoutInvoiceId<Classified> {
  if (decision.action === "wait") {
    return { kind: "wait", reason: decision.reason };
  }
  if (pendingDraftId !== null) {
    return { kind: "skip", reason: "pending_draft_exists" };
  }
  if (due === null) {
    return { kind: "skip", reason: "invalid_invoice" };
  }
  return { kind: "draftable", step: decision.step, dueDate: due };
}

function compareDraftable(a: DraftableItem, b: DraftableItem): number {
  if (a.dueDate < b.dueDate) return -1;
  if (a.dueDate > b.dueDate) return 1;
  if (a.invoiceId < b.invoiceId) return -1;
  if (a.invoiceId > b.invoiceId) return 1;
  return 0;
}

/**
 * Orders draftable items by (dueDate, invoiceId) with plain `<` comparison, takes the
 * first MAX_DRAFTS_PER_RUN as attempts and returns the rest as `capped` invoice ids
 * (Req 1.10-1.12, 2.2). Does not mutate `items`.
 */
export function planRun(items: readonly Classified[]): {
  attempts: DraftableItem[];
  capped: string[];
} {
  const sorted = items
    .filter((item): item is DraftableItem => item.kind === "draftable")
    .sort(compareDraftable);
  return {
    attempts: sorted.slice(0, MAX_DRAFTS_PER_RUN),
    capped: sorted.slice(MAX_DRAFTS_PER_RUN).map((item) => item.invoiceId),
  };
}
