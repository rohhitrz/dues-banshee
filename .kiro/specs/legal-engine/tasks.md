# Implementation Plan: legal-engine

## Overview

Build `packages/engine` in TypeScript (strict) inside a new pnpm monorepo, following the module layout in `design.md`. The order follows the dependency direction in the design: calendar dates and types first, then validation, coverage and due date, then interest, tax bomb, escalation ladder and rupee formatting. The last step checks the public API in `index.ts` and adds the cross-module properties. Each module adds its own re-export to `src/index.ts` when it is written, so no code is left unwired.

Commit rules for every task (from `.kiro/steering/git-workflow.md`, Requirement 9):
- Commit only when `pnpm test` and `pnpm typecheck` pass for the files you touched. Tests run once with `vitest run` (never watch mode).
- One commit per top-level task, message `<type>(engine): <subject>` (≤ 72 chars, imperative), body `Spec: legal-engine, task <n>`.
- Stage files by explicit path (`git add <paths>`), then run `git diff --staged` and confirm there are no `.env` files, keys or tokens.
- Use the existing git identity. Add no `Co-Authored-By` or AI attribution trailers. Never push.
- Keep `.kiro/` and all its sub-folders tracked (never add them to `.gitignore`).

## Tasks

- [~] 1. Commit the legal-engine spec and steering updates
  - [-] 1.1 Commit `requirements.md`, `design.md`, `tasks.md` and `.config.kiro`
    - Run `git status` and confirm what is staged and unstaged
    - `git add .kiro/specs/legal-engine/` only. The steering changes are committed separately in 1.2
    - Check `git diff --staged` for secrets
    - Commit: `docs(kiro): add legal-engine spec (requirements, design, tasks)`, body `Spec: legal-engine, task 1`
    - _Requirements: 9.1, 9.3, 9.4, 9.5_
  - [ ] 1.2 Commit the steering updates
    - Run `git status` and confirm what is staged and unstaged
    - `git add .kiro/steering/legal-rules.md .kiro/steering/product.md` only
    - Check `git diff --staged` for secrets
    - Commit: `docs(kiro): add MSMED scope, ODR portal and trader exclusion to steering`, body `Spec: legal-engine, task 1`
    - _Requirements: 9.1, 9.3, 9.4, 9.5_

