import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { nextEscalationStep } from "../src/index";
import type {
  CalendarDate,
  EscalationDecision,
  EscalationEvent,
  EscalationHistory,
  Invoice,
  LadderConfig,
  LadderStep,
} from "../src/types";
import { arbCoveredInvoice, arbHistory, arbInvoice, arbLadderConfig, arbToday } from "./arbitraries";

// ---------------------------------------------------------------------------
// Shared helpers (independent of the engine's calendar and ladder code).
// Later properties in this file reuse them; append new `describe` blocks below.
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

const utcMs = (d: CalendarDate): number => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));

/** Whole days from `a` to `b` using UTC midnights, so host time zone and DST cannot matter. */
function daysBetween(a: CalendarDate, b: CalendarDate): number {
  return Math.round((utcMs(b) - utcMs(a)) / MS_PER_DAY);
}

/** `d` shifted by `n` days, formatted back to YYYY-MM-DD. */
function shiftDays(d: CalendarDate, n: number): CalendarDate {
  return new Date(utcMs(d) + n * MS_PER_DAY).toISOString().slice(0, 10);
}

/** MSMED-15 Due_Date: agreed term capped at 45 days, 15 days when no term is given. */
function oracleDueDate(invoice: Invoice): CalendarDate {
  const term = invoice.agreedTermDays === undefined ? 15 : Math.min(invoice.agreedTermDays, 45);
  return shiftDays(invoice.acceptedOn, term);
}

const ORACLE_STEP_ORDER: readonly LadderStep[] = [
  "whatsapp_nudge",
  "whatsapp_paylink",
  "voice_call",
  "legal_notice",
  "odr_pack",
];

/** Rank 1..5 of a ladder step, from the position in the spec's ladder order. */
const oracleRank = (step: LadderStep): number => ORACLE_STEP_ORDER.indexOf(step) + 1;

// ---------------------------------------------------------------------------
// Property 12 oracle, written from the precedence table in the design
// ---------------------------------------------------------------------------

type OracleBranch =
  | "paid"
  | "medium_or_unregistered"
  | "trader"
  | "not_overdue"
  | "promise_active"
  | "ladder_complete"
  | "cooldown"
  | "advance";

interface OracleDecision {
  branch: OracleBranch;
  /** Set only for `advance`. */
  step?: LadderStep;
  /** True when the Registered_After_Supply_Caveat applies to a covered invoice. */
  caveat: boolean;
}

function escalationOracle(
  invoice: Invoice,
  history: EscalationHistory,
  today: CalendarDate,
  config: LadderConfig,
): OracleDecision {
  const isCovered =
    invoice.supplierCategory !== "medium" &&
    invoice.supplierCategory !== "unregistered" &&
    invoice.supplierActivity !== "trading";
  const caveat =
    isCovered && invoice.udyamRegisteredOn !== undefined && daysBetween(invoice.acceptedOn, invoice.udyamRegisteredOn) > 0;

  // 1. Paid on or before today.
  if (invoice.paidOn !== undefined && daysBetween(invoice.paidOn, today) >= 0) {
    return { branch: "paid", caveat };
  }

  // 2. Non-coverage reason: category first, then trading.
  if (invoice.supplierCategory === "medium" || invoice.supplierCategory === "unregistered") {
    return { branch: "medium_or_unregistered", caveat };
  }
  if (invoice.supplierActivity === "trading") {
    return { branch: "trader", caveat };
  }

  // 3. Not overdue.
  if (daysBetween(oracleDueDate(invoice), today) <= 0) {
    return { branch: "not_overdue", caveat };
  }

  // Events dated after today have not happened yet: a step by its `on`, a promise by its `recordedOn`.
  const seen: EscalationEvent[] = history.filter((event) =>
    event.kind === "step" ? daysBetween(event.on, today) >= 0 : daysBetween(event.recordedOn, today) >= 0,
  );

  // 4. Any promise still in the future.
  const promiseActive = seen.some((event) => event.kind === "promise" && daysBetween(today, event.promisedDate) > 0);
  if (promiseActive) {
    return { branch: "promise_active", caveat };
  }

  const stepEvents = seen.flatMap((event) => (event.kind === "step" ? [event] : []));
  const maxRank = stepEvents.reduce((best, event) => Math.max(best, oracleRank(event.step)), 0);

  // 5. Top rung already used.
  if (maxRank === 5) {
    return { branch: "ladder_complete", caveat };
  }

  // 6. Cooldown measured from the latest step event.
  if (stepEvents.length > 0) {
    const latest = stepEvents.reduce((best, event) => (daysBetween(best, event.on) > 0 ? event.on : best), stepEvents[0]!.on);
    if (daysBetween(latest, today) < config.stepGapDays) {
      return { branch: "cooldown", caveat };
    }
  }

  // 7. Advance to maxRank + 1 (rank 1 when there are no step events).
  return { branch: "advance", step: ORACLE_STEP_ORDER[maxRank]!, caveat };
}

