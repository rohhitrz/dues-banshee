# Requirements Document

## Introduction

The "Graveyard of Dues" is the home screen of `apps/web`. A signed-in micro/small supplier sees every invoice they are owed as a tombstone, with the legal leverage (MSMED-15 due date, MSMED-16 statutory interest, IT-43BH 31 March tax bomb) computed by `packages/engine`. It is the main demo screen.

The spec is lean. `apps/web` adds no legal maths: every due date, interest figure, tax-bomb status, caveat and next ladder step comes from the existing Engine API (`dueDate`, `statutoryInterest`, `taxBomb`, `nextEscalationStep`, `formatINR`), and data comes from `packages/db` (`getSupplier`, `getBankRate`, `toEngineInvoice`, the seed in `DEMO_INVOICES`). The view model is built by one pure, tested function, `buildGraveyard`.

Tests are mandatory in this spec. No test task may be marked optional.

Out of scope: the debtor séance screen (debtor-ui), ladder actions and approvals (escalation-ladder), WhatsApp, voice, payments, the 3D landing page (landing-3d), multi-supplier switching and invoice editing.

## Glossary

- **Graveyard_Page**: the server-rendered page at `/` that shows the Graveyard.
- **App_Shell**: the shared themed layout of `apps/web` (header nav and footer) used by the Graveyard_Page, `/import` and `/signin`.
- **Graveyard_Builder**: the pure function `buildGraveyard(supplier, invoices, bankRate, today)` in `apps/web` that returns the Graveyard_View. It performs no I/O and does not read the clock.
- **Graveyard_View**: the view model returned by the Graveyard_Builder: the ordered Tombstone_View list, the Totals and Rules_As_Of.
- **Rules_As_Of**: the Bank_Rate `asOf` date carried in the Graveyard_View, or none when no Bank_Rate is effective on or before Today.
- **Invoice_Record**: one stored invoice of the Session_Supplier as passed to the Graveyard_Builder: the Engine `Invoice` built by `toEngineInvoice`, plus buyer name, invoice number and the invoice's escalation history (steps and promises). Payment is the invoice's `paidOn` date; the schema has no separate payments table.
- **Engine**: the pure package `packages/engine`.
- **Session_Supplier**: the supplier whose id is in the Auth.js session (`session.supplierId`).
- **Bank_Rate**: the RBI bank rate returned by `getBankRate(db, today)`, with its `asOf` date.
- **Today**: the IST calendar date (`YYYY-MM-DD`) the Graveyard is computed for, produced by the Today_Resolver.
- **Today_Resolver**: the pure function that turns the current instant and the optional `today` query value into Today.
- **Demo_Override**: a `today` query value that the Today_Resolver accepts: a strict `YYYY-MM-DD` date that exists in the calendar and lies between 2024-01-01 and 2027-12-31 inclusive.
- **Demo_Date_Chip**: the visible label "Demo date: <D MMM YYYY>" (for example "Demo date: 10 Mar 2027").
- **Time_Travel_Control**: the control with the presets "Today", "10 Mar 2027 (tax-bomb week)" and "1 Apr 2027 (after 31 March)".
- **Tombstone**: the rendered element for one Invoice_Record.
- **Tombstone_View**: the Graveyard_View entry for one Invoice_Record.
- **Tombstone_State**: one of `resurrected` (paid on or before Today), `not_covered` (Engine reports MSMED-SCOPE non-coverage), `not_due` (Today is on or before the Engine due date), `exploded` (Engine tax-bomb status `exploded`), `armed` (Engine tax-bomb status `armed`), `overdue` (overdue with no tax-bomb status from the Engine), chosen in that order of precedence.
- **Days_Overdue**: the number of days from the Engine due date to Today when Today is after the due date and the invoice is unpaid on Today; otherwise 0. This equals the Engine `accrualDays`.
- **Next_Step_Label**: a read-only text derived from the Engine `nextEscalationStep` decision: "Next: <step text>" for an `advance`, where <step text> is the Step_Text of the decision's `LadderStep`, or "Waiting: <reason text>" for a `wait`, where <reason text> is the Wait_Text of the decision's `WaitReason`.
- **Step_Text**: the human text for one Engine `LadderStep` (`packages/engine/src/types.ts`), defined in Requirement 5 criterion 7.
- **Wait_Text**: the human text for one Engine `WaitReason` (`CoveredWaitReason | NonCoverageReason`, `packages/engine/src/types.ts`), defined in Requirement 5 criterion 8.
- **Totals**: Outstanding, Interest_Accrued, Deductions_At_Risk, Exploded_Count and Paid_Count, all computed from Engine outputs in the Graveyard_View.
- **Not_Found_Page**: the themed page Next.js shows for an unknown route.
- **Error_Page**: the themed page shown when loading the Graveyard fails.

