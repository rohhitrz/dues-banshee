# Requirements Document

## Introduction

The legal engine (`packages/engine`) is the pure TypeScript core of Dues Banshee. It turns an invoice's facts into the numbers the rest of the product relies on: the statutory due date (MSMED-15), statutory interest on late payment (MSMED-16), the 31 March "tax bomb" for the buyer (IT-43BH), the next step on the five-step escalation ladder (ending in the MSME ODR portal pack for odr.msme.gov.in, which replaced Samadhaan for new claims, MSMED-18 and MSMED-ODR), the coverage check for which suppliers the law protects (MSMED-SCOPE), and Indian-style rupee formatting.

The engine has no I/O and never reads the system clock. The caller injects `today` and the RBI bank rate. The bank rate lives in app config with an "as of" date and is never hard-coded in the engine. Money is integer paise. Dates are IST calendar dates. The financial year runs 1 April to 31 March.

This spec also covers the first-time monorepo setup the engine needs (pnpm workspace, TypeScript strict, Vitest, fast-check). The `packages/agent` and `packages/voice` packages consume the engine later and are out of scope here.

Out of scope for this spec: partial payments (an invoice is either unpaid or fully paid on one date), interest on interest disputes, MSE Facilitation Council procedure, legal wording of notices, persistence, the UI, and bank-rate changes during the accrual period (each calculation uses one Bank_Rate, which the caller supplies with its `asOf` date).

## Glossary

