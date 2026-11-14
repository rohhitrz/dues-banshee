# Requirements Document

## Introduction

The Debtor_Page (`/debtors/[id]`, the "séance") shows one buyer of the Session_Supplier: every invoice of that buyer, a candle timeline of what has happened to them, and the buyer's Drafts waiting for the owner's approval. A dashboard Tombstone opens it.

The spec is lean. `apps/web` adds no legal or money maths. Every due date, interest figure, Days_Overdue, tax-bomb status and next step comes from the dashboard-ui Graveyard_Builder (which takes them from the Engine), and every amount is formatted with the Engine `formatINR`. Approve, edit, reject and redraft reuse the existing server actions in `apps/web/app/(app)/approvals/actions.ts` and the existing `DraftCard`; this spec adds no second copy of that logic. Nothing on the Debtor_Page sends a message, makes a call or issues a notice.

The active-promise check (the wisp rule in `apps/web/lib/graveyard/look.ts`) moves into one Engine helper used by both the Graveyard_Page and the Debtor_Page.

The route is `/debtors/[id]` as in `roadmap.md`, which overrides the older `app/(app)/debtor/[id]` path in `structure.md`.

Tests are mandatory in this spec. No test task may be marked optional.

Non-goals: editing invoices; any screen other than the Debtor_Page; 5,000-invoice scale (polish); source-lint gaps (guardrails-evals); the `/import` stale-session error (polish); sending WhatsApp messages or payment links (whatsapp-channel); starting calls (buyer-voice-call); changing Engine legal rules or the escalation ladder.

## Glossary

- **Debtor_Page**: the server-rendered page at `/debtors/[id]` in `apps/web`, where `id` is a Buyer_Id.
- **Buyer_Id**: the `buyers.id` uuid of one buyer.
- **Session_Supplier**, **Today_Resolver**, **Demo_Override**, **Demo_Date_Chip**, **Graveyard_Builder**, **Graveyard_Page**, **Tombstone**, **Tombstone_View**, **Tombstone_State**, **Days_Overdue**, **Next_Step_Label**, **App_Shell**, **Error_Page**, **Not_Found_Page**, **Bank_Rate**, **Step_Text**: as defined in `.kiro/specs/dashboard-ui/requirements.md`.
- **Draft**, **Escalation_Event**, **Approval_Queue**, **Disclaimer**: as defined in `.kiro/specs/escalation-ladder/requirements.md`.
- **Engine**: the pure package `packages/engine`.
- **Own_Buyer**: a buyer whose `buyers.supplier_id` equals the Session_Supplier id.
- **Stale_Session**: a session whose `supplierId` matches no stored supplier.
- **Today**: for the Debtor_Page, the date returned by `resolveSupplierToday` (`apps/web/lib/approvals/supplier-today.ts`): the Today_Resolver result for the demo supplier, and the real IST date with no Demo_Override for every other supplier.
- **Debtor_Invoice**: one invoice of the Own_Buyer whose `acceptedOn` is on or before Today.
- **Invoice_Panel**: the section of the Debtor_Page for one Debtor_Invoice, with the HTML id `invoice-<invoiceId>`.
- **Active_Promise_Helper**: the new pure Engine function `hasActivePromise(history, today)`.
- **Promise_Until_Helper**: the new pure Engine function `activePromiseUntil(history, today): CalendarDate | null`, which returns the latest `promisedDate` of a `promise` event on or after `today` in the history, and returns null exactly when `hasActivePromise(history, today)` is false.
- **Promise_Until_Date**: the non-null result of `activePromiseUntil(history, Today)` for an invoice history.
- **Candle_Timeline**: the ordered list of Timeline_Entries for the Own_Buyer on the Debtor_Page.
- **Timeline_Entry**: one candle in the Candle_Timeline, of one Entry_Kind, with a date, a text and the invoice number it belongs to.
- **Entry_Kind**: one of `invoice` (the invoice date), `due` (the Engine due date), `ladder` (one Escalation_Event), `promise` (one `promises` row) and `payment` (the invoice `paidOn` date).
- **Action_Text**: the text for one Escalation_Event `action`: `drafted` → "drafted", `edited` → "edited", `approved` → "approved", `rejected` → "rejected", `expired` → "expired".
- **Return_Target**: the page an approvals action redirects to after a decision: `/approvals`, or `/debtors/<Buyer_Id>` for a uuid Buyer_Id.
- **Placeholder_Buttons**: the two disabled buttons "Send pay link" and "Start call".