## Requirements

### Requirement 1: Routing

**User Story:** As a supplier, I want `/` to open my graveyard, so that the first screen after sign-in is my dues.

#### Acceptance Criteria

1. IF a request reaches `/` and the session has no `supplierId`, THEN THE Graveyard_Page SHALL redirect to `/signin` and render no Graveyard data.
2. WHEN a request with a session `supplierId` reaches `/`, THE Graveyard_Page SHALL render the Graveyard for the Session_Supplier.
3. IF `session.supplierId` matches no stored supplier (for example after the nightly demo reset recreates the supplier with a new id), THEN THE Graveyard_Page SHALL end the Auth.js session, redirect to `/signin?error=SessionExpired` and render no Graveyard data, and THE `/signin` page SHALL show "The demo was reset. Enter the graveyard again."
4. WHILE a session exists whose `supplierId` matches no stored supplier, THE `/signin` page SHALL render in place without redirecting away, so that no redirect loop can occur.
5. WHEN a request reaches a path that no route serves, THE Not_Found_Page SHALL render inside the App_Shell with a link to `/`.
6. THE `proxy.ts` module SHALL import only `next-auth`, `next/server` and `auth.config.ts`, and SHALL NOT import `auth.ts`, `packages/db` or any module that imports either of them.
7. WHEN `signInDemo` succeeds, THE `signInDemo` server action SHALL redirect to `/` (the Graveyard_Page) instead of `/import`, and SHALL keep its error redirects to `/signin?error=<flag>` and its messages unchanged.

### Requirement 2: Loading data for the Session_Supplier

**User Story:** As a supplier, I want to see only my own invoices, so that no other supplier's data reaches my screen.

#### Acceptance Criteria

1. THE Graveyard_Page SHALL take the supplier id only from `session.supplierId`, and SHALL ignore any supplier id given in the URL path, query string or request body.
2. WHEN the Graveyard_Page renders, THE Graveyard_Page SHALL load the Session_Supplier with `getSupplier`, the Bank_Rate with `getBankRate` for Today, and every Invoice_Record of the Session_Supplier with its buyer name, invoice number and escalation history.
3. THE `packages/db` package SHALL provide one read-only function that returns every Invoice_Record for a given supplier id, with buyer names and escalation history, and that returns no invoice, buyer or escalation row of any other supplier. THE Graveyard_Page SHALL load Invoice_Records only through this function, and SHALL add it to `packages/db` if no such function exists.
4. WHEN the data is loaded, THE Graveyard_Page SHALL pass the data to the Graveyard_Builder and SHALL render no due date, money figure, state or count that is not taken from the returned Graveyard_View.
5. IF `getBankRate` finds no Bank_Rate effective on or before Today, THEN THE Graveyard_Page SHALL still render the Graveyard instead of the Error_Page, SHALL show "Bank rate not configured for <Today>" in place of every Tombstone interest figure and in place of Interest_Accrued, and SHALL show every other Graveyard_View figure unchanged.

### Requirement 3: Pure view-model builder