- **Engine**: The `packages/engine` TypeScript package. Pure functions only.
- **Workspace**: The pnpm monorepo at the repository root, containing `apps/*` and `packages/*`.
- **Calendar_Date**: A date with no time or time zone, written as an ISO 8601 string `YYYY-MM-DD`, interpreted as a calendar day in IST (Asia/Kolkata, UTC+05:30).
- **Day_Difference(a, b)**: The number of calendar days from Calendar_Date `a` to Calendar_Date `b` (`b − a`). Day_Difference("2026-10-17", "2026-11-12") = 26.
- **Paise**: An integer count of paise (1 rupee = 100 paise). All money values in the Engine are non-negative safe integers in Paise.
- **Invoice**: The Engine's input record with these fields: `id`; `amountPaise` (Paise, outstanding principal, 1 to 1,00,000,00,00,000 paise i.e. up to ₹1,000 crore); `acceptedOn` (Calendar_Date of acceptance or deemed acceptance of the goods or services by the buyer); `agreedTermDays` (optional positive integer, the payment term agreed in writing); `supplierCategory` (`micro`, `small`, `medium` or `unregistered`, from the supplier's Udyam registration); `supplierActivity` (`manufacturing`, `services` or `trading`, from the supplier's Udyam registration); `udyamRegisteredOn` (optional Calendar_Date of the supplier's Udyam registration); `paidOn` (optional Calendar_Date on which the invoice was paid in full).
- **Covered_Invoice**: An Invoice whose `supplierCategory` is `micro` or `small` and whose `supplierActivity` is not `trading`. MSMED-15, MSMED-16, MSMED-18 and IT-43BH apply only to Covered_Invoices (MSMED-SCOPE). Traders are excluded because their Udyam benefits are limited to priority sector lending (MoMSME OM 2 Jul 2021), so MSMED s.15–16 and Income-tax s.43B(h) do not apply to them.
- **Non_Coverage_Reason**: The `reason` returned with `applicable` set to false for an Invoice that is not a Covered_Invoice: `medium_or_unregistered` when `supplierCategory` is `medium` or `unregistered`; `trader` when `supplierCategory` is `micro` or `small` and `supplierActivity` is `trading`. When both conditions hold, `medium_or_unregistered` takes precedence.
- **Non_Coverage_Result**: The result an Engine function returns for an Invoice that is not a Covered_Invoice: `applicable` set to false, `reason` set to the Non_Coverage_Reason, and `ruleIds` equal to exactly `["MSMED-SCOPE"]`.
- **Registered_After_Supply_Caveat**: The flag `caveat: "registered_after_supply"` attached to results for a Covered_Invoice whose `udyamRegisteredOn` is after `acceptedOn`. The Invoice stays covered, but the law on registration after the contract is unsettled (Silpi 2021 and Mahakali 2023 versus the NBCC 2025 referral), so the agent must flag the point instead of relying on it silently. Every result that carries this caveat also lists `MSMED-SCOPE` in its `ruleIds`, in addition to its other Rule_IDs.
- **Unpaid**: An Invoice is Unpaid on `today` when the Invoice has no `paidOn`, or its `paidOn` is later than `today`.
- **Due_Date**: The statutory last date for payment under MSMED-15, computed by `dueDate`.
- **Bank_Rate**: The caller-supplied RBI bank rate: `annualBps` (integer basis points, e.g. 575 for 5.75%) and `asOf` (Calendar_Date the rate was last verified).
- **Statutory_Rate**: Three times the Bank_Rate, per annum (MSMED-16). For a Bank_Rate of 575 bps, the Statutory_Rate is 17.25% p.a.
- **Monthly_Rate**: Statutory_Rate ÷ 12. For 17.25% p.a., the Monthly_Rate is 1.4375%.
- **Accrual_Days**: Day_Difference(Due_Date, accrual end), where the accrual end is the earlier of `today` and `paidOn`. Interest accrues from the day after the Due_Date, so the day after the Due_Date is Accrual_Day 1. Accrual_Days below zero are treated as zero.
- **Interest_Convention**: The MSMED-16 formula used by the Engine: `interest = amountPaise × ((1 + Monthly_Rate)^(Accrual_Days ÷ 30) − 1)`, rounded half-up to the nearest integer Paise. A month rest is 30 days. At whole-month rests (30, 60, 90 … days) this equals compounding with monthly rests. Between rests, the fractional exponent accrues the daily-equivalent compound rate. The formula is strictly increasing in Accrual_Days, which keeps interest monotonic as `today` moves forward.
- **Financial_Year**: The Indian financial year containing a Calendar_Date: 1 April of year Y to 31 March of year Y+1.
- **Tax_Bomb_Date**: 31 March of the Financial_Year that contains the Invoice's `acceptedOn` date (IT-43BH).
- **Deduction_Deadline**: The later of the Tax_Bomb_Date and the Due_Date. The buyer keeps the deduction for the Financial_Year containing `acceptedOn` only if the Invoice is paid on or before the Deduction_Deadline (IT-43BH). When the Due_Date falls after the Tax_Bomb_Date, the deduction for the purchase year is lost if payment comes after the Due_Date.
- **Days_Left**: Day_Difference(today, Deduction_Deadline). It excludes `today` and includes the Deduction_Deadline. For today = 2026-11-12 and Deduction_Deadline = 2027-03-31, Days_Left = 139.
- **Deduction_At_Risk**: The Invoice's `amountPaise` that the buyer cannot deduct in the Financial_Year containing `acceptedOn` if the Invoice is not paid on or before the Deduction_Deadline (IT-43BH).
- **Ladder_Step**: One of five ordered escalation steps, rank 1 to 5: `whatsapp_nudge` (1), `whatsapp_paylink` (2), `voice_call` (3), `legal_notice` (4), `odr_pack` (5). The `odr_pack` step is the claim pack for the MSME ODR portal (odr.msme.gov.in), which replaced Samadhaan for new delayed-payment claims.
- **Approval_Step**: A Ladder_Step that needs explicit owner approval before the agent acts on it: `voice_call`, `legal_notice` and `odr_pack`.
- **Escalation_History**: The caller-supplied list of past events for one Invoice: step events (`{ step: Ladder_Step, on: Calendar_Date }`) and promise events (`{ promisedDate: Calendar_Date, amountPaise: Paise, recordedOn: Calendar_Date }`).
- **Active_Promise**: A promise event in the Escalation_History whose `promisedDate` is later than `today`.
- **Step_Gap_Days**: The minimum number of days between two consecutive Ladder_Steps. A positive integer passed by the caller in a ladder config; default 7.
- **Escalation_Decision**: The result of `nextEscalationStep`: either `{ action: "advance", step, requiresApproval }` or `{ action: "wait", reason }`, where `reason` is one of `paid`, `medium_or_unregistered`, `trader`, `not_overdue`, `promise_active`, `cooldown`, `ladder_complete`. The `medium_or_unregistered` and `trader` reasons are the Non_Coverage_Reason values and are returned as a Non_Coverage_Result.
- **Full_Format**: Indian-grouped rupee text: `₹` then the rupee part grouped as last three digits, then pairs (₹4,12,000; ₹1,25,00,000), then `.` and exactly two paise digits only when the paise part is non-zero (₹4,12,000.50).
- **Short_Format**: Abbreviated rupee text: amounts of ₹1 crore or more as crore with suffix `Cr` (₹1.25Cr); amounts of ₹1 lakh or more and below ₹1 crore as lakh with suffix `L` (₹4.12L); amounts below ₹1 lakh in Full_Format rounded half-up to whole rupees. Crore and lakh values are rounded half-up to two decimals, with trailing zeros and a trailing decimal point removed (₹4L, ₹4.1L).
- **Rule_ID**: An identifier from `legal-rules.md`: `MSMED-15`, `MSMED-16`, `MSMED-18`, `IT-43BH`, `MSMED-SCOPE`, `MSMED-ODR`.
- **ruleIds**: The array field on an Engine result that lists the Rule_IDs supporting that result.
- **Validation_Error**: A typed error raised by the Engine that names the invalid field and the reason.