## Requirements

### Requirement 1: Routing and scope

**User Story:** As a supplier, I want to open one buyer's page from the graveyard, so that I see everything about that buyer in one place, and nobody else can see my buyers.

#### Acceptance Criteria

1. IF a request reaches `/debtors/[id]` and the session has no `supplierId`, THEN THE Debtor_Page SHALL redirect to `/signin` and render no buyer data.
2. THE Debtor_Page SHALL take the supplier id only from `session.supplierId`, and SHALL ignore any supplier id in the URL path, query string or request body.
3. IF the session is not a Stale_Session and the `id` path value is not a uuid, or is the Buyer_Id of a buyer that is not an Own_Buyer, or matches no buyer, THEN THE Debtor_Page SHALL render the Not_Found_Page with HTTP status 404 and render no buyer data, with the same response for all three cases.
4. IF the session is a Stale_Session, THEN THE Debtor_Page SHALL redirect to `/signin?error=SessionExpired` for any `id` path value, as the Graveyard_Page does, SHALL render no buyer data, and SHALL NOT respond with HTTP status 500.
5. THE `packages/db` package SHALL provide one read-only function that, for a supplier id and a Buyer_Id, returns the Own_Buyer (or none) with its invoices, Escalation_Events of every `action` and `promises` rows, and returns no row that belongs to another supplier. THE Debtor_Page SHALL load buyer data only through this function and the existing `listPendingDrafts`.
6. IF a database read throws while the Debtor_Page renders, THEN THE Debtor_Page SHALL show the Error_Page inside the App_Shell with a retry link to the same `/debtors/<id>` URL, which includes `?today=<Demo_Override>` only when a Demo_Override is active for the demo supplier, and SHALL show no stack trace, SQL text or database error message.

### Requirement 2: Today and the demo override

**User Story:** As a demo presenter, I want the debtor page to follow the demo date, so that the tax-bomb story stays consistent across screens.

#### Acceptance Criteria

1. THE Debtor_Page SHALL compute Today on the server only, with `resolveSupplierToday` from the Session_Supplier, the current instant and the first `today` query value, and SHALL compute every engine value it shows for that Today.
2. WHILE the Session_Supplier is the demo supplier and a Demo_Override is active, THE Debtor_Page SHALL show the Demo_Date_Chip with the Demo_Override date (for example "Demo date: 10 Mar 2027" for `2027-03-10`) and SHALL pass the Demo_Override as the `today` form field of every approvals action it renders.
3. IF the Session_Supplier is not the demo supplier, or no Demo_Override is active, THEN THE Debtor_Page SHALL use the Asia/Kolkata calendar date of the current instant as Today, show no Demo_Date_Chip and pass no `today` form field, whatever `today` query value is given.

### Requirement 3: Tombstone link from the dashboard

**User Story:** As a supplier, I want to click a tombstone to open that buyer, so that I can act on the invoice I was looking at.

#### Acceptance Criteria

1. THE Graveyard_Page SHALL render every Tombstone, whatever its Tombstone_State, as a single link to `/debtors/<Buyer_Id>#invoice-<invoiceId>`, where Buyer_Id and invoiceId belong to the buyer and invoice of that Tombstone's Tombstone_View. A navigation link triggers no escalation step, so dashboard-ui Requirement 5 criterion 6 still holds.
2. WHILE a Demo_Override is active on the Graveyard_Page, THE Tombstone link SHALL be `/debtors/<Buyer_Id>?today=<Demo_Override>#invoice-<invoiceId>`.
3. WHILE no Demo_Override is active on the Graveyard_Page, THE Tombstone link SHALL contain no `today` query value.
4. THE Tombstone link SHALL keep the Tombstone's existing `aria-label` text and visible focus indicator. Under dashboard-ui Requirement 10 criterion 9, its target size SHALL be at least 44 × 44 CSS px. Each Tombstone SHALL be exactly one keyboard tab stop.
5. THE Tombstone_View SHALL carry the Buyer_Id, and the `packages/db` read used by the Graveyard_Page SHALL return the Buyer_Id of each invoice.