**User Story:** As a developer, I want the graveyard maths in one pure function, so that the demo numbers are tested exactly.

#### Acceptance Criteria

1. THE Graveyard_Builder SHALL take the supplier, the Invoice_Records, the Bank_Rate (or none) and Today as its only inputs, and return the Graveyard_View without performing I/O or reading the clock.
2. THE Graveyard_Builder SHALL take each due date, interest figure, Days_Overdue, tax-bomb status, days left, deduction at risk, caveat and next ladder step only from the outputs of the Engine functions `dueDate`, `statutoryInterest`, `taxBomb` and `nextEscalationStep`.
3. THE Graveyard_Builder SHALL format every money value only with the Engine `formatINR`.
4. THE Graveyard_Builder SHALL hold every money value in the Graveyard_View as integer paise.
5. THE `apps/web` source SHALL apply no float division, `toFixed`, `parseFloat` or `Number(...)` conversion to any money value.
6. THE Graveyard_Builder SHALL return deeply equal Graveyard_Views when called twice with equal arguments, and SHALL leave its input arguments unmodified.
7. IF an Invoice_Record's `acceptedOn` is after Today, THEN THE Graveyard_Builder SHALL exclude that Invoice_Record from the Tombstone_View list and from every Totals figure; an Invoice_Record with `acceptedOn` equal to Today SHALL be included.
8. WHEN a Bank_Rate is given, THE Graveyard_Builder SHALL set Rules_As_Of to the Bank_Rate `asOf` date, and THE Graveyard_Page SHALL show "Rules as of <D MMM YYYY>" (for example "Rules as of 7 Oct 2026").
9. IF no Bank_Rate is given, THEN THE Graveyard_Builder SHALL set Rules_As_Of to none, and THE Graveyard_Page SHALL show "Bank rate not configured for <Today>" in place of the "Rules as of" line.

### Requirement 4: Resolving Today

**User Story:** As a demo presenter, I want the graveyard computed for the Indian date and optionally for a chosen demo date, so that judges can see the 31 March tax bomb on any day.

#### Acceptance Criteria

1. WHEN no `today` query value is given, THE Today_Resolver SHALL return the calendar date of the current instant in Asia/Kolkata (UTC+05:30) as `YYYY-MM-DD`.
2. WHEN no `today` query value is given, THE Today_Resolver SHALL return `2026-11-12` for the instant 2026-11-12T18:29:59Z and `2026-11-13` for the instants 2026-11-12T18:30:00Z and 2026-11-12T19:00:00Z.
3. WHEN the `today` query value is a Demo_Override, THE Today_Resolver SHALL return that date unchanged.
4. IF the `today` query value is empty, not in strict `YYYY-MM-DD` form (for example `2026-2-3`, `13/11/2026` or a value with surrounding spaces), not a real calendar date (for example `2026-02-30`), or outside 2024-01-01 to 2027-12-31, THEN THE Today_Resolver SHALL return the Asia/Kolkata date of the current instant and treat the request as having no Demo_Override.
5. IF the `today` query value is repeated, THEN THE Today_Resolver SHALL evaluate only the first value under criteria 3 and 4 and ignore the rest.
6. THE Graveyard_Page SHALL read the current instant and call the Today_Resolver on the server only, so no client code decides Today.
7. WHILE a Demo_Override is active, THE Graveyard_Page SHALL show the Demo_Date_Chip with the Demo_Override date (for example "Demo date: 10 Mar 2027" for `2027-03-10`).
8. WHILE no Demo_Override is active, THE Graveyard_Page SHALL hide the Demo_Date_Chip.
9. THE Graveyard_Page SHALL show the Time_Travel_Control as three links to `/`: "10 Mar 2027 (tax-bomb week)" setting `?today=2027-03-10`, "1 Apr 2027 (after 31 March)" setting `?today=2027-04-01`, and "Today" with no `today` query value. The preset that matches the current Today_Resolver result SHALL be marked as the current one with `aria-current`.