// ---------------------------------------------------------------------------
// Generators for Property 12
// ---------------------------------------------------------------------------

/** Same invoice with `paidOn` removed. */
function unpaid(invoice: Invoice): Invoice {
  const { paidOn: _paidOn, ...rest } = invoice;
  void _paidOn;
  return rest;
}

/** Invoices from `arbInvoice`, plus covered ones forced to Unpaid so the later branches are reachable. */
const arbEscalationInvoice: fc.Arbitrary<Invoice> = fc.oneof(
  { weight: 3, arbitrary: arbInvoice },
  { weight: 4, arbitrary: arbCoveredInvoice.map(unpaid) },
);

/**
 * `today` from `arbToday`, or 1..120 days after the Due_Date so the invoice is usually
 * overdue (the branches below `not_overdue` need that).
 */
function arbEscalationToday(invoice: Invoice): fc.Arbitrary<CalendarDate> {
  const afterDue = fc.integer({ min: 1, max: 120 }).map((offset) => shiftDays(oracleDueDate(invoice), offset));
  return fc.oneof({ weight: 1, arbitrary: arbToday(invoice) }, { weight: 2, arbitrary: afterDue });
}

/**
 * History built relative to `today` so cooldown, active promises, complete ladders and
 * future-dated events all occur often. Offsets are in days before `today` (negative = future).
 */
function arbHistoryNear(today: CalendarDate): fc.Arbitrary<EscalationHistory> {
  const stepEvent: fc.Arbitrary<EscalationEvent> = fc
    .tuple(fc.constantFrom(...ORACLE_STEP_ORDER), fc.integer({ min: -5, max: 40 }))
    .map(([step, daysAgo]) => ({ kind: "step", step, on: shiftDays(today, -daysAgo) }));

  // A ladder prefix: ranks 1..k, one step per `gap` days, ending `lastAgo` days before today.
  const prefix: fc.Arbitrary<EscalationHistory> = fc
    .tuple(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 1, max: 14 }), fc.integer({ min: 0, max: 30 }))
    .map(([k, gap, lastAgo]) =>
      ORACLE_STEP_ORDER.slice(0, k).map(
        (step, i): EscalationEvent => ({ kind: "step", step, on: shiftDays(today, -(lastAgo + gap * (k - 1 - i))) }),
      ),
    );

  const promiseEvent: fc.Arbitrary<EscalationEvent> = fc
    .tuple(fc.integer({ min: -5, max: 40 }), fc.integer({ min: -10, max: 30 }), fc.integer({ min: 1, max: 1_000_000 }))
    .map(([recordedAgo, promiseOffset, amountPaise]) => ({
      kind: "promise",
      recordedOn: shiftDays(today, -recordedAgo),
      promisedDate: shiftDays(today, promiseOffset),
      amountPaise,
    }));

  const promises = fc.array(promiseEvent, { maxLength: 2 });
  return fc.oneof(
    { weight: 3, arbitrary: prefix },
    { weight: 1, arbitrary: fc.array(stepEvent, { maxLength: 6 }) },
    {
      weight: 2,
      arbitrary: fc.tuple(prefix, promises).map(([steps, ps]): EscalationHistory => [...steps, ...ps]),
    },
    {
      weight: 1,
      arbitrary: fc.tuple(fc.array(stepEvent, { maxLength: 4 }), promises).map(([steps, ps]): EscalationHistory => [...steps, ...ps]),
    },
  );
}

