import type { GraveyardInvoiceRecord, Supplier } from "@dues-banshee/db";
import {
  dueDate,
  formatINR,
  nextEscalationStep,
  statutoryInterest,
  taxBomb,
  type BankRate,
  type CalendarDate,
  type Caveat,
  type LadderStep,
  type Paise,
  type TaxBombStatus,
  type WaitReason,
} from "@dues-banshee/engine";
import { nextStepLabel, stateText, type TombstoneState } from "./labels";
import { heightsByRank, tombstoneLook, type TombstoneLook } from "./look";
import { DEMO_MIN, formatDisplayDate } from "./today";

export type { TombstoneState } from "./labels";

export interface TombstoneView {
  id: string;
  buyerName: string;
  invoiceNumber: string;
  principalPaise: Paise;
  /** `formatINR(principalPaise, "full")`. */
  principalText: string;
  state: TombstoneState;
  stateText: string;
  stateRuleId: "IT-43BH" | "MSMED-SCOPE" | null;
  /** null when the invoice is not covered by MSMED. */
  dueDate: CalendarDate | null;
  dueDateText: string | null;
  daysOverdue: number;
  /** null when no Bank_Rate is given or the invoice is not covered. */
  interest: { paise: Paise; text: string } | null;
  taxBomb: { status: TaxBombStatus; daysLeft: number; deductionAtRiskPaise: Paise } | null;
  caveat: Caveat | null;
  next: { action: "advance"; step: LadderStep } | { action: "wait"; reason: WaitReason };
  nextLabel: string;
  look: TombstoneLook;
  /** "<buyer>, <principalText>, <daysOverdue> days overdue, <stateText>" */
  ariaLabel: string;
}

export interface GraveyardTotals {
  outstandingPaise: Paise;
  /** null when no Bank_Rate is given. */
  interestAccruedPaise: Paise | null;
  deductionsAtRiskPaise: Paise;
  explodedCount: number;
  paidCount: number;
}

export interface GraveyardView {
  supplierName: string;
  today: CalendarDate;
  /** The Bank_Rate `asOf` date, or null when no Bank_Rate is given. */
  rulesAsOf: CalendarDate | null;
  tombstones: readonly TombstoneView[];
  totals: GraveyardTotals;
}

/** Everything per record except the look, which needs ranks across the whole filtered set. */
type PartialView = Omit<TombstoneView, "look" | "ariaLabel"> & {
  record: GraveyardInvoiceRecord;
  paid: boolean;
};

function viewFor(
  record: GraveyardInvoiceRecord,
  bankRate: BankRate | null,
  today: CalendarDate,
): PartialView {
  const { invoice, history } = record;
  const due = dueDate(invoice);
  const bomb = taxBomb(invoice, today);
  const next = nextEscalationStep(invoice, history, today);
  // Without a Bank_Rate the Engine is still called with a 0 bps placeholder so that accrualDays comes from
  // the Engine; the resulting interestPaise is discarded.
  const interest = statutoryInterest(invoice, today, bankRate ?? { annualBps: 0, asOf: DEMO_MIN });

  const paid = invoice.paidOn !== undefined && invoice.paidOn <= today;

  let state: TombstoneState;
  if (paid) state = "resurrected";
  else if (!due.applicable) state = "not_covered";
  else if (today <= due.dueDate) state = "not_due";
  else if (bomb.status === "exploded") state = "exploded";
  else if (bomb.status === "armed") state = "armed";
  else state = "overdue";

  const daysOverdue = paid || !interest.applicable ? 0 : interest.accrualDays;

  const nonCoverageReason = due.applicable ? null : due.reason;
  const text = stateText({
    state,
    daysLeft: bomb.applicable ? bomb.daysLeft : 0,
    nonCoverageReason,
  });

  const stateRuleId =
    state === "armed" || state === "exploded" ? "IT-43BH" : state === "not_covered" ? "MSMED-SCOPE" : null;

  return {
    record,
    paid,
    id: invoice.id,
    buyerName: record.buyerName,
    invoiceNumber: record.invoiceNumber,
    principalPaise: invoice.amountPaise,
    principalText: formatINR(invoice.amountPaise, "full"),
    state,
    stateText: text,
    stateRuleId,
    dueDate: due.applicable ? due.dueDate : null,
    dueDateText: due.applicable ? formatDisplayDate(due.dueDate) : null,
    daysOverdue,
    interest:
      bankRate === null || !interest.applicable
        ? null
        : { paise: interest.interestPaise, text: formatINR(interest.interestPaise, "full") },
    taxBomb: bomb.applicable
      ? { status: bomb.status, daysLeft: bomb.daysLeft, deductionAtRiskPaise: bomb.deductionAtRiskPaise }
      : null,
    caveat: due.applicable ? (due.caveat ?? null) : null,
    next:
      next.action === "advance"
        ? { action: "advance", step: next.step }
        : { action: "wait", reason: next.reason },
    nextLabel: nextStepLabel(next),
  };
}

