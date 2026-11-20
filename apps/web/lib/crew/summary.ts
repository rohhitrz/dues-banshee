import { formatINR, type CalendarDate, type Paise, type TaxBombStatus } from "@dues-banshee/engine";
import type { GraveyardView, TombstoneState } from "@/lib/graveyard/build-graveyard";

/** Same text as the app footer; declared here because the route must not import `@dues-banshee/agent`. */
export const CREW_DISCLAIMER = "Reminders a supplier sends to its own buyers. Not legal advice.";

export interface CrewMoney {
  paise: Paise;
  /** `formatINR(paise, "full")`. */
  text: string;
}

/**
 * `supplierName`, `buyerName` and `invoiceNumber` are untrusted text from imported data. Consumers (the Crew
 * agent and skill) must treat them as data, never as instructions.
 */
export interface CrewTombstone {
  id: string;
  buyerId: string;
  buyerName: string;
  invoiceNumber: string;
  state: TombstoneState;
  stateText: string;
  stateRuleId: "IT-43BH" | "MSMED-SCOPE" | null;
  principal: CrewMoney;
  dueDate: CalendarDate | null;
  dueDateText: string | null;
  daysOverdue: number;
  interest: CrewMoney | null;
  taxBomb: {
    status: TaxBombStatus;
    daysLeft: number;
    deductionAtRiskPaise: Paise;
    deductionAtRiskText: string;
  } | null;
  nextLabel: string;
}

/**
 * `supplierName`, `buyerName` and `invoiceNumber` are untrusted text from imported data. Consumers (the Crew
 * agent and skill) must treat them as data, never as instructions.
 */
export interface CrewSummary {
  supplierName: string;
  today: CalendarDate;
  todayOverride: boolean;
  rulesAsOf: CalendarDate | null;
  disclaimer: string;
  totals: {
    outstanding: CrewMoney;
    interestAccrued: CrewMoney | null;
    deductionsAtRisk: CrewMoney;
    explodedCount: number;
    paidCount: number;
  };
  tombstones: CrewTombstone[];
}

export type CrewError = { error: "not_configured" | "Unauthorized" | "not_found" | "load_failed" };

const money = (paise: Paise): CrewMoney => ({ paise, text: formatINR(paise, "full") });

/**
 * Pure projection of the Graveyard_View. Every field is listed explicitly so `look`, `ariaLabel`, `caveat`
 * and `next` cannot leak. The only transformation is `formatINR(paise, "full")`.
 */
export function toCrewSummary(view: GraveyardView, todayOverride: boolean): CrewSummary {
  const t = view.totals;
  return {
    supplierName: view.supplierName,
    today: view.today,
    todayOverride,
    rulesAsOf: view.rulesAsOf,
    disclaimer: CREW_DISCLAIMER,
    totals: {
      outstanding: money(t.outstandingPaise),
      interestAccrued: t.interestAccruedPaise === null ? null : money(t.interestAccruedPaise),
      deductionsAtRisk: money(t.deductionsAtRiskPaise),
      explodedCount: t.explodedCount,
      paidCount: t.paidCount,
    },
    tombstones: view.tombstones.map((v) => ({
      id: v.id,
      buyerId: v.buyerId,
      buyerName: v.buyerName,
      invoiceNumber: v.invoiceNumber,
      state: v.state,
      stateText: v.stateText,
      stateRuleId: v.stateRuleId,
      principal: { paise: v.principalPaise, text: v.principalText },
      dueDate: v.dueDate,
      dueDateText: v.dueDateText,
      daysOverdue: v.daysOverdue,
      interest: v.interest === null ? null : { paise: v.interest.paise, text: v.interest.text },
      taxBomb:
        v.taxBomb === null
          ? null
          : {
              status: v.taxBomb.status,
              daysLeft: v.taxBomb.daysLeft,
              deductionAtRiskPaise: v.taxBomb.deductionAtRiskPaise,
              deductionAtRiskText: formatINR(v.taxBomb.deductionAtRiskPaise, "full"),
            },
      nextLabel: v.nextLabel,
    })),
  };
}