## Requirements

### Requirement 1: Workspace and engine package setup

**User Story:** As the developer, I want a pnpm monorepo with a strict TypeScript engine package and test tooling, so that the legal logic can be built and property-tested from the first task.

#### Acceptance Criteria

1. WHERE the repository has no `pnpm-workspace.yaml`, THE Workspace SHALL be created with a root `pnpm-workspace.yaml` listing `apps/*` and `packages/*`.
2. THE Workspace SHALL provide root scripts `test`, `typecheck` and `lint` that run the matching task in every package.
3. THE Engine SHALL be a package at `packages/engine` compiled with TypeScript `strict` mode enabled.
4. THE Engine SHALL use Vitest for unit tests and fast-check for property-based tests.
5. THE Engine SHALL declare zero runtime dependencies that perform I/O (file system, network, database, environment variables, or clock).
6. THE Engine SHALL obtain the current date only from a `today` Calendar_Date argument passed by the caller.
7. WHEN the root `test` script runs on a clean checkout after `pnpm install`, THE Workspace SHALL run the Engine's unit and property-based tests once and exit with code 0 when all tests pass.

### Requirement 2: Input validation

**User Story:** As a consumer of the Engine, I want bad inputs rejected with a clear error, so that wrong numbers never reach a buyer.

#### Acceptance Criteria

1. IF a Calendar_Date argument does not match `YYYY-MM-DD` or names a day that does not exist (for example 2026-02-30), THEN THE Engine SHALL raise a Validation_Error naming the field.
2. IF `amountPaise` is not an integer between 1 and 1,00,000,00,00,000 inclusive, THEN THE Engine SHALL raise a Validation_Error naming `amountPaise`.
3. IF `agreedTermDays` is present and is not a positive integer, THEN THE Engine SHALL raise a Validation_Error naming `agreedTermDays`.
4. IF `paidOn` is earlier than `acceptedOn`, THEN THE Engine SHALL raise a Validation_Error naming `paidOn`.
5. IF `Bank_Rate.annualBps` is not an integer between 0 and 5,000 inclusive, THEN THE Engine SHALL raise a Validation_Error naming `annualBps`.
6. IF `Step_Gap_Days` is not a positive integer, THEN THE Engine SHALL raise a Validation_Error naming `stepGapDays`.
7. IF `supplierActivity` is not one of `manufacturing`, `services` or `trading`, THEN THE Engine SHALL raise a Validation_Error naming `supplierActivity`.
8. IF `udyamRegisteredOn` is present and is not a valid Calendar_Date, THEN THE Engine SHALL raise a Validation_Error naming `udyamRegisteredOn`.