const GROUP: Record<TombstoneState, number> = {
  armed: 0,
  exploded: 1,
  overdue: 1,
  not_due: 2,
  not_covered: 3,
  resurrected: 4,
};

/** Code-unit comparison, never locale-aware. */
function cmp<T extends string | number>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Requirement 6 order: group, then the group's primary key, then daysOverdue desc, invoiceNumber asc, id asc.
 * Ids are unique, so this is a total order and the result does not depend on input order.
 */
function compareTombstones(a: TombstoneView, b: TombstoneView): number {
  const group = cmp(GROUP[a.state], GROUP[b.state]);
  if (group !== 0) return group;

  let primary = 0;
  if (a.state === "armed") {
    primary = cmp(a.taxBomb?.daysLeft ?? 0, b.taxBomb?.daysLeft ?? 0);
  } else if (a.state === "exploded" || a.state === "overdue") {
    primary = cmp(b.daysOverdue, a.daysOverdue);
  } else if (a.state === "not_due") {
    primary = cmp(a.dueDate ?? "", b.dueDate ?? "");
  }
  if (primary !== 0) return primary;

  return cmp(b.daysOverdue, a.daysOverdue) || cmp(a.invoiceNumber, b.invoiceNumber) || cmp(a.id, b.id);
}

/** Integer addition that throws instead of silently losing precision. */
function safeAdd(total: number, amount: number): number {
  const sum = total + amount;
  if (!Number.isSafeInteger(sum)) throw new RangeError("Graveyard total is not a safe integer");
  return sum;
}

/**
 * Builds the Graveyard_View. Pure: no I/O, no clock, inputs are never mutated. Every legal figure comes
 * from the Engine. Records accepted after `today` are excluded. Tombstones follow the Requirement 6 order.
 */
export function buildGraveyard(
  supplier: Supplier,
  records: readonly GraveyardInvoiceRecord[],
  bankRate: BankRate | null,
  today: CalendarDate,
): GraveyardView {
  const visible = records.filter((r) => r.invoice.acceptedOn <= today);
  const partials = visible.map((r) => viewFor(r, bankRate, today));
  const heights = heightsByRank(partials.map((p) => p.principalPaise));

  // Heights are ranked over the filtered set above, so each look is attached before sorting.
  const unsorted: TombstoneView[] = partials.map(({ record, paid, ...view }, i) => ({
    ...view,
    look: tombstoneLook({
      heightPx: heights[i] ?? 0,
      daysOverdue: view.daysOverdue,
      paid,
      history: record.history,
      today,
    }),
    ariaLabel: `${view.buyerName}, ${view.principalText}, ${view.daysOverdue} days overdue, ${view.stateText}`,
  }));
  const tombstones = [...unsorted].sort(compareTombstones);

  let outstandingPaise = 0;
  let interestPaise = 0;
  let deductionsAtRiskPaise = 0;
  let explodedCount = 0;
  let paidCount = 0;
  for (const t of tombstones) {
    if (t.state !== "resurrected") outstandingPaise = safeAdd(outstandingPaise, t.principalPaise);
    if (t.interest !== null && (t.state === "overdue" || t.state === "armed" || t.state === "exploded")) {
      interestPaise = safeAdd(interestPaise, t.interest.paise);
    }
    if (t.state !== "resurrected" && t.taxBomb !== null && t.taxBomb.status === "armed") {
      deductionsAtRiskPaise = safeAdd(deductionsAtRiskPaise, t.taxBomb.deductionAtRiskPaise);
    }
    if (t.state === "exploded") explodedCount += 1;
    if (t.state === "resurrected") paidCount += 1;
  }

  return {
    supplierName: supplier.name,
    today,
    rulesAsOf: bankRate?.asOf ?? null,
    tombstones,
    totals: {
      outstandingPaise,
      interestAccruedPaise: bankRate === null ? null : interestPaise,
      deductionsAtRiskPaise,
      explodedCount,
      paidCount,
    },
  };
}