- [ ] 2. Set up the pnpm workspace and the engine package
  - [ ] 2.1 Create root workspace files (only those that do not exist yet)
    - `pnpm-workspace.yaml` with `packages: ["apps/*", "packages/*"]`
    - Root `package.json`: `private: true`, `packageManager: pnpm@<installed version>`, `engines.node: ">=20"`, scripts `test: pnpm -r --if-present run test`, `typecheck: pnpm -r --if-present run typecheck`, `lint: pnpm -r --if-present run lint`
    - Root dev dependencies (latest stable): `typescript`, `vitest`, `fast-check`, `eslint`, `typescript-eslint`, `@types/node`
    - `tsconfig.base.json` with the compiler options from the design (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, …)
    - `eslint.config.js` (flat config, typescript-eslint) with the engine purity rules for `packages/engine/src/**`: `no-restricted-globals` (`Date`, `process`, `fetch`, `setTimeout`, `setInterval`, `performance`), `no-restricted-imports` (`node:*`, `fs`, `path`, `http`, `https`, `net`, `child_process`), `no-restricted-properties` (`Math.random`)
    - Confirm the existing `.gitignore` contains `node_modules/`, `.next/`, `dist/`, `coverage/`, `.turbo/`, `.vercel/`, `.env`, `.env.*`, `!.env.example`, `*.log`, `.DS_Store`. Add any that are missing. It must not ignore `.kiro/`
    - _Requirements: 1.1, 1.2, 1.5, 1.6, 9.5_
  - [ ] 2.2 Create the `packages/engine` package skeleton
    - `package.json`: name `@dues-banshee/engine`, `type: module`, `exports: { ".": "./src/index.ts" }`, no `dependencies`, scripts `test: vitest run`, `typecheck: tsc --noEmit`, `lint: eslint src test`
    - `tsconfig.json` extending `../../tsconfig.base.json`, `lib: ["ES2022"]` with no DOM, `types: []` for `src`, includes `src` and `test`
    - `vitest.config.ts` (`include: ["test/**/*.test.ts"]`, `setupFiles: ["test/setup.ts"]`, `environment: "node"`)
    - `test/setup.ts` calling `fc.configureGlobal({ numRuns: 200 })`
    - Empty `src/index.ts` (later tasks add re-exports)
    - `test/package.test.ts`: unit test that the engine `package.json` has no `dependencies` field or an empty one, so `pnpm test` has a real test to run
    - Run `pnpm install`, `pnpm test`, `pnpm typecheck`, `pnpm lint`. All must exit 0
    - _Requirements: 1.3, 1.4, 1.5, 1.7_
  - [ ] 2.3 Commit task 2
    - `git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json eslint.config.js .gitignore packages/engine` (only the files that changed)
    - Check `git diff --staged`, then commit `chore(engine): set up pnpm workspace and engine package`, body `Spec: legal-engine, task 2`
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [ ] 3. Add core types, rule IDs, the validation error and calendar-date helpers
  - [ ] 3.1 Create `src/types.ts`, `src/rule-ids.ts` and `src/validation-error.ts`
    - `types.ts`: `CalendarDate`, `Paise`, `SupplierCategory`, `SupplierActivity`, `Invoice`, `BankRate`, `NonCoverageReason`, `Caveat`, `NonCoverageResult`, `CoverageResult`, `DueDateResult`, `InterestResult`, `TaxBombStatus`, `TaxBombResult`, `LadderStep`, `StepEvent`, `PromiseEvent` (with `kind` discriminant), `EscalationEvent`, `EscalationHistory`, `LadderConfig`, `CoveredWaitReason`, `WaitReason`, `EscalationDecision`, `InrStyle`, exactly as in the design's Data Models
    - `rule-ids.ts`: `RULE_IDS` readonly tuple (`MSMED-15`, `MSMED-16`, `MSMED-18`, `IT-43BH`, `MSMED-SCOPE`, `MSMED-ODR`) and `RuleId`
    - `validation-error.ts`: `ValidationError` with `field`, `reason`, optional `value`, message `${field}: ${reason}`
    - Re-export the types, `RULE_IDS`, `RuleId` and `ValidationError` from `src/index.ts`
    - _Requirements: 8.1, 2.1_
  - [ ] 3.2 Implement `src/calendar-date.ts`
    - `isValidCalendarDate` (`^\d{4}-\d{2}-\d{2}$`, years 1900–9999, Gregorian leap rule), `toEpochDay` / `fromEpochDay` (Hinnant `days_from_civil` / `civil_from_days`, integer-only, zero-padded output), `addDays`, `dayDifference`, `compareDates` (-1/0/1), `financialYearEnd` (month ≥ 4 → `${y+1}-03-31`, else `${y}-03-31`)
    - No use of `Date`
    - _Requirements: 1.6, 2.1, 5.1_
  - [ ] 3.3 Write property test for calendar arithmetic in `test/calendar-date.property.test.ts`
    - **Property 1: Calendar arithmetic round trip**
    - `fromEpochDay(toEpochDay(d)) === d` and `dayDifference(d, addDays(d, n)) === n` for dates 1900-01-01 to 9999-12-31
    - **Validates: Requirements 2.1, 3.1, 4.4, 5.10**
  - [ ] 3.4 Write unit tests in `test/calendar-date.test.ts` and `test/rule-ids.test.ts`
    - `dayDifference("2026-10-17", "2026-11-12") === 26`; `dayDifference("2026-11-12", "2027-03-31") === 139`; `addDays("2026-09-02", 45) === "2026-10-17"`
    - `isValidCalendarDate` rejects `2026-02-30`, `2027-02-29`, `2026-04-31`, `2026-1-5`, month `00`/`13`; accepts `2028-02-29`
    - `financialYearEnd("2026-09-02") === "2027-03-31"`, `financialYearEnd("2027-03-31") === "2027-03-31"`, `financialYearEnd("2027-04-01") === "2028-03-31"`
    - `RULE_IDS` equals exactly the six IDs in order
    - _Requirements: 2.1, 5.1, 8.1_
  - [ ] 3.5 Commit task 3
    - `git add` the new `src/` and `test/` files by path, check `git diff --staged`
    - Commit `feat(engine): add core types, rule IDs and calendar date helpers`, body `Spec: legal-engine, task 3`
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [ ] 4. Add input validation and shared test generators
  - [ ] 4.1 Implement `src/validate.ts`
    - `assertCalendarDate(field, value)`, `assertPaise(field, value)`, `validateInvoice` (fields in declaration order: `id` non-empty, `amountPaise` integer 1..1e13, `acceptedOn`, `agreedTermDays` positive integer if present, `supplierCategory` and `supplierActivity` in their enums, `udyamRegisteredOn` valid date if present, `paidOn` valid and not before `acceptedOn`), `validateBankRate` (`annualBps` integer 0..5000, `asOf` date), `validateHistory` (indexed field paths such as `history[2].promisedDate`, valid `LadderStep`, promise `amountPaise` positive safe integer; `recordedOn ≤ promisedDate` not enforced), `validateLadderConfig` (`stepGapDays` positive integer)
    - Export `MAX_PAISE = 1_00_000_00_00_000` from a single place (the design lists it under `statutory-interest.ts`; define it here and re-export it there to avoid a cycle)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_
  - [ ] 4.2 Create `test/arbitraries.ts` and `test/fixtures.ts`
    - `fixtures.ts`: the Sharma Traders invoice (`amountPaise` 41200000, `acceptedOn` 2026-09-02, `agreedTermDays` 45, `micro`, `manufacturing`) and `bankRate575 = { annualBps: 575, asOf: "2026-10-07" }`
    - `arbitraries.ts`: `arbCalendarDate`, `arbInvalidDateString`, `arbCoveredInvoice`, `arbNonCoveredInvoice`, `arbInvoice`, `arbBankRate`, `arbToday(inv)`, `arbHistory(inv)`, `arbLadderConfig`, plus the late-registration pairing for Property 5 and the 15 Feb–31 Mar acceptance branch for Property 11, with the ranges and biases in the design's Generators section
    - _Requirements: 1.4_
  - [ ] 4.3 Write unit tests for validation in `test/validate.test.ts`
    - One case per rule: `2026-02-30` names the field; `amountPaise` 0, 1.5 and 1e13 + 1 name `amountPaise`; `agreedTermDays` 0 names `agreedTermDays`; `paidOn` before `acceptedOn` names `paidOn`; `annualBps` -1 and 5001 name `annualBps`; `stepGapDays` 0 names `stepGapDays`; `supplierActivity` `"retail"` names `supplierActivity`; bad `udyamRegisteredOn` names `udyamRegisteredOn`; bad history entry reports `history[i].<field>`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_
  - [ ] 4.4 Commit task 4
    - `git add` the touched files by path, check `git diff --staged`
    - Commit `feat(engine): add input validation and test generators`, body `Spec: legal-engine, task 4`
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [ ] 5. Implement coverage (MSMED-SCOPE) and the statutory due date (MSMED-15)
  - [ ] 5.1 Implement `src/coverage.ts`
    - `coverage(invoice)`: category `medium`/`unregistered` → `nonCoverageResult("medium_or_unregistered")` (checked first, including traders); `trading` → `nonCoverageResult("trader")`; covered with `udyamRegisteredOn` after `acceptedOn` → `caveat: "registered_after_supply"`, `ruleIds: ["MSMED-SCOPE"]`
    - `nonCoverageResult(reason)` → `{ applicable: false, reason, ruleIds: ["MSMED-SCOPE"] }`
    - Internal `withCaveat(result, cov)` that copies the caveat and adds `MSMED-SCOPE`, plus a helper that de-duplicates `ruleIds` and orders them by `RULE_IDS`
    - Re-export `coverage` from `src/index.ts`
    - _Requirements: 8.3, 8.4, 8.5, 8.6_
  - [ ] 5.2 Implement `src/due-date.ts`
    - Validate, return the Non_Coverage_Result (no `dueDate` field) for non-covered invoices, else `addDays(acceptedOn, agreedTermDays === undefined ? 15 : min(agreedTermDays, 45))` with `ruleIds: ["MSMED-15"]` plus caveat
    - Re-export `dueDate` from `src/index.ts`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.8, 8.2_
  - [ ] 5.3 Write property test for the due date in `test/due-date.property.test.ts`
    - **Property 3: Due date follows MSMED-15**
    - Oracle: difference is `min(agreedTermDays, 45)` or 15, always 1..45, `ruleIds` contains `MSMED-15`
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.6, 3.7, 8.2**
  - [ ] 5.4 Write unit tests in `test/due-date.test.ts` and `test/coverage.test.ts`
    - Sharma Traders `dueDate` → `2026-10-17`, `ruleIds` `["MSMED-15"]`
    - Term 60 → 45 days; no term → 15 days
    - Medium trader → reason `medium_or_unregistered`; micro trader → reason `trader`, `ruleIds` `["MSMED-SCOPE"]`, no `dueDate`
    - `udyamRegisteredOn` after `acceptedOn` → still covered, caveat present, `ruleIds` `["MSMED-15", "MSMED-SCOPE"]`
    - _Requirements: 3.5, 3.8, 8.4, 8.5, 8.6_
  - [ ] 5.5 Commit task 5
    - `git add` the touched files by path, check `git diff --staged`
    - Commit `feat(engine): add coverage check and MSMED-15 due date`, body `Spec: legal-engine, task 5`
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [ ] 6. Checkpoint: tests, typecheck and lint pass
  - Run `pnpm test`, `pnpm typecheck` and `pnpm lint`. Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Implement statutory interest (MSMED-16)
  - [ ] 7.1 Implement `src/statutory-interest.ts`
    - Validate invoice, `today`, `bankRate`; return `{ ...nonCoverage, interestPaise: 0 }` for non-covered invoices
    - Accrual end = earlier of `paidOn` and `today`; `d = max(0, dayDifference(due, end))`
    - `d = 0` or `annualBps = 0` → 0; `d % 30 === 0` → exact BigInt path (`N = 120000n + 3n·bps`, `D = 120000n`, half-up via `(2·num + den) / (2·den)`); otherwise float path `Math.floor(A · Math.expm1((d/30) · Math.log1p(3·bps/120000)) + 0.5)`
    - Throw `ValidationError("today", "interest exceeds the safe integer range")` above `Number.MAX_SAFE_INTEGER`
    - Return `interestPaise`, `accrualDays`, `statutoryRateBps = 3·annualBps`, `rateAsOf = bankRate.asOf`, `ruleIds: ["MSMED-16"]` plus caveat
    - Re-export `statutoryInterest` and `MAX_PAISE` from `src/index.ts`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 8.2_
  - [ ] 7.2 Write property test in `test/statutory-interest.property.test.ts`
    - **Property 6: Interest matches the Interest_Convention**
    - Non-negative safe integer within `0.5 + 1e-9·interestPaise` of `A·((1+r)^(d/30) − 1)`; `accrualDays`, `statutoryRateBps`, `rateAsOf`, `MSMED-16` checked; cap Accrual_Days at 3,650
    - **Validates: Requirements 4.1, 4.2, 4.5, 4.8, 8.2**
  - [ ] 7.3 Write property test in `test/statutory-interest.property.test.ts`
    - **Property 7: No interest on or before the due date**
    - **Validates: Requirements 4.3, 4.10**
  - [ ] 7.4 Write property test in `test/statutory-interest.property.test.ts`
    - **Property 8: Interest never decreases as time passes**
    - **Validates: Requirements 4.9**
  - [ ] 7.5 Write property test in `test/statutory-interest.property.test.ts`
    - **Property 9: Whole-month rests are exact**
    - `today = addDays(dueDate, 30·m)`, no `paidOn`; compare against an independent BigInt rational reference written in the test
    - **Validates: Requirements 4.11**
  - [ ] 7.6 Write unit tests in `test/statutory-interest.test.ts`
    - Sharma Traders, `today` 2026-11-12, 575 bps → `accrualDays === 26`, `interestPaise === 512794` (₹5,127.94), `statutoryRateBps === 1725`, `rateAsOf === "2026-10-07"`, `ruleIds` contains `MSMED-16`
    - `today` 2026-10-18 → `accrualDays === 1`; `today` 2026-10-17 → `interestPaise === 0`
    - `today` 2026-11-16 (30 days) → `interestPaise === 592250`
    - `paidOn` 2026-11-01, `today` 2026-11-12 → accrual ends on 2026-11-01 (15 days)
    - Non-covered invoice → `applicable: false`, `interestPaise: 0`
    - Overflow input (₹1,000 crore, 5000 bps, many years) → `ValidationError` with `field === "today"`
    - _Requirements: 4.3, 4.4, 4.5, 4.6, 4.7, 4.11_
  - [ ] 7.7 Commit task 7
    - `git add` the touched files by path, check `git diff --staged`
    - Commit `feat(engine): add statutoryInterest with monthly rests (MSMED-16)`, body `Spec: legal-engine, task 7`
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [ ] 8. Implement the tax bomb (IT-43BH)
  - [ ] 8.1 Implement `src/tax-bomb.ts`
    - Validate invoice and `today`; non-covered → `{ ...nonCoverage, status: "not_applicable", deductionAtRiskPaise: 0 }` with no date fields
    - `taxBombDate = financialYearEnd(acceptedOn)`; `deductionDeadline` = later of `taxBombDate` and Due_Date
    - Status table: paid on/before deadline → `defused`, 0, 0; paid after deadline → `exploded`, 0, A; unpaid and `today ≤ deadline` → `armed`, `dayDifference(today, deadline)`, A; unpaid and `today > deadline` → `exploded`, 0, A
    - `ruleIds: ["IT-43BH"]` plus caveat; re-export `taxBomb` from `src/index.ts`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.11, 8.2_
  - [ ] 8.2 Write property test in `test/tax-bomb.property.test.ts`
    - **Property 10: Tax_Bomb_Date and Deduction_Deadline**
    - **Validates: Requirements 5.1, 5.9**
  - [ ] 8.3 Write property test in `test/tax-bomb.property.test.ts`
    - **Property 11: Tax bomb status oracle**
    - Include the 15 Feb–31 Mar acceptance branch so Due_Date falls after the Tax_Bomb_Date
    - **Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.7, 5.10, 5.11, 8.2**
  - [ ] 8.4 Write unit tests in `test/tax-bomb.test.ts`
    - Sharma Traders, `today` 2026-11-12 → `taxBombDate` 2027-03-31, `deductionDeadline` 2027-03-31, `armed`, `daysLeft` 139, `deductionAtRiskPaise` 41200000, `ruleIds` contains `IT-43BH`
    - Accepted 2027-03-10, term 45, `today` 2027-03-20 → `taxBombDate` 2027-03-31, `deductionDeadline` 2027-04-24, `armed`, `daysLeft` 35
    - Paid 2027-04-05 after deadline 2027-03-31, `today` 2027-04-10 → `exploded`, 0, A
    - Paid 2027-01-15, `today` 2027-02-01 → `defused`, 0, 0
    - Unpaid, `today` 2027-04-01 → `exploded`, 0, A
    - Non-covered → `not_applicable`, `deductionAtRiskPaise` 0, no `taxBombDate`
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.6, 5.8, 5.11_
  - [ ] 8.5 Commit task 8
    - `git add` the touched files by path, check `git diff --staged`
    - Commit `feat(engine): add taxBomb for 31 March deduction risk (IT-43BH)`, body `Spec: legal-engine, task 8`
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [ ] 9. Checkpoint: tests, typecheck and lint pass
  - Run `pnpm test`, `pnpm typecheck` and `pnpm lint`. Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Implement the escalation ladder decision
  - [ ] 10.1 Implement `src/escalation-ladder.ts`
    - `LADDER_STEPS`, `stepRank`, `APPROVAL_STEPS` (`voice_call`, `legal_notice`, `odr_pack`), `DEFAULT_STEP_GAP_DAYS = 7`
    - `nextEscalationStep(invoice, history, today, config = { stepGapDays: 7 })`: validate all inputs, ignore events dated after `today`, then check in order: `paid` → non-coverage reason → `not_overdue` (`today ≤ dueDate`) → `promise_active` (`promisedDate > today`) → `ladder_complete` (max rank 5) → `cooldown` (`dayDifference(latestStepOn, today) < stepGapDays`, latest by date not array position) → `advance` to `maxRank + 1`
    - Wait decisions carry `ruleIds: []` (plus `MSMED-SCOPE` and caveat when registered after supply); a paid non-covered invoice returns `paid` with `applicable: false` and `ruleIds: []`
    - Advance: `{ action: "advance", applicable: true, step, rank, requiresApproval, ruleIds }` with `ruleIds` `["MSMED-15"]`, or `["MSMED-15", "MSMED-18", "MSMED-ODR"]` for `odr_pack`, plus caveat
    - Re-export `nextEscalationStep`, `LADDER_STEPS`, `stepRank`, `APPROVAL_STEPS`, `DEFAULT_STEP_GAP_DAYS` from `src/index.ts`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 6.15, 8.2_
  - [ ] 10.2 Write property test in `test/escalation-ladder.property.test.ts`
    - **Property 12: Escalation precedence oracle**
    - Independent oracle in the test, written from the precedence table
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.15**
  - [ ] 10.3 Write property test in `test/escalation-ladder.property.test.ts`
    - **Property 13: Advances never skip, go backwards, or miss approval**
    - **Validates: Requirements 6.10, 6.11, 6.12**
  - [ ] 10.4 Write property test in `test/escalation-ladder.property.test.ts`
    - **Property 14: An active promise blocks advancing**
    - **Validates: Requirements 6.4, 6.13**
  - [ ] 10.5 Write property test in `test/escalation-ladder.property.test.ts`
    - **Property 15: Expired promises do not affect the decision**
    - **Validates: Requirements 6.9**
  - [ ] 10.6 Write property test in `test/escalation-ladder.property.test.ts`
    - **Property 16: Day-by-day simulation climbs one rung at a time**
    - Step `today` forward up to 400 days, append each `advance` as a step event; ranks rise by exactly 1, advances are at least `stepGapDays` apart, max rank 5
    - **Validates: Requirements 6.14, 6.7, 6.12**
  - [ ] 10.7 Write unit tests in `test/escalation-ladder.test.ts`
    - Sharma Traders, empty history, `today` 2026-10-18 → `advance`, `whatsapp_nudge`, `requiresApproval` false
    - `today` 2026-10-17 → `wait`, `not_overdue`
    - History up to `legal_notice` 7+ days before `today` → `odr_pack`, `requiresApproval` true, `ruleIds` contains `MSMED-18` and `MSMED-ODR`
    - Step 3 days ago with `stepGapDays` 7 → `cooldown`
    - Active promise → `promise_active`; same promise after its date passes → resumes at `maxRank + 1`
    - Paid invoice with active promise → `paid`; ladder complete inside cooldown → `ladder_complete`
    - History with only rank 3 → advances to rank 4; history array out of date order → cooldown uses the latest date
    - _Requirements: 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 6.15_
  - [ ] 10.8 Commit task 10
    - `git add` the touched files by path, check `git diff --staged`
    - Commit `feat(engine): add nextEscalationStep for the five-step ladder`, body `Spec: legal-engine, task 10`
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [ ] 11. Implement Indian rupee formatting and parsing
  - [ ] 11.1 Implement `formatINR` in `src/format-inr.ts`
    - Validate `paise` as a non-negative safe integer (`ValidationError` otherwise)
    - `groupIndian` helper (last three digits, then pairs)
    - Full: `₹` + grouped rupees + `.` + two paise digits only when paise ≠ 0
    - Short, integer arithmetic only: `≥ 1e9` paise → hundredths of a crore, suffix `Cr`; `1e7..1e9` → hundredths of a lakh, suffix `L`, bump to `₹1Cr` when it rounds to 100L; below 1e7 → whole rupees half-up, bump to `₹1L` at 1,00,000; strip trailing zeros and point
    - Re-export `formatINR` from `src/index.ts`
    - _Requirements: 7.1, 7.2, 7.4, 7.5, 7.8_
  - [ ] 11.2 Implement `parseINR` in `src/format-inr.ts`
    - Accept only canonical Full_Format: `^₹(0|[1-9]\d{0,2}|[1-9]\d?(?:,\d{2})*,\d{3})(?:\.(\d{2}))?$`, paise group not `00`, result a safe integer
    - Otherwise throw `ValidationError("text", "not in Full_Format: \"<input>\"")`
    - Re-export `parseINR` from `src/index.ts`
    - _Requirements: 7.6, 7.7_
  - [ ] 11.3 Write property test in `test/format-inr.property.test.ts`
    - **Property 17: Full format round trip from paise**
    - **Validates: Requirements 7.1, 7.6, 7.9**
  - [ ] 11.4 Write property test in `test/format-inr.property.test.ts`
    - **Property 18: Full format round trip from text**
    - **Validates: Requirements 7.10**
  - [ ] 11.5 Write property test in `test/format-inr.property.test.ts`
    - **Property 19: Short format tier and accuracy**
    - **Validates: Requirements 7.2**
  - [ ] 11.6 Write property test in `test/format-inr.property.test.ts`
    - **Property 20: Formatter and parser reject bad input**
    - Mutations: drop `₹`, western grouping, leading zeros, `.00`, one paise digit, `L`/`Cr` suffix, spaces, arbitrary unicode; error message contains the input
    - **Validates: Requirements 7.5, 7.7**
  - [ ] 11.7 Write unit tests in `test/format-inr.test.ts`
    - `formatINR(41200000, "full") === "₹4,12,000"`, `formatINR(41200000, "short") === "₹4.12L"`
    - `formatINR(0, "full") === "₹0"`, `formatINR(1250000000, "short") === "₹1.25Cr"`, `formatINR(41200050, "full") === "₹4,12,000.50"`, `formatINR(1250000000, "full") === "₹1,25,00,000"`
    - `formatINR(40000000, "short") === "₹4L"`, `formatINR(41000000, "short") === "₹4.1L"`
    - Bump rules: `formatINR(999950000, "short") === "₹1Cr"`, `formatINR(9999950, "short") === "₹1L"`
    - `parseINR("₹4,12,000") === 41200000`; `parseINR("₹412,000")` throws `ValidationError` quoting the input
    - `formatINR(-1)`, `formatINR(1.5)`, `formatINR(NaN)` throw `ValidationError`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_
  - [ ] 11.8 Commit task 11
    - `git add` the touched files by path, check `git diff --staged`
    - Commit `feat(engine): add formatINR and parseINR with Indian grouping`, body `Spec: legal-engine, task 11`
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [ ] 12. Finalise the public API and add cross-module properties
  - [ ] 12.1 Review `src/index.ts` against the design's Public API
    - Exports exactly: `coverage`, `dueDate`, `statutoryInterest`, `taxBomb`, `nextEscalationStep`, `formatINR`, `parseINR`, `ValidationError`, `RULE_IDS`, `MAX_PAISE`, `LADDER_STEPS`, `stepRank`, `APPROVAL_STEPS`, `DEFAULT_STEP_GAP_DAYS` and all public types; no internal helpers
    - Confirm every public function validates its inputs in the fixed order (invoice fields, `today`, `bankRate`, `history`, `config`)
    - _Requirements: 1.6, 7.8, 8.1, 8.2_
  - [ ] 12.2 Write property test in `test/validation.property.test.ts`
    - **Property 2: Invalid input is rejected with the field name**
    - Corrupt exactly one field and check every public function taking it throws `ValidationError` with that `field`
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8**
  - [ ] 12.3 Write property test in `test/coverage.property.test.ts`
    - **Property 4: Non-covered invoices get only MSMED-SCOPE**
    - **Validates: Requirements 3.8, 4.6, 5.6, 6.2, 8.3, 8.4, 8.7**
  - [ ] 12.4 Write property test in `test/coverage.property.test.ts`
    - **Property 5: Registered-after-supply caveat**
    - **Validates: Requirements 8.5, 8.6**
  - [ ] 12.5 Write unit tests in `test/purity.test.ts`
    - Call all four invoice functions for the Sharma Traders invoice under `vi.setSystemTime` at two different instants; results are identical
    - Late-registered Sharma invoice: caveat and `MSMED-SCOPE` on `dueDate`, `statutoryInterest`, `taxBomb` and `nextEscalationStep`
    - _Requirements: 1.6, 8.5, 8.6_
  - [ ] 12.6 Commit task 12
    - `git add` the touched files by path, check `git diff --staged`
    - Commit `test(engine): add cross-module validation and coverage properties`, body `Spec: legal-engine, task 12`
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [ ] 13. Final checkpoint: tests, typecheck and lint pass
  - Run `pnpm install`, `pnpm test`, `pnpm typecheck` and `pnpm lint` from the repo root. Ensure all tests pass, ask the user if questions arise.