### Requirement 4: Invoices of the buyer

**User Story:** As a supplier, I want each of the buyer's invoices with its legal figures, so that I know exactly what is owed and why.

#### Acceptance Criteria

1. THE Debtor_Page SHALL show the buyer name as its heading and exactly one Invoice_Panel per Debtor_Invoice, in the same relative order as the Own_Buyer's Tombstone_Views in the Graveyard_View that the Graveyard_Builder returns for the same supplier, Bank_Rate and Today.
2. THE Invoice_Panel SHALL show the invoice number, the principal, the Engine due date with `MSMED-15`, the statutory interest with `MSMED-16`, the Tombstone_State text (with `IT-43BH` beside an `armed` or `exploded` state and `MSMED-SCOPE` beside a `not_covered` state), the overdue text under the same rules as dashboard-ui Requirement 5 criteria 2 and 4, and the Next_Step_Label.
3. IF the Engine reports the caveat `registered_after_supply` for a Debtor_Invoice, THEN THE Invoice_Panel SHALL show the same badge text as dashboard-ui Requirement 5 criterion 5; otherwise THE Invoice_Panel SHALL show no caveat badge.
4. FOR ALL Debtor_Invoices, every figure, state and text in the Invoice_Panel SHALL equal the corresponding field of the Tombstone_View that the Graveyard_Builder returns for the same invoice, supplier, Bank_Rate and Today.
5. THE Debtor_Page source SHALL format every amount only with the Engine `formatINR`, and SHALL apply no float division, `toFixed`, `parseFloat` or `Number(...)` conversion to any money value.
6. IF no Bank_Rate is effective on or before Today, THEN THE Debtor_Page SHALL still render instead of the Error_Page, THE Invoice_Panel SHALL show "Bank rate not configured for <Today>" (Today in D MMM YYYY form, as on the Graveyard_Page) in place of the interest figure, and THE Invoice_Panel SHALL show every other figure unchanged.
7. IF the Own_Buyer has no Debtor_Invoice, THEN THE Debtor_Page SHALL show the buyer name as its heading, the text "No invoices for this buyer on this date", a link to `/`, and no Invoice_Panel.
8. THE Debtor_Page SHALL show the line "Reminders a supplier sends to its own buyers. Not legal advice." through the App_Shell footer.

### Requirement 5: Candle timeline

**User Story:** As a supplier, I want a timeline of invoices, ladder steps, promises and payments, so that I see the whole history with this buyer at a glance.

#### Acceptance Criteria