### Requirement 3: Statutory due date (MSMED-15)

**User Story:** As a supplier, I want each invoice's legal due date, so that I know when the buyer is late under MSMED-15.

#### Acceptance Criteria

1. WHEN `dueDate` is called for a Covered_Invoice with `agreedTermDays` of 45 or less, THE Engine SHALL return the Calendar_Date `agreedTermDays` days after `acceptedOn`.
2. WHEN `dueDate` is called for a Covered_Invoice with `agreedTermDays` greater than 45, THE Engine SHALL return the Calendar_Date 45 days after `acceptedOn`.
3. WHEN `dueDate` is called for a Covered_Invoice with no `agreedTermDays`, THE Engine SHALL return the Calendar_Date 15 days after `acceptedOn`.
4. WHEN `dueDate` is called for a Covered_Invoice, THE Engine SHALL return `ruleIds` containing `MSMED-15`.
5. WHEN `dueDate` is called for the Sharma Traders Invoice (`acceptedOn` 2026-09-02, `agreedTermDays` 45, `supplierCategory` `micro`, `supplierActivity` `manufacturing`), THE Engine SHALL return 2026-10-17.
6. FOR ALL valid Covered_Invoices, THE Engine SHALL return a Due_Date whose Day_Difference from `acceptedOn` is between 1 and 45 inclusive (property-based test).
7. FOR ALL valid Covered_Invoices with no `agreedTermDays`, THE Engine SHALL return a Due_Date exactly 15 days after `acceptedOn` (property-based test).
8. IF `dueDate` is called for an Invoice that is not a Covered_Invoice, THEN THE Engine SHALL return a Non_Coverage_Result with no Due_Date.

### Requirement 4: Statutory interest (MSMED-16)

**User Story:** As a supplier, I want the statutory interest the buyer owes, so that I can show the cost of paying late under MSMED-16.

#### Acceptance Criteria

1. WHEN `statutoryInterest` is called for a Covered_Invoice, THE Engine SHALL compute interest in Paise using the Interest_Convention with Monthly_Rate = (3 × `Bank_Rate.annualBps`) ÷ 10,000 ÷ 12.
2. WHEN `statutoryInterest` is called for a Covered_Invoice, THE Engine SHALL return: `interestPaise`, `accrualDays`, `statutoryRateBps` (3 × `annualBps`), `rateAsOf` (the Bank_Rate `asOf` date) and `ruleIds` containing `MSMED-16`.
3. WHILE `today` is on or before the Due_Date, THE Engine SHALL return `interestPaise` of 0 from `statutoryInterest`.
4. WHEN `statutoryInterest` is called with `today` equal to the day after the Due_Date, THE Engine SHALL compute interest for 1 Accrual_Day.
5. WHERE the Invoice has a `paidOn` date, THE Engine SHALL end interest accrual at the earlier of `paidOn` and `today`.
6. IF `statutoryInterest` is called for an Invoice that is not a Covered_Invoice, THEN THE Engine SHALL return a Non_Coverage_Result with `interestPaise` of 0.
7. WHEN `statutoryInterest` is called for the Sharma Traders Invoice (`amountPaise` 4,12,00,000, `acceptedOn` 2026-09-02, `agreedTermDays` 45, `supplierCategory` `micro`, `supplierActivity` `manufacturing`) with `today` 2026-11-12 and `annualBps` 575, THE Engine SHALL return `accrualDays === 26` and `interestPaise === 512794` (₹5,127.94).
8. FOR ALL valid Covered_Invoices, Bank_Rates and `today` values, THE Engine SHALL return an `interestPaise` that is a non-negative integer (property-based test).
9. FOR ALL valid Covered_Invoices and Bank_Rates, and any two dates `today1` earlier than `today2`, THE Engine SHALL return `interestPaise` at `today2` greater than or equal to `interestPaise` at `today1` (property-based test).
10. FOR ALL valid Covered_Invoices, Bank_Rates and `today` values on or before the Due_Date, THE Engine SHALL return `interestPaise` of 0 (property-based test).
11. FOR ALL valid Covered_Invoices and `today` values, with Accrual_Days equal to a whole multiple `m` of 30, THE Engine SHALL return `interestPaise` equal to `amountPaise × ((1 + Monthly_Rate)^m − 1)` rounded half-up to integer Paise (property-based test of monthly rests).