## Notes

- All sub-tasks are required, including every property test and unit test. The commit for a task requires tests and typecheck to pass for the files that were written.
- Property tests use fast-check with `numRuns: 200` (set in `test/setup.ts`). Each property test carries a comment `// Feature: legal-engine, Property N: <title>`.
- Each task references requirement clauses for traceability. Requirement 9 is met by the commit sub-tasks.
- The commit sub-tasks touch the git index, so they run alone in their wave and only after the task's other sub-tasks.
- Sub-tasks that write to the same file (`src/index.ts`, `src/format-inr.ts`, each `*.property.test.ts`) are in different waves.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1"] },
    { "id": 3, "tasks": ["2.2"] },
    { "id": 4, "tasks": ["2.3"] },
    { "id": 5, "tasks": ["3.1"] },
    { "id": 6, "tasks": ["3.2"] },
    { "id": 7, "tasks": ["3.3",  "3.4"] },
    { "id": 8, "tasks": ["3.5"] },
    { "id": 9, "tasks": ["4.1",  "4.2"] },
    { "id": 10, "tasks": ["4.3"] },
    { "id": 11, "tasks": ["4.4"] },
    { "id": 12, "tasks": ["5.1"] },
    { "id": 13, "tasks": ["5.2"] },
    { "id": 14, "tasks": ["5.3",  "5.4"] },
    { "id": 15, "tasks": ["5.5"] },
    { "id": 16, "tasks": ["7.1"] },
    { "id": 17, "tasks": ["7.2",  "7.6"] },
    { "id": 18, "tasks": ["7.3"] },
    { "id": 19, "tasks": ["7.4"] },
    { "id": 20, "tasks": ["7.5"] },
    { "id": 21, "tasks": ["7.7"] },
    { "id": 22, "tasks": ["8.1"] },
    { "id": 23, "tasks": ["8.2",  "8.4"] },
    { "id": 24, "tasks": ["8.3"] },
    { "id": 25, "tasks": ["8.5"] },
    { "id": 26, "tasks": ["10.1"] },
    { "id": 27, "tasks": ["10.2",  "10.7"] },
    { "id": 28, "tasks": ["10.3"] },
    { "id": 29, "tasks": ["10.4"] },
    { "id": 30, "tasks": ["10.5"] },
    { "id": 31, "tasks": ["10.6"] },
    { "id": 32, "tasks": ["10.8"] },
    { "id": 33, "tasks": ["11.1"] },
    { "id": 34, "tasks": ["11.2"] },
    { "id": 35, "tasks": ["11.3",  "11.7"] },
    { "id": 36, "tasks": ["11.4"] },
    { "id": 37, "tasks": ["11.5"] },
    { "id": 38, "tasks": ["11.6"] },
    { "id": 39, "tasks": ["11.8"] },
    { "id": 40, "tasks": ["12.1"] },
    { "id": 41, "tasks": ["12.2",  "12.3",  "12.5"] },
    { "id": 42, "tasks": ["12.4"] },
    { "id": 43, "tasks": ["12.6"] }
  ]
}
```