1. THE Debtor_Page SHALL show one Candle_Timeline with exactly these Timeline_Entries for the Debtor_Invoices: one `invoice` entry per invoice dated on its invoice date, one `due` entry per Debtor_Invoice that has an Engine due date, dated on that due date (a Debtor_Invoice whose Tombstone_State is `not_covered` has no Engine due date and so no `due` entry), one `ladder` entry per Escalation_Event dated on its `escalation_events.occurred_on`, one `promise` entry per `promises` row dated on its `promises.recorded_on`, and one `payment` entry per invoice paid on or before Today dated on its paid date. `occurred_on` and `recorded_on` are stored calendar dates, and THE Candle_Timeline SHALL use them as stored, with no timestamp-to-IST conversion.
2. THE Candle_Timeline SHALL exclude every `ladder`, `promise` and `payment` entry dated after Today, and SHALL keep every `invoice` and `due` entry whatever its date, including a `due` entry dated after Today.
3. THE Candle_Timeline SHALL order Timeline_Entries by date ascending, then by Entry_Kind in the order `invoice`, `due`, `ladder`, `promise`, `payment`, then by row id ascending by character code. The row id is the invoice id for `invoice`, `due` and `payment` entries, the Escalation_Event id for `ladder` entries, and the `promises` row id for `promise` entries.
4. THE Timeline_Entry texts SHALL be: `invoice` → "Invoice <number> raised for <formatINR principal>"; `due` → "Due date (MSMED-15)"; `ladder` → "<Step_Text> <Action_Text>" using the dashboard-ui Step_Text map; `promise` → "Promised <formatINR amount> by <promised date as D MMM YYYY>"; `payment` → "Paid. Resurrected". Each entry SHALL also show its entry date as `D MMM YYYY`, formatted from the stored calendar date with no time-zone conversion, and its invoice number.
5. THE Action_Text map SHALL be typed as `Record<EscalationAction, string>` (using `satisfies`), so that a new Escalation_Event `action` without a text fails the `apps/web` typecheck.
6. THE candle look SHALL encode data: a candle is lit if and only if its entry date is on or before Today; `promise` and `payment` candles are spectral green; a `due` candle is ember if and only if Today is after that due date and the invoice is unpaid on Today; every other candle is bone.
7. THE Candle_Timeline SHALL be an ordered list (`<ol>`) in which each entry's text, date and invoice number are present as text content and readable without the candle graphics, with every candle graphic `aria-hidden`.
8. WHILE the user agent reports `prefers-reduced-motion: reduce`, THE Candle_Timeline SHALL run no flicker or other animation and SHALL still show lit, unlit and colour states.

### Requirement 6: Active promise helper

**User Story:** As a developer, I want one active-promise rule in the Engine, so that the graveyard wisp and the debtor page can't disagree.

#### Acceptance Criteria

1. THE Engine SHALL export the pure Active_Promise_Helper `hasActivePromise(history, today)`, which returns true if and only if the history holds at least one `promise` event whose `promisedDate` is on or after `today`. It returns true when `promisedDate` equals `today`, and false for an empty history or a history with no `promise` events.
2. THE `tombstoneLook` function SHALL compute `wisp` as "unpaid on Today AND `hasActivePromise(history, Today)`", so `wisp` is false for a paid invoice whatever its history holds.
3. THE `apps/web` source SHALL contain no active-promise check other than calls to `hasActivePromise`.
4. WHILE a Debtor_Invoice is unpaid on Today and `hasActivePromise` is true for its history, THE Invoice_Panel SHALL show "Promise to pay active until <D MMM YYYY>" (for example "20 Nov 2026"). The date SHALL be the Promise_Until_Date, the result of `activePromiseUntil(history, Today)` from the Engine, instead of being recomputed in `apps/web`.
5. THE `packages/engine` fast-check property SHALL assert that, for all generated histories (including empty histories, histories with no `promise` events, and histories with several `promise` events) and all generated dates, `hasActivePromise(history, today)` equals the reference predicate `history.some(e => e.kind === "promise" && e.promisedDate >= today)`, which is the current wisp rule in `look.ts` written out inside the test.
6. THE Engine SHALL export the pure Promise_Until_Helper `activePromiseUntil(history, today): CalendarDate | null`, which returns the latest `promisedDate` of a `promise` event on or after `today`, and returns null exactly when `hasActivePromise(history, today)` is false.

### Requirement 7: Pending approvals for the buyer

**User Story:** As a supplier, I want to approve this buyer's drafts on the buyer's page, so that I don't have to switch to the approvals queue.

#### Acceptance Criteria

