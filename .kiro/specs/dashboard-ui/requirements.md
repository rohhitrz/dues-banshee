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
- **Graveyard_View**: the view model returned by the Graveyard_Builder: the ordered Tombstone_View list, the Totals and the Rules_As_Of date.
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
- **Next_Step_Label**: a read-only text derived from `nextEscalationStep`: "Next: <step name>" for an advance, or "Waiting: <reason>" for a wait.
- **Totals**: Outstanding, Interest_Accrued, Deductions_At_Risk, Exploded_Count and Paid_Count, all computed from Engine outputs in the Graveyard_View.
- **Not_Found_Page**: the themed page Next.js shows for an unknown route.
- **Error_Page**: the themed page shown when loading the Graveyard fails.

## Requirements

### Requirement 1: Routing

**User Story:** As a supplier, I want `/` to open my graveyard, so that the first screen after sign-in is my dues.

#### Acceptance Criteria

1. WHEN a request without a session `supplierId` reaches `/`, THE Graveyard_Page SHALL redirect to `/signin`.
2. WHEN a request with a session `supplierId` reaches `/`, THE Graveyard_Page SHALL render the Graveyard for the Session_Supplier.
3. WHEN a request reaches `/graveyard`, THE Graveyard_Page SHALL redirect to `/` and keep the `today` query value.
4. WHEN a request reaches a path that no route serves, THE Not_Found_Page SHALL render inside the App_Shell with a link to `/`.
5. THE `proxy.ts` module SHALL import only `auth.config.ts` and no database code.
6. THE `/signin` server action SHALL keep its current redirect target and messages, so the existing `/signin` tests pass unchanged.

### Requirement 2: Loading data for the Session_Supplier

**User Story:** As a supplier, I want to see only my own invoices, so that no other supplier's data reaches my screen.

#### Acceptance Criteria

1. THE Graveyard_Page SHALL take the supplier id only from `session.supplierId`, and ignore any supplier id in the URL, query or body.
2. WHEN the Graveyard_Page renders, THE Graveyard_Page SHALL load the Session_Supplier with `getSupplier`, the Bank_Rate with `getBankRate` for Today, and every Invoice_Record of the Session_Supplier with buyer name, invoice number and escalation history.
3. WHERE `packages/db` has no read function for a supplier's invoices with buyer names and escalation history, THE `packages/db` package SHALL add one read-only function that filters by supplier id, and THE Graveyard_Page SHALL use that function.
4. WHEN the data is loaded, THE Graveyard_Page SHALL pass the data to the Graveyard_Builder and render only the returned Graveyard_View.
5. IF no Bank_Rate is effective on or before Today, THEN THE Graveyard_Page SHALL render the Graveyard with every interest figure shown as "Bank rate not configured for <Today>" and Interest_Accrued shown the same way.

### Requirement 3: Pure view-model builder

**User Story:** As a developer, I want the graveyard maths in one pure function, so that the demo numbers are tested exactly.

#### Acceptance Criteria

1. THE Graveyard_Builder SHALL take the supplier, the Invoice_Records, the Bank_Rate (or none) and Today as arguments, and return the Graveyard_View.
2. THE Graveyard_Builder SHALL compute each due date, interest figure, tax-bomb status, days left, deduction at risk, caveat and next ladder step only by calling the Engine functions `dueDate`, `statutoryInterest`, `taxBomb` and `nextEscalationStep`.
3. THE Graveyard_Builder SHALL format every money value only with the Engine `formatINR`.
4. THE Graveyard_Builder SHALL keep every money value as integer paise; `apps/web` SHALL contain no float division, `toFixed`, `parseFloat` or `Number(...)` conversion applied to money.
5. FOR ALL Invoice_Records and Today values, THE Graveyard_Builder SHALL return the same Graveyard_View when called twice with equal arguments (determinism).
6. THE Graveyard_Builder SHALL exclude an Invoice_Record whose `acceptedOn` is after Today from the Tombstone_View list and from the Totals.
7. THE Graveyard_View SHALL include the Bank_Rate `asOf` date as Rules_As_Of, and THE Graveyard_Page SHALL show "Rules as of <date>".

### Requirement 4: Resolving Today

**User Story:** As a demo presenter, I want the graveyard computed for the Indian date and optionally for a chosen demo date, so that judges can see the 31 March tax bomb on any day.

#### Acceptance Criteria