### Requirement 5: Tax bomb (IT-43BH)

**User Story:** As a supplier, I want to tell the buyer how much deduction they lose if they don't pay by 31 March, so that every reminder leads with the buyer's own interest.

#### Acceptance Criteria

1. WHEN `taxBomb` is called for a Covered_Invoice, THE Engine SHALL return the Tax_Bomb_Date as 31 March of the Financial_Year containing `acceptedOn`, and the Deduction_Deadline.
2. WHEN `taxBomb` is called for a Covered_Invoice that is Unpaid on `today`, and `today` is on or before the Deduction_Deadline, THE Engine SHALL return status `armed`, Days_Left, and Deduction_At_Risk equal to `amountPaise`.
3. WHEN `taxBomb` is called for a Covered_Invoice that is Unpaid on `today`, and `today` is after the Deduction_Deadline, THE Engine SHALL return status `exploded`, Days_Left of 0, and Deduction_At_Risk equal to `amountPaise`.
4. WHEN `taxBomb` is called for a Covered_Invoice whose `paidOn` is on or before both the Deduction_Deadline and `today`, THE Engine SHALL return status `defused` and Deduction_At_Risk of 0.
5. WHEN `taxBomb` is called for a Covered_Invoice that is Unpaid on `today`, whose Due_Date is after the Tax_Bomb_Date, and `today` is on or before the Due_Date, THE Engine SHALL return status `armed`, Days_Left equal to Day_Difference(today, Due_Date), and Deduction_At_Risk equal to `amountPaise`, because the deduction for the Financial_Year containing `acceptedOn` is lost if the Invoice is paid after the Due_Date.
6. IF `taxBomb` is called for an Invoice that is not a Covered_Invoice, THEN THE Engine SHALL return a Non_Coverage_Result with status `not_applicable` and Deduction_At_Risk of 0.
7. WHEN `taxBomb` returns status `armed`, `exploded` or `defused`, THE Engine SHALL return `ruleIds` containing `IT-43BH`.
8. WHEN `taxBomb` is called for the Sharma Traders Invoice with `today` 2026-11-12, THE Engine SHALL return Tax_Bomb_Date 2027-03-31, Deduction_Deadline 2027-03-31, status `armed`, Days_Left 139 and Deduction_At_Risk 4,12,00,000 Paise.
9. FOR ALL valid Covered_Invoices, THE Engine SHALL return a Tax_Bomb_Date that is 31 March, falls 0 to 365 days after `acceptedOn` (365 in a leap year, e.g. 2027-04-01 to 2028-03-31), and lies in the same Financial_Year as `acceptedOn` (property-based test).
10. FOR ALL valid Covered_Invoices with status `armed` and `today` on or after `acceptedOn`, THE Engine SHALL return Days_Left equal to Day_Difference(today, Deduction_Deadline) and between 0 and 365 inclusive, since the Deduction_Deadline is at most the later of `acceptedOn` + 365 days (Tax_Bomb_Date) and `acceptedOn` + 45 days (Due_Date) (property-based test).
11. WHEN `taxBomb` is called for a Covered_Invoice whose `paidOn` is after the Deduction_Deadline and on or before `today`, THE Engine SHALL return status `exploded`, Days_Left of 0, and Deduction_At_Risk equal to `amountPaise`, because late payment does not restore the deduction for the Financial_Year containing `acceptedOn`.