### Requirement 5: Tombstones

**User Story:** As a supplier, I want each unpaid invoice shown as a tombstone with its legal state, so that I know which buyer to chase first.

#### Acceptance Criteria

1. THE Graveyard_Page SHALL render exactly one Tombstone per Tombstone_View, in Graveyard_View order.
2. THE Tombstone SHALL show the buyer name, invoice number, principal formatted with `formatINR`, the Engine due date and the Engine statutory interest formatted with `formatINR`. WHILE the Tombstone_State is `overdue`, `armed` or `exploded`, THE Tombstone SHALL also show "Overdue N days", where N is Days_Overdue. WHILE the Tombstone_State is `not_due`, `resurrected` or `not_covered`, THE Tombstone SHALL NOT show Days_Overdue as text, because "Overdue 0 days" adds nothing. Days_Overdue is always in the aria-label (Requirement 10 criterion 3).
3. THE Tombstone SHALL show the Tombstone_State as exactly one of these texts: "Not due yet" (`not_due`), "Overdue, interest accruing" (`overdue`), "Tax bomb armed: N days left to 31 March" (`armed`, where N is the Engine `daysLeft`), "Tax bomb exploded" (`exploded`), "Resurrected (paid)" (`resurrected`) or "Outside MSMED (<reason>)" (`not_covered`, where <reason> is the Engine non-coverage reason).
4. WHILE the Tombstone_State is `armed` or `exploded`, THE Tombstone SHALL show the text of criterion 2 as "Overdue N days, interest accruing", where N is Days_Overdue.
5. IF the Engine reports the caveat `registered_after_supply` for the Invoice_Record, THEN THE Tombstone SHALL show the badge "Registered on Udyam after supply: claim may be contested".
6. THE Tombstone SHALL show the Next_Step_Label and SHALL contain no button or control that triggers an escalation step.
7. THE Graveyard_Builder SHALL map every Engine `LadderStep` to its Step_Text as follows: `whatsapp_nudge` → "WhatsApp nudge", `whatsapp_paylink` → "WhatsApp + UPI link", `voice_call` → "Voice call", `legal_notice` → "Legal notice", `odr_pack` → "MSME ODR pack".
8. THE Graveyard_Builder SHALL map every Engine `WaitReason` to its Wait_Text as follows: `paid` → "Paid", `not_overdue` → "Not due yet", `promise_active` → "Promise to pay active", `cooldown` → "Gap since last step", `ladder_complete` → "All steps done", `medium_or_unregistered` → "Not a Udyam micro/small supplier", `trader` → "Trader, outside MSMED".
9. THE Step_Text map SHALL be typed as `Record<LadderStep, string>` and THE Wait_Text map as `Record<WaitReason, string>` (using `satisfies`), so that adding an Engine `LadderStep` or `WaitReason` without a text fails the `apps/web` typecheck.
10. THE Tombstone SHALL show the Engine rule ID beside each legal figure it shows: `MSMED-15` beside the due date, `MSMED-16` beside the statutory interest, `IT-43BH` beside the `armed` or `exploded` state text, and `MSMED-SCOPE` beside the `not_covered` state text. A legal figure that has no Engine rule ID SHALL NOT be shown.
11. THE Tombstone SHALL encode data in its look. Of two Tombstones, the one with the larger principal SHALL NOT be shorter. Moss SHALL be absent when Days_Overdue is 0 and SHALL NOT decrease as Days_Overdue increases. Cracks SHALL show if and only if Days_Overdue is above 60. An ember dot SHALL show if and only if Days_Overdue is above 45.
12. IF the Invoice_Record is unpaid on Today and its escalation history holds a promise to pay with a promised date on or after Today, THEN THE Tombstone SHALL show a rising wisp. Otherwise THE Tombstone SHALL show no wisp.

### Requirement 6: Sort order