1. THE Debtor_Page SHALL show, under the heading "Waiting for your approval", one `DraftCard` per Draft returned by `listPendingDrafts` for the Session_Supplier whose invoice is a Debtor_Invoice of this Own_Buyer, in the order `listPendingDrafts` returns them.
2. IF no such Draft exists, THEN THE Debtor_Page SHALL show the text "No drafts waiting for this buyer" under the heading "Waiting for your approval" and render no `DraftCard`.
3. THE Debtor_Page SHALL use the existing `approve`, `saveEdit`, `reject` and `redraftIn` server actions through `DraftCard`, and `apps/web` SHALL contain no second implementation of approve, edit, reject or redraft.
4. WHEN the `approve`, `saveEdit`, `reject` or `redraftIn` server action finishes for a session whose supplier exists, THE action SHALL redirect to the `returnTo` form field value if that value is a Return_Target, and to `/approvals` otherwise (field missing, empty, or any other value), in both cases adding the same `notice`, `label`, `n` and `today` query values that `/approvals` gets today.
5. THE Debtor_Page SHALL send `returnTo` = `/debtors/<Buyer_Id>` with every `approve`, `saveEdit`, `reject` and `redraftIn` form it renders.
6. WHEN the Debtor_Page loads with a `notice` query value, THE Debtor_Page SHALL show the text that `noticeMessage` returns for the `notice`, `label` and `n` values, with `role="status"` for a success notice and `role="alert"` for an error notice.
7. WHEN the `approve`, `saveEdit`, `reject` or `redraftIn` server action finishes, THE action SHALL revalidate `/approvals`, and SHALL also revalidate `/debtors/<Buyer_Id>` for the Draft's buyer when the Draft belongs to the Session_Supplier, whichever page sent the form.
8. WHEN the Approval_Queue sends a form without a `returnTo` field, THE Approval_Queue SHALL keep its current behaviour, redirect targets and messages, and `checkLadderNow` and the Stale_Session redirect to `/signin?error=SessionExpired` SHALL stay the same.

### Requirement 8: Placeholder actions

**User Story:** As a judge, I want to see where WhatsApp and voice will plug in, so that the roadmap is visible without anything being sent.

#### Acceptance Criteria

1. THE Invoice_Panel of every Debtor_Invoice whose Tombstone_State is not `resurrected` SHALL show the Placeholder_Buttons "Send pay link" and "Start call" as real `<button>` elements with the `disabled` attribute, and the Invoice_Panel of a Debtor_Invoice whose Tombstone_State is `resurrected` SHALL show neither Placeholder_Button.
2. WHERE an Invoice_Panel shows the Placeholder_Buttons, THE Invoice_Panel SHALL show the text "Arrives with WhatsApp" for "Send pay link" and "Arrives with voice call" for "Start call", and each Placeholder_Button's `aria-describedby` SHALL reference the id of the element that holds its text.
3. THE Placeholder_Buttons SHALL have no form action, click handler or server call in this spec.

### Requirement 9: Theme and accessibility

**User Story:** As a supplier on a phone or with assistive tech, I want the séance screen readable and operable, so that the theme never hides the data.

#### Acceptance Criteria

1. THE Debtor_Page SHALL use the colours, typefaces and data encodings of `ui-theme.md`, use CSS Modules, and use no 3D, `<canvas>` or WebGL.
2. THE Debtor_Page SHALL render every decorative element `aria-hidden`, and no decorative element SHALL overlap or be painted above any number, text or state label at any viewport width from 360 px to 1920 px.
3. THE Debtor_Page SHALL meet WCAG 2.2 AA text contrast (4.5:1 normal, 3:1 large) for all text, including the text of the disabled Placeholder_Buttons and their "Arrives with …" descriptions, give every enabled link and button a target of at least 44 × 44 CSS px, and render without horizontal page scrolling at any viewport width from 360 px to 1920 px.
4. WHEN the Debtor_Page is opened with a `#invoice-<invoiceId>` fragment that matches an Invoice_Panel, THE Debtor_Page SHALL scroll that Invoice_Panel into view after load, with its invoice number visible and not covered by the App_Shell.
5. IF the Debtor_Page is opened with a `#invoice-<invoiceId>` fragment that matches no Invoice_Panel, THEN THE Debtor_Page SHALL render as it does with no fragment, scrolled to the top, with no error.

### Requirement 10: Tests (mandatory)

**User Story:** As a developer, I want exact tests on the demo data, so that the debtor page can't drift from the graveyard.

#### Acceptance Criteria