1. WHEN no `today` query value is given, THE Today_Resolver SHALL return the calendar date of the current instant in Asia/Kolkata.
2. WHEN the current instant is 2026-11-12T19:00:00Z and no `today` query value is given, THE Today_Resolver SHALL return `2026-11-13`.
3. WHEN the `today` query value is a Demo_Override, THE Today_Resolver SHALL return that date.
4. IF the `today` query value is empty, not in strict `YYYY-MM-DD` form (for example `2026-2-3` or `13/11/2026`), not a real calendar date (for example `2026-02-30`), or outside 2024-01-01 to 2027-12-31, THEN THE Today_Resolver SHALL return the current IST date.
5. IF the `today` query value is repeated, THEN THE Today_Resolver SHALL use the first value.
6. THE Today_Resolver SHALL run only on the server.
7. WHILE a Demo_Override is active, THE Graveyard_Page SHALL show the Demo_Date_Chip.
8. WHILE no Demo_Override is active, THE Graveyard_Page SHALL hide the Demo_Date_Chip.
9. THE Graveyard_Page SHALL show the Time_Travel_Control as links that set `?today=2027-03-10` and `?today=2027-04-01`, and a "Today" link that removes the `today` query value.

### Requirement 5: Tombstones

**User Story:** As a supplier, I want each unpaid invoice shown as a tombstone with its legal state, so that I know which buyer to chase first.

#### Acceptance Criteria

1. THE Graveyard_Page SHALL render one Tombstone per Tombstone_View.
2. THE Tombstone SHALL show the buyer name, invoice number, principal formatted with `formatINR`, the Engine due date, Days_Overdue and the Engine statutory interest formatted with `formatINR`.
3. THE Tombstone SHALL show the Tombstone_State as text: "Not due yet", "Overdue, interest accruing", "Tax bomb armed: N days left to 31 March", "Tax bomb exploded", "Resurrected (paid)" or "Outside MSMED (<reason>)".
4. WHILE the Tombstone_State is `armed` or `exploded`, THE Tombstone SHALL also show "Overdue N days, interest accruing" using Days_Overdue.
5. WHEN the Engine reports the caveat `registered_after_supply`, THE Tombstone SHALL show the badge "Registered on Udyam after supply: claim may be contested".
6. THE Tombstone SHALL show the Next_Step_Label, and show no action button.
7. THE Tombstone SHALL show the Engine rule IDs behind each legal figure shown (for example `MSMED-16` beside interest, `IT-43BH` beside the tax-bomb state).
8. THE Tombstone SHALL encode data in its look: height by principal, moss by Days_Overdue, cracks when Days_Overdue is above 60, an ember dot when Days_Overdue is above 45, and a rising wisp when an active promise to pay exists.

### Requirement 6: Sort order

**User Story:** As a supplier, I want the most urgent tombstone first, so that I act on the closest deadline.

#### Acceptance Criteria

1. THE Graveyard_Builder SHALL order Tombstone_Views in groups: `armed`, then `exploded` and `overdue` together, then `not_due`, then `not_covered`, then `resurrected`.
2. THE Graveyard_Builder SHALL order the `armed` group by fewest Engine `daysLeft` first.
3. THE Graveyard_Builder SHALL order the `exploded` and `overdue` group by most Days_Overdue first.
4. THE Graveyard_Builder SHALL order the `not_due` group by earliest Engine due date first.
5. WHEN two Tombstone_Views tie under criteria 1 to 4, THE Graveyard_Builder SHALL order by most Days_Overdue first, then by invoice number ascending, then by Invoice_Record id ascending.

### Requirement 7: Totals bar

**User Story:** As a supplier, I want the totals of what I'm owed and what the buyers risk, so that I see the size of the problem at a glance.

#### Acceptance Criteria

1. THE Totals SHALL include Outstanding: the sum of principal of Invoice_Records unpaid on Today.
2. THE Totals SHALL include Interest_Accrued: the sum of Engine `interestPaise` of Invoice_Records unpaid on Today.
3. THE Totals SHALL include Deductions_At_Risk: the sum of Engine `deductionAtRiskPaise` of Invoice_Records unpaid on Today whose Engine tax-bomb status is `armed`.
4. THE Totals SHALL include Exploded_Count (Tombstone_State `exploded`) and Paid_Count (Tombstone_State `resurrected`).
5. THE Graveyard_Page SHALL show each money total formatted with `formatINR` and keep each total as integer paise.

### Requirement 8: Empty state

**User Story:** As a new supplier, I want to be told how to add invoices, so that an empty graveyard isn't a dead end.

#### Acceptance Criteria

1. WHEN the Graveyard_View has no Tombstone_View, THE Graveyard_Page SHALL show "The graveyard is quiet" and a link to `/import`.