### Requirement 6: Escalation ladder decision

**User Story:** As a supplier, I want the engine to tell me the next escalation step for each invoice, so that chasing is consistent, never skips ahead, and pauses when the buyer promises to pay.

#### Acceptance Criteria

1. WHEN `nextEscalationStep` is called for an Invoice that is not Unpaid on `today`, THE Engine SHALL return an Escalation_Decision of `wait` with reason `paid`.
2. WHEN `nextEscalationStep` is called for an Invoice that is not a Covered_Invoice, THE Engine SHALL return an Escalation_Decision of `wait` as a Non_Coverage_Result.
3. WHILE `today` is on or before the Due_Date, THE Engine SHALL return an Escalation_Decision of `wait` with reason `not_overdue`.
4. WHILE the Escalation_History contains an Active_Promise, THE Engine SHALL return an Escalation_Decision of `wait` with reason `promise_active`.
5. WHEN `nextEscalationStep` is called for a Covered_Invoice that is Unpaid on `today`, with `today` after the Due_Date, no step events and no Active_Promise, THE Engine SHALL return `advance` with step `whatsapp_nudge`.
6. WHEN `nextEscalationStep` is called for a Covered_Invoice that is Unpaid on `today`, with `today` after the Due_Date and no Active_Promise, and at least Step_Gap_Days have passed since the latest step event, THE Engine SHALL return `advance` with the Ladder_Step whose rank is one higher than the highest rank in the Escalation_History.
7. WHILE fewer than Step_Gap_Days have passed since the latest step event, THE Engine SHALL return an Escalation_Decision of `wait` with reason `cooldown`.
8. WHEN the highest rank in the Escalation_History is 5 (`odr_pack`), THE Engine SHALL return an Escalation_Decision of `wait` with reason `ladder_complete`.
9. WHEN an Active_Promise's `promisedDate` passes while the Invoice is Unpaid on `today`, THE Engine SHALL resume the ladder from the highest rank in the Escalation_History, subject to Step_Gap_Days.
10. THE Engine SHALL set `requiresApproval` to true on every `advance` decision whose step is an Approval_Step, and to false otherwise.
11. WHEN `nextEscalationStep` returns an `advance` decision with step `odr_pack`, THE Engine SHALL return `ruleIds` containing both `MSMED-18` and `MSMED-ODR`.
12. FOR ALL valid Invoices, Escalation_Histories and `today` values, THE Engine SHALL return an `advance` step whose rank is exactly one higher than the highest rank in the Escalation_History, or rank 1 when the history has no step events (property-based test: the ladder never goes backwards and never skips).
13. FOR ALL valid Invoices, Escalation_Histories containing an Active_Promise, and `today` values, THE Engine SHALL return an Escalation_Decision of `wait` (property-based test: the ladder never advances while a promise is active).
14. FOR ALL valid inputs, WHEN each `advance` result is appended to the Escalation_History on its `today` and `today` steps forward one day at a time, THE Engine SHALL produce a sequence of step ranks that is non-decreasing and ends at no more than 5 (property-based test).
15. WHEN more than one `wait` reason applies to a `nextEscalationStep` call, THE Engine SHALL return the first applicable reason in this order: `paid`, then `medium_or_unregistered` or `trader`, then `not_overdue`, then `promise_active`, then `ladder_complete`, then `cooldown`.

### Requirement 7: Indian rupee formatting and parsing

**User Story:** As a supplier reading the app or a WhatsApp message, I want amounts shown the Indian way (₹4,12,000 or ₹4.12L), so that numbers read naturally.

#### Acceptance Criteria