interface Scenario {
  invoice: Invoice;
  history: EscalationHistory;
  today: CalendarDate;
  config: LadderConfig;
}

const arbScenario: fc.Arbitrary<Scenario> = arbEscalationInvoice.chain((invoice) =>
  arbEscalationToday(invoice).chain((today) =>
    fc
      .tuple(
        fc.oneof({ weight: 1, arbitrary: arbHistory(invoice) }, { weight: 3, arbitrary: arbHistoryNear(today) }),
        arbLadderConfig,
      )
      .map(([history, config]): Scenario => ({ invoice, history, today, config })),
  ),
);

// ---------------------------------------------------------------------------
// Property 12 check
// ---------------------------------------------------------------------------

/** Which oracle branch each generated case landed in, to prove the generators reach all of them. */
function emptyTally(): Record<OracleBranch, number> {
  return {
    paid: 0,
    medium_or_unregistered: 0,
    trader: 0,
    not_overdue: 0,
    promise_active: 0,
    ladder_complete: 0,
    cooldown: 0,
    advance: 0,
  };
}

function checkAgainstOracle({ invoice, history, today, config }: Scenario, tally: Record<OracleBranch, number>): void {
  const expected = escalationOracle(invoice, history, today, config);
  const actual: EscalationDecision = nextEscalationStep(invoice, history, today, config);
  tally[expected.branch] += 1;

  if (expected.branch === "advance") {
    expect(actual.action).toBe("advance");
    if (actual.action !== "advance") return;
    expect(actual.step).toBe(expected.step);
    expect(actual.rank).toBe(oracleRank(expected.step!));
    expect(actual.applicable).toBe(true);
    return;
  }

  expect(actual.action).toBe("wait");
  if (actual.action !== "wait") return;
  expect(actual.reason).toBe(expected.branch);

  const isNonCoverage = expected.branch === "medium_or_unregistered" || expected.branch === "trader";
  if (isNonCoverage) {
    // Non_Coverage_Result: cites only MSMED-SCOPE.
    expect(actual.applicable).toBe(false);
    expect(actual.ruleIds).toEqual(["MSMED-SCOPE"]);
  } else if (expected.branch === "paid" && !isCovered(invoice)) {
    // A paid non-covered invoice reports `paid` and cites no rule.
    expect(actual.applicable).toBe(false);
    expect(actual.ruleIds).toEqual([]);
  } else {
    // Covered wait: no rule, or MSMED-SCOPE plus the caveat when registered after supply.
    expect(actual.applicable).toBe(true);
    expect(actual.ruleIds).toEqual(expected.caveat ? ["MSMED-SCOPE"] : []);
    expect("caveat" in actual && actual.caveat !== undefined).toBe(expected.caveat);
  }
}

function isCovered(invoice: Invoice): boolean {
  return (
    invoice.supplierCategory !== "medium" &&
    invoice.supplierCategory !== "unregistered" &&
    invoice.supplierActivity !== "trading"
  );
}

