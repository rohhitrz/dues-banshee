import type { CalendarDate } from "@dues-banshee/engine";

/** The fields the choice of Draft depends on; a `SendableDraftRow` from `listSendState` satisfies it. */
export interface SendableCandidate {
  draftId: string;
  approvalDay: CalendarDate;
  createdAt: Date;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareCandidates(a: SendableCandidate, b: SendableCandidate): number {
  return (
    compareText(a.approvalDay, b.approvalDay) ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    compareText(a.draftId, b.draftId)
  );
}

/** The candidate maximal by (approvalDay, createdAt, draftId), or null for an empty list (Req 4.1). Pure. */
export function pickSendableDraft<T extends SendableCandidate>(drafts: readonly T[]): T | null {
  let best: T | null = null;
  for (const d of drafts) {
    if (best === null || compareCandidates(d, best) > 0) best = d;
  }
  return best;
}

export type ControlState =
  /** Req 4.3, highest precedence. */
  | { kind: "no_draft" }
  /** Req 4.4. */
  | { kind: "no_number"; draftId: string; preview: string }
  /** Req 4.5. */
  | { kind: "sender_not_configured"; draftId: string; preview: string }
  /** Req 4.1. */
  | { kind: "ready"; draftId: string; preview: string };

export interface SendControlInput {
  draft: SendableCandidate | null;
  buyerNumberSet: boolean;
  twilioReady: boolean;
  preview: string | null;
}

/** Precedence: no_draft > no_number > sender_not_configured > ready. Pure. */
export function sendControlState({ draft, buyerNumberSet, twilioReady, preview }: SendControlInput): ControlState {
  if (draft === null) return { kind: "no_draft" };
  const draftId = draft.draftId;
  const text = preview ?? "";
  if (!buyerNumberSet) return { kind: "no_number", draftId, preview: text };
  if (!twilioReady) return { kind: "sender_not_configured", draftId, preview: text };
  return { kind: "ready", draftId, preview: text };
}
