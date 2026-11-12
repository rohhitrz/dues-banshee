import type { RuleId } from "./rule-ids";

/** "YYYY-MM-DD", an IST calendar day, validated at runtime. */
export type CalendarDate = string;
/** Non-negative safe integer amount in paise. */
export type Paise = number;

export type SupplierCategory = "micro" | "small" | "medium" | "unregistered";
export type SupplierActivity = "manufacturing" | "services" | "trading";

export interface Invoice {
  /** Non-empty. */
  id: string;
  /** 1 .. 1_00_000_00_00_000 (₹1,000 crore). */
  amountPaise: Paise;
  acceptedOn: CalendarDate;
  /** Positive integer. */
  agreedTermDays?: number;
  supplierCategory: SupplierCategory;
  supplierActivity: SupplierActivity;
  udyamRegisteredOn?: CalendarDate;
  /** Must not be before `acceptedOn`. */
  paidOn?: CalendarDate;
}

export interface BankRate {
  /** Integer 0..5000. */
  annualBps: number;
  asOf: CalendarDate;
}

export type NonCoverageReason = "medium_or_unregistered" | "trader";
export type Caveat = "registered_after_supply";

export interface NonCoverageResult {
  applicable: false;
  reason: NonCoverageReason;
  ruleIds: ["MSMED-SCOPE"];
}

interface Covered {
  applicable: true;
  ruleIds: RuleId[];
  /** Present only when the supplier registered after the supply. */
  caveat?: Caveat;
}

export type CoverageResult = NonCoverageResult | Covered;

export type DueDateResult =
  | (Covered & { dueDate: CalendarDate })
  | NonCoverageResult;

export type InterestResult =
  | (Covered & {
      interestPaise: Paise;
      accrualDays: number;
      /** 3 × annualBps. */
      statutoryRateBps: number;
      rateAsOf: CalendarDate;
    })
  | (NonCoverageResult & { interestPaise: 0 });

export type TaxBombStatus = "armed" | "exploded" | "defused";

export type TaxBombResult =
  | (Covered & {
      status: TaxBombStatus;
      taxBombDate: CalendarDate;
      deductionDeadline: CalendarDate;
      daysLeft: number;
      deductionAtRiskPaise: Paise;
    })
  | (NonCoverageResult & { status: "not_applicable"; deductionAtRiskPaise: 0 });

// Escalation
export type LadderStep =
  | "whatsapp_nudge"
  | "whatsapp_paylink"
  | "voice_call"
  | "legal_notice"
  | "odr_pack";

export interface StepEvent {
  kind: "step";
  step: LadderStep;
  on: CalendarDate;
}

export interface PromiseEvent {
  kind: "promise";
  promisedDate: CalendarDate;
  amountPaise: Paise;
  recordedOn: CalendarDate;
}

export type EscalationEvent = StepEvent | PromiseEvent;
export type EscalationHistory = readonly EscalationEvent[];

/** `stepGapDays` is a positive integer, default 7. */
export interface LadderConfig {
  stepGapDays: number;
}

export type CoveredWaitReason =
  | "paid"
  | "not_overdue"
  | "promise_active"
  | "ladder_complete"
  | "cooldown";

export type WaitReason = CoveredWaitReason | NonCoverageReason;

export type EscalationDecision =
  | {
      action: "advance";
      applicable: true;
      step: LadderStep;
      rank: 1 | 2 | 3 | 4 | 5;
      requiresApproval: boolean;
      ruleIds: RuleId[];
      caveat?: Caveat;
    }
  | {
      action: "wait";
      applicable: boolean;
      reason: CoveredWaitReason;
      ruleIds: RuleId[];
      caveat?: Caveat;
    }
  | (NonCoverageResult & { action: "wait" });

export type InrStyle = "full" | "short";
