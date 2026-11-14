import { hasActivePromise, type CalendarDate, type EscalationHistory, type Paise } from "@dues-banshee/engine";

export type MossLevel = 0 | 1 | 2 | 3 | 4;

/** How a tombstone looks. Every field encodes data (see ui-theme.md); none is decorative only. */
export interface TombstoneLook {
  heightPx: number;
  moss: MossLevel;
  cracked: boolean;
  ember: boolean;
  wisp: boolean;
}

const MIN_HEIGHT_PX = 130;
const HEIGHT_SPAN_PX = 170;

/**
 * One height per input principal, same order as the input. The height depends on the principal's rank
 * among the DISTINCT principals (ties share a height): `130 + floor(170 * rank / max(1, distinct - 1))`.
 * Only integer comparison of paise is used; money is never divided. `rank` and `distinct` are counts.
 */
export function heightsByRank(principals: readonly Paise[]): number[] {
  const distinct = [...new Set(principals)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const rankOf = new Map<Paise, number>();
  distinct.forEach((p, rank) => rankOf.set(p, rank));
  const steps = Math.max(1, distinct.length - 1);
  return principals.map((p) => {
    const rank = rankOf.get(p) ?? 0;
    return MIN_HEIGHT_PX + Math.floor((HEIGHT_SPAN_PX * rank) / steps);
  });
}

/** Moss bucket for Days_Overdue: 0 | 1-15 | 16-45 | 46-90 | >90. Never decreases as `days` grows. */
export function mossLevel(days: number): MossLevel {
  if (days <= 0) return 0;
  if (days <= 15) return 1;
  if (days <= 45) return 2;
  if (days <= 90) return 3;
  return 4;
}

export interface TombstoneLookInput {
  /** From `heightsByRank` over every principal in the view. */
  heightPx: number;
  daysOverdue: number;
  /** True when the invoice is paid on `today`. */
  paid: boolean;
  history: EscalationHistory;
  today: CalendarDate;
}

/** Cracks above 60 days, ember dot above 45, wisp for an unpaid invoice with a promise dated today or later. */
export function tombstoneLook({ heightPx, daysOverdue, paid, history, today }: TombstoneLookInput): TombstoneLook {
  return {
    heightPx,
    moss: mossLevel(daysOverdue),
    cracked: daysOverdue > 60,
    ember: daysOverdue > 45,
    wisp: !paid && hasActivePromise(history, today),
  };
}