**User Story:** As a supplier, I want the most urgent tombstone first, so that I act on the closest deadline.

#### Acceptance Criteria

1. THE Graveyard_Builder SHALL order Tombstone_Views in five groups by Tombstone_State, in this order: `armed`; `exploded` and `overdue` as one group; `not_due`; `not_covered`; `resurrected`.
2. THE Graveyard_Builder SHALL order the `armed` group by Engine `daysLeft`, fewest first.
3. THE Graveyard_Builder SHALL order the `exploded` and `overdue` group by Days_Overdue, most first, with no ranking between `exploded` and `overdue`.
4. THE Graveyard_Builder SHALL order the `not_due` group by Engine due date, earliest first.
5. WHEN two Tombstone_Views in the same group tie under criteria 2 to 4, or sit in the `not_covered` or `resurrected` group, THE Graveyard_Builder SHALL order them by Days_Overdue (most first), then by invoice number, then by Invoice_Record id. Invoice numbers and ids SHALL be compared ascending by character code, not by locale.
6. FOR ALL orderings of the same Invoice_Records passed in, THE Graveyard_Builder SHALL return the Tombstone_Views in the same order.

### Requirement 7: Totals bar

**User Story:** As a supplier, I want the totals of what I'm owed and what the buyers risk, so that I see the size of the problem at a glance.

#### Acceptance Criteria

1. THE Totals SHALL include Outstanding: the sum of principal in paise of every Tombstone_View whose Tombstone_State is not `resurrected`.
2. THE Totals SHALL include Interest_Accrued: the sum of Engine `statutoryInterest` `interestPaise` for Today and the Bank_Rate, over Tombstone_Views whose Tombstone_State is `overdue`, `armed` or `exploded`. IF no Bank_Rate is effective on or before Today, THEN Interest_Accrued SHALL be shown as Requirement 2.5 states, and the other Totals SHALL still be computed.
3. THE Totals SHALL include Deductions_At_Risk: the sum of Engine `taxBomb` `deductionAtRiskPaise` over Tombstone_Views that are unpaid on Today and whose Engine tax-bomb status is `armed`, including Tombstone_State `not_due` (an invoice not yet due still loses the s.43B(h) deduction if unpaid on 31 March).
4. THE Totals SHALL include Exploded_Count, the number of Tombstone_Views whose Tombstone_State is `exploded`, and Paid_Count, the number of Tombstone_Views whose Tombstone_State is `resurrected`.
5. THE Graveyard_Page SHALL show each money total as the Engine `formatINR` output of its integer-paise value, including `formatINR(0)` when no Tombstone_View counts toward that total.

### Requirement 8: Empty state

**User Story:** As a new supplier, I want to be told how to add invoices, so that an empty graveyard isn't a dead end.

#### Acceptance Criteria

1. WHEN the Graveyard_View has no Tombstone_View (the Session_Supplier has no Invoice_Records, or every Invoice_Record has `acceptedOn` after Today), THE Graveyard_Page SHALL render no Tombstone, show the text "The graveyard is quiet", and show a link to `/import`.
2. WHEN the Graveyard_View has no Tombstone_View, THE Graveyard_Page SHALL show each money total in the Totals as `formatINR(0)`, Exploded_Count and Paid_Count as 0, and keep the Time_Travel_Control and, while a Demo_Override is active, the Demo_Date_Chip.

### Requirement 9: Shell and restyled pages

**User Story:** As a judge, I want every screen in one theme, so that the product feels finished.

#### Acceptance Criteria