1. THE test suite SHALL assert with exact `toEqual`, against literals, the Debtor_Page view for the demo seed buyer Sharma Traders at Today `2026-11-12` with the demo Bank_Rate: invoice `LPC/26-27/0412`, principal 41200000 paise shown as `formatINR(41200000)`, due `2026-10-17` with `MSMED-15`, 26 Days_Overdue, interest 512794 paise shown as `formatINR(512794)` with `MSMED-16`, state `armed` with 139 days left and `IT-43BH`, and Next_Step_Label "Next: WhatsApp nudge". Paise values, dates, day counts, rule IDs and texts SHALL be written as literals in the test. Each displayed amount SHALL be asserted equal to the string that the Engine `formatINR` returns for the literal paise value.
2. THE test suite SHALL assert with exact `toEqual` the full Candle_Timeline for Sharma Traders at Today `2026-11-12` (kinds, dates, texts and order). It SHALL also assert one fixture case that contains a `ladder`, a `promise` and a `payment` entry dated after Today (all three excluded), a `due` entry dated after Today (kept), at least two entries of different Entry_Kinds on the same date (ordered by Entry_Kind), and a Debtor_Invoice whose Tombstone_State is `not_covered` that yields an `invoice` entry and no `due` entry. Together these cover Requirement 5 criteria 1, 2 and 3.
3. THE test suite SHALL assert that a signed-out request redirects to `/signin`, and that a Stale_Session redirects to `/signin?error=SessionExpired` with no HTTP status 500. It SHALL assert that a non-uuid id, an unknown uuid and another supplier's Buyer_Id each produce the Not_Found_Page with HTTP status 404 and no buyer data. It SHALL assert that a thrown database read shows the Error_Page with a retry link to the same `/debtors/<id>` URL and with no stack trace, SQL text or database error message.
4. THE test suite SHALL assert that for the demo supplier a valid `today` query value becomes Today and the Demo_Date_Chip is shown. For any other supplier, it SHALL assert that Today is the real IST date, no Demo_Date_Chip is shown and no `today` form field is passed.
5. THE test suite SHALL assert that a `returnTo` of `/debtors/<uuid>` is followed with the `notice`, `label`, `n` and `today` query values kept, and that a missing value, `//evil.example`, `https://evil.example`, `/debtors/not-a-uuid` and `/` each redirect to `/approvals`.
6. THE `packages/engine` test suite SHALL include the fast-check property of Requirement 6 criterion 5, and a fast-check property asserting that, for all generated histories (including empty histories, histories with no `promise` events, and histories with several `promise` events) and all generated dates, `activePromiseUntil(history, today) !== null` equals `hasActivePromise(history, today)` (Requirement 6 criterion 6). It SHALL also include example tests asserting that `hasActivePromise` returns false for a promise whose `promisedDate` is the day before `today`, true for the day of `today`, and true for the day after `today`.
7. THE test suite SHALL assert that the Placeholder_Buttons render with the `disabled` attribute and the texts "Send pay link" and "Start call", with "Arrives with WhatsApp" and "Arrives with voice call" linked through `aria-describedby`. It SHALL also assert that each Tombstone links to `/debtors/<Buyer_Id>#invoice-<invoiceId>` (with `?today=<Demo_Override>` before the fragment while a Demo_Override is active).
8. THE repository SHALL include one Playwright smoke test, run against a database seeded with the demo seed, that signs in with "Enter the graveyard (demo)", opens `/?today=2026-11-12` and clicks the Sharma Traders Tombstone. It SHALL assert that the URL is `/debtors/<Buyer_Id>?today=2026-11-12#invoice-<invoiceId>` for Sharma Traders and `LPC/26-27/0412`, and that the Debtor_Page shows "Sharma Traders", `LPC/26-27/0412`, `formatINR(41200000)`, "Overdue 26 days, interest accruing", `formatINR(512794)` and "Tax bomb armed: 139 days left to 31 March".
9. THE `apps/web` and `packages/engine` Vitest tests, typecheck and lint SHALL pass with zero failures. The Playwright smoke test SHALL pass with zero failures when run against a demo-seeded database. Every test task in this spec SHALL be required, with none marked optional.