1. WHEN `formatINR` is called with a Paise value and style `full`, THE Engine SHALL return the Full_Format text.
2. WHEN `formatINR` is called with a Paise value and style `short`, THE Engine SHALL return the Short_Format text.
3. WHEN `formatINR` is called with 4,12,00,000 Paise, THE Engine SHALL return `₹4,12,000` in style `full` and `₹4.12L` in style `short`.
4. WHEN `formatINR` is called with 0 Paise in style `full`, THE Engine SHALL return `₹0`.
5. IF `formatINR` is called with a value that is not a non-negative safe integer, THEN THE Engine SHALL raise a Validation_Error.
6. WHEN `parseINR` is called with text in Full_Format, THE Engine SHALL return the amount in Paise.
7. IF `parseINR` is called with text that is not in Full_Format, THEN THE Engine SHALL raise a Validation_Error that quotes the input.
8. THE Engine SHALL provide `formatINR` as the single rupee formatter for the Workspace.
9. FOR ALL non-negative safe-integer Paise values `x`, THE Engine SHALL return `parseINR(formatINR(x, "full")) === x` (property-based round-trip test).
10. FOR ALL Full_Format strings `s` produced by `formatINR`, THE Engine SHALL return `formatINR(parseINR(s), "full") === s` (property-based round-trip test).

### Requirement 8: Rule citation and coverage in results

**User Story:** As the agent that writes buyer messages, I want each engine result to carry the rule it relies on and say why a rule does not apply, so that every legal claim can cite a Rule_ID and claims without one are blocked.

#### Acceptance Criteria

1. THE Engine SHALL export a `RuleId` type whose values are exactly `MSMED-15`, `MSMED-16`, `MSMED-18`, `IT-43BH`, `MSMED-SCOPE` and `MSMED-ODR`.
2. WHEN an Engine function returns a legal consequence, THE Engine SHALL list the Rule_ID that supports the consequence in the same result's `ruleIds`.
3. WHERE an Invoice is not a Covered_Invoice, THE Engine SHALL return a Non_Coverage_Result from `dueDate`, `statutoryInterest`, `taxBomb` and `nextEscalationStep`, citing only `MSMED-SCOPE` and none of `MSMED-15`, `MSMED-16`, `MSMED-18`, `IT-43BH` or `MSMED-ODR`.
4. WHEN an Engine function receives an Invoice that is not a Covered_Invoice, THE Engine SHALL set `reason` to `medium_or_unregistered` if `supplierCategory` is `medium` or `unregistered` (checked first, including for traders), and otherwise to `trader` if `supplierActivity` is `trading`.
5. IF a Covered_Invoice has a `udyamRegisteredOn` later than `acceptedOn`, THEN THE Engine SHALL keep the Invoice covered and attach the Registered_After_Supply_Caveat to every result for that Invoice from `dueDate`, `statutoryInterest`, `taxBomb` and `nextEscalationStep`.
6. WHEN an Engine result carries the Registered_After_Supply_Caveat, THE Engine SHALL list `MSMED-SCOPE` in that result's `ruleIds` in addition to the result's other Rule_IDs.
7. FOR ALL valid Invoices with `supplierActivity` `trading`, Bank_Rates, Escalation_Histories and `today` values, THE Engine SHALL return from `dueDate` a Non_Coverage_Result with no Due_Date, from `statutoryInterest` an `interestPaise` of 0 with `applicable` false, from `taxBomb` a status of `not_applicable`, and from `nextEscalationStep` no `advance` decision with step `odr_pack` (property-based test).

### Requirement 9: Delivery constraints for the tasks phase

**User Story:** As the developer, I want each finished task committed on its own following the git-workflow steering file, so that history is clean and reviewable.

#### Acceptance Criteria

1. WHEN a task in `tasks.md` is finished and the Engine's tests and typecheck pass, THE developer SHALL create exactly one commit for that task.
2. THE developer SHALL write each commit message in Conventional Commits form `<type>(engine): <subject>` with a subject of at most 72 characters in imperative mood, and a body line `Spec: legal-engine, task <n>`.
3. THE developer SHALL use the existing git identity and add no `Co-Authored-By` or AI attribution trailers.
4. WHEN staging files, THE developer SHALL add files by explicit path and check `git diff --staged` for `.env` files, keys and tokens before committing.
5. THE developer SHALL keep `.kiro/` and its sub-folders tracked in git.