1. WHILE a session `supplierId` exists, THE App_Shell SHALL show header navigation with the links "Graveyard" (`/`) and "Import" (`/import`) and a "Sign out" control.
2. WHILE no session `supplierId` exists, THE App_Shell SHALL hide the "Graveyard" and "Import" links and the "Sign out" control.
3. WHEN the user activates "Sign out", THE App_Shell SHALL end the Auth.js session and redirect to `/signin`.
4. THE App_Shell SHALL show the footer line "Reminders a supplier sends to its own buyers. Not legal advice." on every page it wraps, including `/signin`.
5. THE `/signin` page SHALL render inside the App_Shell with the colours and typefaces of `ui-theme.md`, and keep the one-click "Enter the graveyard (demo)" button.
6. THE `/import` page SHALL render inside the App_Shell with the colours and typefaces of `ui-theme.md`.
7. THE restyle of `/signin` and `/import` SHALL change only styling and markup wrappers, and SHALL keep each page's form fields, button labels, server actions, API routes, redirect targets and messages unchanged. This criterion applies to the restyle only: the `signInDemo` success redirect target `/` (Requirement 1 criterion 7) and the SessionExpired message (Requirement 1 criterion 3) are exempt from it.
8. THE existing tests in `apps/web/test` SHALL pass after the restyle with one exception of exactly two lines of `apps/web/test/signin.test.tsx` (Requirement 1 criterion 7): the `signInDemo` success-redirect assertion on line 33 SHALL change from `redirectTo: "/import"` to `redirectTo: "/"`, and the line-28 test title that names `/import` SHALL change to name `/`. No other line of any existing test file SHALL change.
9. THE `apps/web` styling SHALL use CSS Modules, the approach `apps/web` already uses.

### Requirement 10: Theme, motion and accessibility

**User Story:** As a supplier on a phone or with assistive tech, I want the graveyard readable and operable, so that the theme never hides the data.

#### Acceptance Criteria

1. THE Graveyard_Page SHALL use the colours, typefaces and data encodings defined in `ui-theme.md` and `/design/Main.dc.html`, and design.md SHALL list every deviation from them.
2. THE Tombstone SHALL be reachable with the Tab key and SHALL show a focus indicator with at least 3:1 contrast against the adjacent background.
3. THE Tombstone SHALL carry an `aria-label` with, in this order, the buyer name, the principal formatted with `formatINR`, "<Days_Overdue> days overdue" and the Tombstone_State text from Requirement 5 criterion 3 (for example "Sharma Traders, ₹4,12,000, 26 days overdue, Tax bomb armed: 139 days left to 31 March").
4. THE Graveyard_Page and App_Shell SHALL meet WCAG 2.2 AA contrast for all text: at least 4.5:1 for normal text and at least 3:1 for large text (24 px or larger, or 18.66 px or larger in bold).
5. WHILE the user agent reports `prefers-reduced-motion: reduce`, THE Graveyard_Page SHALL run no animation or transition, including fog drift, candle flicker, wisps and bats, and SHALL still show every data encoding (height, moss, cracks, ember dot, wisp) in a static form.
6. THE Graveyard_Page SHALL place no decorative layer (fog, trees, fence, bats, moon) over any number, text or Tombstone_State label.
7. WHEN the viewport width is any value from 360 px to 1920 px, THE Graveyard_Page SHALL render without horizontal page scrolling.
8. THE Graveyard_Page SHALL use no 3D, `<canvas>` or WebGL.
9. THE links, buttons and Tombstones in the App_Shell and Graveyard_Page SHALL each have a target size of at least 44 × 44 CSS px.

### Requirement 11: Errors

**User Story:** As a supplier, I want a calm error page if the database is down, so that I don't see internals.

#### Acceptance Criteria

1. IF `getSupplier`, `getBankRate` or the Invoice_Record read throws or rejects while the Graveyard_Page renders, THEN THE Graveyard_Page SHALL show the Error_Page inside the App_Shell with no Tombstone and no Totals, plus a retry link to `/` that keeps the current `today` query value.
2. THE Error_Page SHALL show a plain-language message saying the graveyard could not be loaded, and SHALL show no stack trace, SQL text, connection string, error name or error message from the database.
3. WHEN no Bank_Rate is effective on or before Today, THE Graveyard_Page SHALL follow Requirement 2 criterion 5 and SHALL NOT show the Error_Page.