describe("escalation-ladder property: precedence oracle", () => {
  // Feature: legal-engine, Property 12: Escalation precedence oracle
  it("Property 12: Escalation precedence oracle", () => {
    // **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.15**
    const tally = emptyTally();
    fc.assert(fc.property(arbScenario, (scenario) => checkAgainstOracle(scenario, tally)));

    // The generators must reach every branch of the table, not just the easy ones.
    for (const [branch, count] of Object.entries(tally)) {
      expect(count, `branch "${branch}" was never generated`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Property 13: advances never skip, go backwards, or miss approval
// ---------------------------------------------------------------------------

const ORACLE_APPROVAL_STEPS: readonly LadderStep[] = ["voice_call", "legal_notice", "odr_pack"];

describe("escalation-ladder property: advance rank and approval", () => {
  // Feature: legal-engine, Property 13: Advances never skip, go backwards, or miss approval
  it("Property 13: Advances never skip, go backwards, or miss approval", () => {
    // **Validates: Requirements 6.10, 6.11, 6.12**
    const advancesByStep: Record<LadderStep, number> = {
      whatsapp_nudge: 0,
      whatsapp_paylink: 0,
      voice_call: 0,
      legal_notice: 0,
      odr_pack: 0,
    };
    let advances = 0;

    fc.assert(
      fc.property(arbScenario, ({ invoice, history, today, config }) => {
        const decision = nextEscalationStep(invoice, history, today, config);
        if (decision.action !== "advance") return;

        advances += 1;
        advancesByStep[decision.step] += 1;

        // Highest rank among step events that have happened by today (dated <= today); 0 when none.
        const maxRank = history.reduce(
          (best, event) =>
            event.kind === "step" && daysBetween(event.on, today) >= 0 ? Math.max(best, oracleRank(event.step)) : best,
          0,
        );

        // Never skips and never goes backwards: exactly one rung above the highest step taken.
        expect(decision.rank).toBe(maxRank + 1);
        expect(decision.step).toBe(ORACLE_STEP_ORDER[decision.rank - 1]);
        expect(oracleRank(decision.step)).toBe(decision.rank);

        // Approval is needed exactly for the call, the legal notice and the ODR pack.
        expect(decision.requiresApproval).toBe(ORACLE_APPROVAL_STEPS.includes(decision.step));

        // The ODR pack cites s.18 and the portal.
        if (decision.step === "odr_pack") {
          expect(decision.ruleIds).toContain("MSMED-18");
          expect(decision.ruleIds).toContain("MSMED-ODR");
        }
      }),
    );

    // The generator must produce advances, and at every rung, or the checks above prove nothing.
    expect(advances, "no advance decisions were generated").toBeGreaterThan(0);
    for (const [step, count] of Object.entries(advancesByStep)) {
      expect(count, `no advance to "${step}" was generated`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Property 14: an active promise blocks advancing
// ---------------------------------------------------------------------------

interface PromiseInjection {
  /** Days after `today` that the promise falls due (>= 1, so it is still active). */
  promisedAfter: number;
  /** Days before `today` that the promise was recorded (>= 0, so it has already been recorded). */
  recordedAgo: number;
  amountPaise: number;
  /** Where in the history array the promise is inserted (taken modulo length + 1). */
  position: number;
}

const arbPromiseInjection: fc.Arbitrary<PromiseInjection> = fc.record({
  promisedAfter: fc.oneof({ weight: 3, arbitrary: fc.integer({ min: 1, max: 5 }) }, { weight: 1, arbitrary: fc.integer({ min: 1, max: 365 }) }),
  recordedAgo: fc.integer({ min: 0, max: 60 }),
  amountPaise: fc.integer({ min: 1, max: 1_000_000_000 }),
  position: fc.nat({ max: 20 }),
});

/** Takes a scenario and adds one promise with promisedDate > today and recordedOn <= today to its history. */
function withActivePromise(scenario: Scenario, injection: PromiseInjection): Scenario {
  const promise: EscalationEvent = {
    kind: "promise",
    recordedOn: shiftDays(scenario.today, -injection.recordedAgo),
    promisedDate: shiftDays(scenario.today, injection.promisedAfter),
    amountPaise: injection.amountPaise,
  };
  const at = injection.position % (scenario.history.length + 1);
  const history: EscalationHistory = [...scenario.history.slice(0, at), promise, ...scenario.history.slice(at)];
  return { ...scenario, history };
}

describe("escalation-ladder property: active promise", () => {
  // Feature: legal-engine, Property 14: An active promise blocks advancing
  it("Property 14: An active promise blocks advancing", () => {
    // **Validates: Requirements 6.4, 6.13**
    const seen = { covered: 0, nonCovered: 0, paid: 0, unpaid: 0, promiseActive: 0 };

    fc.assert(
      fc.property(arbScenario, arbPromiseInjection, (base, injection) => {
        const { invoice, history, today, config } = withActivePromise(base, injection);

        const decision = nextEscalationStep(invoice, history, today, config);

        // Whatever the invoice and history look like, the ladder must not move.
        expect(decision.action).not.toBe("advance");
        expect(decision.action).toBe("wait");

        if (isCovered(invoice)) seen.covered += 1;
        else seen.nonCovered += 1;
        if (invoice.paidOn !== undefined && daysBetween(invoice.paidOn, today) >= 0) seen.paid += 1;
        else seen.unpaid += 1;

        if (decision.action === "wait" && decision.reason === "promise_active") {
          seen.promiseActive += 1;
        }
      }),
    );

    // Both covered and non-covered, paid and unpaid invoices must have been exercised, and the
    // promise itself must have been the deciding reason in some cases.
    for (const [kind, count] of Object.entries(seen)) {
      expect(count, `no "${kind}" case was generated`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Property 15: expired promises do not affect the decision
// ---------------------------------------------------------------------------

interface ExpiredPromiseInjection {
  /** Days before `today` that the promise fell due (>= 0, so promisedDate <= today). */
  promisedAgo: number;
  /** Days before `promisedDate` that the promise was recorded, or an unrelated date offset. */
  recordedOffset: number;
  /** When true, `recordedOn` is `promisedDate - recordedOffset`; otherwise `today - recordedOffset` (may be after promisedDate). */
  relativeToPromise: boolean;
  amountPaise: number;
  /** Where in the history array the promise is inserted (taken modulo length + 1). */
  position: number;
}

const arbExpiredPromiseInjection: fc.Arbitrary<ExpiredPromiseInjection> = fc.record({
  // Biased towards the boundary: a promise that falls due exactly today or yesterday.
  promisedAgo: fc.oneof({ weight: 3, arbitrary: fc.integer({ min: 0, max: 2 }) }, { weight: 2, arbitrary: fc.integer({ min: 0, max: 400 }) }),
  recordedOffset: fc.integer({ min: -30, max: 90 }),
  relativeToPromise: fc.boolean(),
  amountPaise: fc.integer({ min: 1, max: 1_000_000_000 }),
  position: fc.nat({ max: 20 }),
});

/** Adds one promise with promisedDate <= today (recordedOn possibly after it, or after today) to the history. */
function withExpiredPromise(scenario: Scenario, injection: ExpiredPromiseInjection): Scenario {
  const promisedDate = shiftDays(scenario.today, -injection.promisedAgo);
  const recordedOn = injection.relativeToPromise
    ? shiftDays(promisedDate, -Math.max(0, injection.recordedOffset))
    : shiftDays(scenario.today, -injection.recordedOffset);
  const promise: EscalationEvent = { kind: "promise", recordedOn, promisedDate, amountPaise: injection.amountPaise };
  const at = injection.position % (scenario.history.length + 1);
  const history: EscalationHistory = [...scenario.history.slice(0, at), promise, ...scenario.history.slice(at)];
  return { ...scenario, history };
}

describe("escalation-ladder property: expired promises", () => {
  // Feature: legal-engine, Property 15: Expired promises do not affect the decision
  it("Property 15: Expired promises do not affect the decision", () => {
    // **Validates: Requirements 6.9**
    const baseReasons = { advance: 0, cooldown: 0, promise_active: 0, ladder_complete: 0 };

    fc.assert(
      fc.property(
        arbScenario,
        fc.array(arbExpiredPromiseInjection, { minLength: 1, maxLength: 3 }),
        (base, injections) => {
          const withPromises = injections.reduce(withExpiredPromise, base);
          expect(withPromises.history.length).toBe(base.history.length + injections.length);

          const before = nextEscalationStep(base.invoice, base.history, base.today, base.config);
          const after = nextEscalationStep(withPromises.invoice, withPromises.history, withPromises.today, withPromises.config);

          // Same decision, including the cooldown outcome: an expired promise date does not restart it.
          expect(after).toEqual(before);

          if (before.action === "advance") baseReasons.advance += 1;
          else if (before.reason === "cooldown") baseReasons.cooldown += 1;
          else if (before.reason === "promise_active") baseReasons.promise_active += 1;
          else if (before.reason === "ladder_complete") baseReasons.ladder_complete += 1;
        },
      ),
    );

    // The cases where an expired promise could plausibly matter must have been exercised.
    for (const [kind, count] of Object.entries(baseReasons)) {
      expect(count, `no base "${kind}" case was generated`).toBeGreaterThan(0);
    }
  });

  it("an expired promise does not reset the cooldown (examples)", () => {
    const invoice: Invoice = {
      id: "inv-1",
      supplierCategory: "small",
      supplierActivity: "manufacturing",
      acceptedOn: "2026-01-01",
      amountPaise: 100_000,
    };
    const today = "2026-06-30";
    const config: LadderConfig = { stepGapDays: 7 };
    const promise = (promisedDate: CalendarDate): EscalationEvent => ({
      kind: "promise",
      recordedOn: "2026-06-01",
      promisedDate,
      amountPaise: 100_000,
    });

    // Last step 3 days ago, promise fell due yesterday: still in cooldown.
    const recentStep: EscalationEvent = { kind: "step", step: "whatsapp_nudge", on: "2026-06-27" };
    const inCooldown = nextEscalationStep(invoice, [recentStep, promise("2026-06-29")], today, config);
    expect(inCooldown).toMatchObject({ action: "wait", reason: "cooldown" });

    // Last step 8 days ago, promise falls due today: cooldown is measured from the step, so the ladder advances.
    const oldStep: EscalationEvent = { kind: "step", step: "whatsapp_nudge", on: "2026-06-22" };
    const advanced = nextEscalationStep(invoice, [oldStep, promise(today)], today, config);
    expect(advanced).toMatchObject({ action: "advance", step: "whatsapp_paylink", rank: 2 });
  });
});

// ---------------------------------------------------------------------------
// Property 16: day-by-day simulation climbs one rung at a time
// ---------------------------------------------------------------------------

const SIMULATION_DAYS = 400;

interface Simulation {
  /** Covered invoice, Unpaid on every simulated day. */
  invoice: Invoice;
  /** Events that have all happened on or before `start`. */
  startingHistory: EscalationHistory;
  start: CalendarDate;
  config: LadderConfig;
}

/**
 * Starting history for the simulation: step events of any rank and promises, all dated on or
 * before `start` (an event dated later would "happen" mid-simulation and could make the ladder
 * skip a rung through no fault of the engine). Promises may still fall due after `start`.
 * Empty histories and ladder prefixes are favoured so the full ladder can complete.
 */
function arbStartingHistory(start: CalendarDate): fc.Arbitrary<EscalationHistory> {
  const stepEvent: fc.Arbitrary<EscalationEvent> = fc
    .tuple(fc.constantFrom(...ORACLE_STEP_ORDER), fc.integer({ min: 0, max: 40 }))
    .map(([step, daysAgo]) => ({ kind: "step", step, on: shiftDays(start, -daysAgo) }));

  const promiseEvent: fc.Arbitrary<EscalationEvent> = fc
    .tuple(fc.integer({ min: 0, max: 40 }), fc.integer({ min: -10, max: 30 }), fc.integer({ min: 1, max: 1_000_000 }))
    .map(([recordedAgo, promiseOffset, amountPaise]) => ({
      kind: "promise",
      recordedOn: shiftDays(start, -recordedAgo),
      promisedDate: shiftDays(start, promiseOffset),
      amountPaise,
    }));

  const prefix: fc.Arbitrary<EscalationHistory> = fc
    .tuple(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 14 }), fc.integer({ min: 0, max: 30 }))
    .map(([k, gap, lastAgo]) =>
      ORACLE_STEP_ORDER.slice(0, k).map(
        (step, i): EscalationEvent => ({ kind: "step", step, on: shiftDays(start, -(lastAgo + gap * (k - 1 - i))) }),
      ),
    );

  return fc.oneof(
    { weight: 4, arbitrary: fc.constant<EscalationHistory>([]) },
    { weight: 2, arbitrary: prefix },
    { weight: 3, arbitrary: fc.array(fc.oneof(stepEvent, promiseEvent), { maxLength: 6 }) },
  );
}

const arbSimulation: fc.Arbitrary<Simulation> = arbCoveredInvoice.map(unpaid).chain((invoice) =>
  // Start from 5 days before the Due_Date to 10 days after, so the ladder has almost all 400 days to climb.
  fc.integer({ min: -5, max: 10 }).chain((offset) => {
    const start = shiftDays(oracleDueDate(invoice), offset);
    return fc
      .tuple(arbStartingHistory(start), arbLadderConfig)
      .map(([startingHistory, config]): Simulation => ({ invoice, startingHistory, start, config }));
  }),
);

describe("escalation-ladder property: day-by-day simulation", () => {
  // Feature: legal-engine, Property 16: Day-by-day simulation climbs one rung at a time
  it("Property 16: Day-by-day simulation climbs one rung at a time", () => {
    // **Validates: Requirements 6.14, 6.7, 6.12**
    let runs = 0;
    let runsReachingRank5 = 0;

    fc.assert(
      fc.property(arbSimulation, ({ invoice, startingHistory, start, config }) => {
        const history: EscalationEvent[] = [...startingHistory];
        const due = oracleDueDate(invoice);

        const startingSteps = startingHistory.flatMap((event) => (event.kind === "step" ? [event] : []));
        const highestStartingRank = startingSteps.reduce((best, event) => Math.max(best, oracleRank(event.step)), 0);
        const latestStartingStepOn = startingSteps.reduce<CalendarDate | undefined>(
          (best, event) => (best === undefined || daysBetween(best, event.on) > 0 ? event.on : best),
          undefined,
        );

        let maxRank = highestStartingRank;
        let lastAdvanceOn: CalendarDate | undefined;
        let reachedRank5ByAdvance = false;

        for (let day = 0; day < SIMULATION_DAYS; day += 1) {
          const today = shiftDays(start, day);
          const decision = nextEscalationStep(invoice, history, today, config);

          if (decision.action === "wait") {
            // Once the top rung is used the ladder stays complete, unless a promise is the reason it waits.
            // (`not_overdue` outranks both, so only check days after the Due_Date.)
            if (maxRank === 5 && daysBetween(due, today) > 0) {
              expect(["ladder_complete", "promise_active"]).toContain(decision.reason);
            }
            continue;
          }

          // An advance: only on a day after the Due_Date, never once rank 5 is used.
          expect(daysBetween(due, today)).toBeGreaterThan(0);
          expect(maxRank, `advance to "${decision.step}" after rank 5`).toBeLessThan(5);

          // Exactly one rung up: the first advance is highestStartingRank + 1 (1 for an empty history).
          expect(decision.rank).toBe(maxRank + 1);
          expect(oracleRank(decision.step)).toBe(decision.rank);
          expect(decision.rank).toBeLessThanOrEqual(5);

          // At least stepGapDays after the previous step event, the previous advance or, for the
          // first advance, the latest starting step.
          const previous = lastAdvanceOn ?? latestStartingStepOn;
          if (previous !== undefined) {
            expect(daysBetween(previous, today)).toBeGreaterThanOrEqual(config.stepGapDays);
          }

          maxRank = decision.rank;
          lastAdvanceOn = today;
          if (decision.rank === 5) reachedRank5ByAdvance = true;
          history.push({ kind: "step", step: decision.step, on: today });
        }

        runs += 1;
        if (reachedRank5ByAdvance) runsReachingRank5 += 1;
        expect(maxRank).toBeLessThanOrEqual(5);
      }),
    );

    // The simulation must be able to finish the whole ladder, or the "no advance after rank 5" check never ran.
    expect(runs).toBeGreaterThan(0);
    expect(runsReachingRank5, "no simulation climbed all the way to rank 5").toBeGreaterThan(0);
  });
});