### Requirement 9: Shell and restyled pages

**User Story:** As a judge, I want every screen in one theme, so that the product feels finished.

#### Acceptance Criteria

1. THE App_Shell SHALL show header navigation with "Graveyard" (`/`), "Import" (`/import`) and "Sign out".
2. THE App_Shell SHALL show the footer line "Reminders a supplier sends to its own buyers. Not legal advice."
3. THE `/signin` page SHALL use the graveyard theme and keep the one-click "Enter the graveyard (demo)" button.
4. THE `/import` page SHALL use the graveyard theme.
5. WHEN `/signin` and `/import` are restyled, THE existing tests in `apps/web/test` SHALL pass without edits.
6. THE `apps/web` styling SHALL use CSS Modules, the approach `apps/web` already uses.

### Requirement 10: Theme, motion and accessibility

**User Story:** As a supplier on a phone or with assistive tech, I want the graveyard readable and operable, so that the theme never hides the data.

#### Acceptance Criteria

1. THE Graveyard_Page SHALL use the colours, typefaces and data encodings of `ui-theme.md` and `/design/Main.dc.html`, with every deviation listed in design.md.
2. THE Tombstone SHALL be keyboard-focusable, show a visible focus ring, and carry an `aria-label` with buyer name, principal, Days_Overdue and Tombstone_State text (for example "Sharma Traders, ₹4,12,000, 26 days overdue, tax bomb armed: 139 days left to 31 March").
3. THE Graveyard_Page SHALL meet WCAG 2.2 AA contrast (4.5:1 for text) for all text.
4. WHILE the user agent reports `prefers-reduced-motion: reduce`, THE Graveyard_Page SHALL run no animation, including fog drift, candle flicker, wisps and bats.
5. THE Graveyard_Page SHALL render without horizontal page scrolling at 360 px viewport width, and at desktop widths.
6. THE Graveyard_Page SHALL use no 3D, `<canvas>` or WebGL.
7. THE interactive elements of the App_Shell and Graveyard_Page SHALL have a target size of at least 44 × 44 px.

### Requirement 11: Errors

**User Story:** As a supplier, I want a calm error page if the database is down, so that I don't see internals.

#### Acceptance Criteria

1. IF loading the Graveyard data fails, THEN THE Graveyard_Page SHALL show the Error_Page inside the App_Shell with a retry link to `/`.
2. THE Error_Page SHALL show no stack trace, SQL text, connection string or error message from the database.

### Requirement 12: Tests (mandatory)

**User Story:** As a developer, I want exact tests on the demo data, so that the demo numbers can't drift.

#### Acceptance Criteria

1. THE test suite SHALL assert with exact `toEqual` the full Graveyard_View built from `DEMO_SUPPLIER` and `DEMO_INVOICES` at Today `2026-11-12` with the demo Bank_Rate (575 bps, as of 2026-10-07), including:
   - Sharma Traders `LPC/26-27/0412`: due `2026-10-17`, 26 Days_Overdue, interest 512794 paise, state `armed` with 139 days left, next step `whatsapp_nudge`.
   - Gupta Engineering Works `LPC/26-27/0466`: state `not_due`.
   - Verma Auto Parts `LPC/26-27/0377`: state `resurrected` (tax bomb `defused`).
   - Mehta Polymers `LPC/25-26/0388`: state `exploded`.
   - Bansal Hardware `LPC/23-24/0098`: 956 Days_Overdue, interest 3167411 paise, state `exploded`, caveat `registered_after_supply`.
   - Kumar Textiles `LPC/26-27/0301`: 88 Days_Overdue.
   - every other number equal to the Engine output for the same inputs.
2. THE test suite SHALL assert the exact Totals at Today `2026-11-12`.
3. THE test suite SHALL assert the exact Tombstone order at Today `2026-11-12`.
4. THE test suite SHALL assert the Today_Resolver result for: instant 2026-11-12T19:00:00Z with no override (`2026-11-13`); a valid Demo_Override; `2026-2-3`; `2026-02-30`; `13/11/2026`; a date before 2024-01-01; a date after 2027-12-31; and an empty value.
5. THE test suite SHALL assert that a signed-out request to `/` redirects to `/signin`.
6. THE test suite SHALL assert that a signed-in render of `/` contains the Sharma Traders Tombstone, shows the Demo_Date_Chip with a Demo_Override, and hides the Demo_Date_Chip without one.
7. THE test suite SHALL assert that the Error_Page output contains no database error message.
8. THE `apps/web` tests, typecheck and lint SHALL pass, and every test task in this spec SHALL be required.