### Requirement 12: Tests (mandatory)

**User Story:** As a developer, I want exact tests on the demo data, so that the demo numbers can't drift.

#### Acceptance Criteria

1. THE test suite SHALL assert with exact `toEqual`, against expected values written as literals in the test, the full Graveyard_View built from `DEMO_SUPPLIER` and `DEMO_INVOICES` at Today `2026-11-12` with the demo Bank_Rate (575 bps, as of 2026-10-07), including:
   - Rules_As_Of `2026-10-07`.
   - Sharma Traders `LPC/26-27/0412`: due `2026-10-17`, 26 Days_Overdue, interest 512794 paise, state `armed` with 139 days left, next step `whatsapp_nudge`.
   - Gupta Engineering Works `LPC/26-27/0466`: state `not_due`.
   - Verma Auto Parts `LPC/26-27/0377`: state `resurrected` (tax bomb `defused`).
   - Mehta Polymers `LPC/25-26/0388`: state `exploded`.
   - Bansal Hardware `LPC/23-24/0098`: 956 Days_Overdue, interest 3167411 paise, state `exploded`, caveat `registered_after_supply`.
   - Kumar Textiles `LPC/26-27/0301`: 88 Days_Overdue.
   - every other number equal to the Engine output for the same inputs.
2. THE test suite SHALL assert with exact `toEqual` the Totals at Today `2026-11-12`: Outstanding, Interest_Accrued and Deductions_At_Risk as integer paise literals, and Exploded_Count and Paid_Count as integer literals.
3. THE test suite SHALL assert with exact `toEqual` the Tombstone order at Today `2026-11-12` as the full ordered list of invoice numbers.
4. THE test suite SHALL assert the exact Today_Resolver result, with the current instant injected rather than read from the clock, for each of these inputs: instant 2026-11-12T19:00:00Z with no override (`2026-11-13`); the valid Demo_Override `2027-03-10` (`2027-03-10`); the boundary values `2024-01-01` and `2027-12-31` (each returned unchanged); a repeated `today` value (the first value); and `2026-2-3`, `2026-02-30`, `13/11/2026`, `2023-12-31`, `2028-01-01` and an empty value (each returning the current IST date).
5. THE test suite SHALL assert that a signed-out request to `/` redirects to `/signin`.
6. THE test suite SHALL assert that a signed-in render of `/` contains the Sharma Traders `LPC/26-27/0412` Tombstone, shows the Demo_Date_Chip text "Demo date: 10 Mar 2027" with `?today=2027-03-10`, and contains no Demo_Date_Chip without a `today` query value.
7. WHEN the test suite simulates a Graveyard data-load failure whose error carries a known message, stack trace and SQL text, THE test suite SHALL assert that the Error_Page output contains none of them and contains a retry link to `/`.
8. THE test suite SHALL assert that, with no Bank_Rate effective on or before Today, every interest figure and Interest_Accrued render as "Bank rate not configured for <Today>", and that the Graveyard_Page renders the Graveyard with no LoadError and no Error_Page.
9. THE test suite SHALL assert that an Invoice_Record whose `acceptedOn` is after Today is absent from the Tombstone_View list and adds nothing to any Total.
10. THE `apps/web` tests, typecheck and lint SHALL pass with zero failures and zero errors, and every test task in this spec SHALL be required, with none marked optional.
11. THE test suite SHALL assert that a request to `/` with a session whose `supplierId` is not in the database ends at `/signin` after at most one redirect, shows "The demo was reset. Enter the graveyard again.", and clears the session cookie.
12. THE test suite SHALL assert the exact Next_Step_Label for every Engine `LadderStep` and every Engine `WaitReason` listed in Requirement 5 criteria 7 and 8, and that Sharma Traders `LPC/26-27/0412` at Today `2026-11-12` shows "Next: WhatsApp nudge".
