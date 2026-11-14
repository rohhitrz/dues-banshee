# Design Document: debtor-ui

## Overview

The Debtor_Page is a server-rendered page at `/debtors/[id]` in `apps/web`. It loads one Own_Buyer through one new read-only `packages/db` function, runs that buyer's records through the existing `buildGraveyard` (so every legal figure is the same Tombstone_View the dashboard shows), and adds two pure, display-only pieces in `apps/web/lib/debtor/`: the Debtor_View (panels) and the Candle_Timeline. Pending Drafts are the existing `listPendingDrafts` rows filtered by buyer and rendered with the existing `DraftCard`.

`apps/web` adds no legal or money maths. It selects, filters by date, orders, formats with `formatINR` / `formatDisplayDate` and maps codes to text.

Key decisions:

| Decision | Choice | Why |
|---|---|---|
| Legal figures | Call `buildGraveyard(supplier, buyerRecords, bankRate, today)` and use its `tombstones` | One builder, so the panel can't drift from the tombstone (Req 4.1, 4.4). Its sort is a total order that doesn't depend on the input set, so the buyer's relative order equals the dashboard's. Only `look.heightPx` (rank among the set) differs, and the panel doesn't show it. |
| Route group | New group `app/(debtor)/debtors/[id]/` with its own session-guard layout, not `app/(app)/` | `app/(app)/loading.tsx` wraps every `(app)` page in a Suspense boundary. A `notFound()` or `redirect()` thrown after the shell is streamed comes back as HTTP 200, which breaks Req 1.3 and 1.4 ([Stack Overflow: notFound returns 200 under loading.tsx](https://stackoverflow.com/questions/79349834/nextjs-14-app-router-dynamic-route-returns-the-404-page-but-with-200-status-code)). The new group has no `loading.tsx`, so 404 and 307 are real status codes. The URL is the same (route groups add no segment). |
| Active promise | Engine `hasActivePromise` + `activePromiseUntil` in `packages/engine/src/promise.ts` | One rule for the wisp and the panel (Req 6). |
| Return after a decision | Pure `parseReturnTo(raw)` with a strict allowlist; `finish()` takes the target | No open redirect. `/approvals` behaviour is unchanged when the field is absent (Req 7.4, 7.8). |
| Draft's buyer | `DraftWithContext` gains `buyerId` | Lets the page filter Drafts by buyer (Req 7.1) and the actions revalidate `/debtors/<buyerId>` (Req 7.7) with no new query shape. |
| Playwright | `@playwright/test` dev dependency in `apps/web`, run on demand, not in `pnpm test` | Req 10.8 needs a demo-seeded DB and a running server, which the Vitest suite doesn't have. |

New dependencies: `@playwright/test` (dev, `apps/web`) only.

## Architecture

```mermaid
flowchart LR
  B["GET /debtors/:id?today=…"] --> P[proxy.ts<br/>matcher + /debtors/:path*]
  P -- no supplierId --> S[/signin]
  P --> L["(debtor)/layout.tsx<br/>session guard"] --> G["debtors/[id]/page.tsx"]
  G --> LD[loadDebtorData<br/>lib/debtor/load.ts]
  LD --> DB[(getSupplier · getBankRate ·<br/>getDebtorData · listPendingDrafts)]
  LD -- stale --> R[redirect /signin?error=SessionExpired]
  LD -- not_found --> NF["notFound() → 404"]
  LD -- error --> E[DebtorLoadError<br/>retry /debtors/:id]
  LD -- ok --> BG[buildGraveyard] --> DV[buildDebtorView<br/>+ buildCandleTimeline]
  DV --> UI[Invoice_Panels · Candle_Timeline · DraftCards]
  UI -- approve/edit/reject/redraft<br/>returnTo=/debtors/:id --> A[approvals/actions.ts]
  A --> RT[parseReturnTo] --> RD[redirect back + revalidate]
```

Request flow:

1. `proxy.ts` matcher gains `"/debtors/:path*"` (the old `"/debtor/:path*"` stays), so signed-out requests go to `/signin` (Req 1.1). `(debtor)/layout.tsx` repeats the `(app)/layout.tsx` guard.
2. The page reads `session.supplierId` from `auth()` only (Req 1.2), awaits `params.id` and `searchParams`, and calls `loadDebtorData(db, supplierId, id, Date.now(), searchParams.today)`.
3. `redirect()` and `notFound()` are called outside any `try`, after the loader returns (they throw).

Loader order inside `loadDebtorData` (it never throws, never redirects):

1. `getSupplier` → `SupplierNotFoundError` ⇒ `stale`. This runs before the id check, so a Stale_Session redirects for any id (Req 1.4).
2. `resolveSupplierToday(supplier, nowMs, rawToday)` ⇒ `{ today, override }` (Req 2).
3. `id` fails the uuid regex ⇒ `not_found` (no DB call with a non-uuid, so Postgres never raises a cast error).
4. `getBankRate(db, today)`; `BankRateNotFoundError` ⇒ `bankRate = null` (Req 4.6), as in `loadGraveyardData`.
5. `getDebtorData(db, supplierId, id)` ⇒ `null` ⇒ `not_found`. Unknown id and another supplier's buyer give the same `null` (Req 1.3).
6. `listPendingDrafts(db, supplierId)`, filtered by `buyerId === id`.
7. Any other error ⇒ `{ kind: "error", override }` (override only if step 2 ran), logged with `console.error` only.

### File map

```
apps/web/
  proxy.ts                                   matcher + "/debtors/:path*"
  app/(debtor)/layout.tsx                    session guard (copy of (app)/layout.tsx)
  app/(debtor)/error.tsx                     backstop, fixed text, retry to the same path (+ ?today)
  app/(debtor)/debtors/[id]/page.tsx         Debtor_Page
  app/(debtor)/debtors/[id]/debtor.module.css
  components/debtor/{invoice-panel,candle-timeline,placeholder-actions,debtor-load-error}.tsx (+ .module.css)
  components/graveyard/tombstone.tsx         <article tabIndex> → <a href> (Req 3)
  components/graveyard/tombstone-grid.tsx    passes `override` through
  components/approvals/draft-card.tsx        new optional `returnTo` prop → hidden field
  app/(app)/page.tsx                         passes `override` to TombstoneGrid
  app/(app)/approvals/actions.ts             returnTo + revalidation (Req 7.4, 7.7)
  lib/approvals/return-to.ts                 parseReturnTo (pure)
  lib/debtor/load.ts                         loadDebtorData
  lib/debtor/build-debtor-view.ts            buildDebtorView (pure)
  lib/debtor/candle-timeline.ts              buildCandleTimeline, ACTION_TEXT (pure)
  lib/debtor/href.ts                         debtorHref (pure)
  lib/graveyard/labels.ts                    + overdueText (moved out of tombstone.tsx)
  lib/graveyard/look.ts                      wisp uses hasActivePromise
  playwright.config.ts, e2e/debtor-smoke.spec.ts
packages/engine/src/promise.ts               hasActivePromise, activePromiseUntil
packages/db/src/graveyard.ts                 record gains buyerId, invoiceDate; + getDebtorData
packages/db/src/ladder.ts                    DraftWithContext gains buyerId
```

`structure.md` names `app/(app)/debtor/[id]`. `roadmap.md` (and Req intro) set the URL to `/debtors/[id]`; the `(debtor)` group is needed for the status codes above.

## Components and Interfaces

### packages/engine (`promise.ts`, exported from `index.ts`)

```ts
/** True iff some `promise` event has promisedDate >= today (CalendarDate string compare). */
export function hasActivePromise(history: EscalationHistory, today: CalendarDate): boolean;
/** Latest promisedDate among promise events with promisedDate >= today; null iff !hasActivePromise. */
export function activePromiseUntil(history: EscalationHistory, today: CalendarDate): CalendarDate | null;
```

Pure, no clock, inputs not mutated. `hasActivePromise` is defined as `activePromiseUntil(...) !== null` so the two can't disagree. `tombstoneLook` becomes `wisp: !paid && hasActivePromise(history, today)` (Req 6.2). The existing `apps/web/test/lint.test.ts` style source scan gains a check that `apps/web` has no `kind === "promise"` comparison with `promisedDate` outside the Engine (Req 6.3).

### packages/db

```ts
export interface GraveyardInvoiceRecord {
  invoice: Invoice; buyerName: string; invoiceNumber: string; history: EscalationHistory;
  buyerId: string;            // new (Req 3.5)
  invoiceDate: CalendarDate;  // new, for the `invoice` Timeline_Entry
}

export interface DebtorEventRow { id: string; invoiceId: string; step: LadderStep; action: EscalationAction; occurredOn: CalendarDate }
export interface DebtorPromiseRow { id: string; invoiceId: string; promisedDate: CalendarDate; amountPaise: Paise; recordedOn: CalendarDate }
export interface DebtorData {
  buyer: { id: string; name: string };
  records: GraveyardInvoiceRecord[];   // same shape and history rules as listGraveyardInvoices
  events: DebtorEventRow[];            // every action, not only "approved"
  promises: DebtorPromiseRow[];
}
/** Read-only. null when the buyer doesn't exist or isn't the supplier's. */
export function getDebtorData(db: Db, supplierId: string, buyerId: string): Promise<DebtorData | null>;
```

- `listGraveyardInvoices` and `getDebtorData` share one private reader `readRecords(db, supplierId, buyerId?)` in `graveyard.ts`. Every query is filtered by `invoices.supplier_id = supplierId`, plus `invoices.buyer_id = buyerId` when given (Req 1.5).
- `getDebtorData` first selects the buyer with `buyers.id = buyerId AND buyers.supplier_id = supplierId`; no row ⇒ `null`.
- `events` and `promises` come from the same supplier-scoped joins through `invoices`. They are returned unordered-by-contract; the timeline sorts.
- `DraftWithContext` gains `buyerId: string` (`invoices.buyer_id`), filled in `toDraftWithContext`.

### Debtor loader (`lib/debtor/load.ts`)

```ts
export type DebtorLoadResult =
  | { kind: "ok"; view: DebtorView }
  | { kind: "stale" }
  | { kind: "not_found" }
  | { kind: "error"; override: CalendarDate | null };
export function loadDebtorData(
  db: Db, supplierId: string, buyerIdRaw: string, nowMs: number, rawToday: string | string[] | undefined,
): Promise<DebtorLoadResult>;
```

### Debtor_View builder (`lib/debtor/build-debtor-view.ts`, pure)

```ts
export interface InvoicePanelView {
  tombstone: TombstoneView;           // from buildGraveyard, unchanged
  buyerId: string;
  panelId: `invoice-${string}`;
  overdueText: string | null;         // labels.overdueText(tombstone), same rule as the Tombstone
  promiseUntilText: string | null;    // "Promise to pay active until <D MMM YYYY>" or null
  showPlaceholders: boolean;          // tombstone.state !== "resurrected"
}
export interface DebtorView {
  supplierName: string;
  buyerId: string; buyerName: string;
  today: CalendarDate; override: CalendarDate | null;
  panels: InvoicePanelView[];         // graveyard order
  timeline: TimelineEntry[];
  drafts: DraftWithContext[];         // listPendingDrafts order, this buyer only
}
export function buildDebtorView(input: {
  supplier: Supplier; data: DebtorData; bankRate: BankRate | null;
  drafts: readonly DraftWithContext[]; today: CalendarDate; override: CalendarDate | null;
}): DebtorView;
```

- `panels` = `buildGraveyard(supplier, data.records, bankRate, today).tombstones` in that order. `buildGraveyard` already drops records with `acceptedOn > today`, which defines the Debtor_Invoices.
- `promiseUntilText`: when `state !== "resurrected"` and `activePromiseUntil(record.history, today)` is non-null, `` `Promise to pay active until ${formatDisplayDate(date)}` `` (Req 6.4).
- `drafts` keeps a Draft iff `buyerId === data.buyer.id` and its `invoice.id` is a Debtor_Invoice id (Req 7.1).

### Candle_Timeline (`lib/debtor/candle-timeline.ts`, pure)

```ts
export type EntryKind = "invoice" | "due" | "ladder" | "promise" | "payment";
export interface TimelineEntry {
  kind: EntryKind; date: CalendarDate; dateText: string; text: string;
  invoiceNumber: string; rowId: string;
  lit: boolean; tone: "bone" | "spectral" | "ember";
}
export const ACTION_TEXT = {
  drafted: "drafted", edited: "edited", approved: "approved", rejected: "rejected", expired: "expired",
} as const satisfies Record<EscalationAction, string>;            // Req 5.5
export function buildCandleTimeline(input: {
  panels: readonly InvoicePanelView[]; records: readonly GraveyardInvoiceRecord[];
  events: readonly DebtorEventRow[]; promises: readonly DebtorPromiseRow[]; today: CalendarDate;
}): TimelineEntry[];
```

Rules (Req 5.1–5.4, 5.6):

| Kind | One per | Date | Text | Kept when |
|---|---|---|---|---|
| `invoice` | Debtor_Invoice | `record.invoiceDate` | `Invoice <number> raised for <tombstone.principalText>` | always |
| `due` | Debtor_Invoice with `tombstone.dueDate !== null` | `tombstone.dueDate` | `Due date (MSMED-15)` | always |
| `ladder` | event of a Debtor_Invoice | `occurredOn` | `` `${STEP_TEXT[step]} ${ACTION_TEXT[action]}` `` | date ≤ today |
| `promise` | promise row of a Debtor_Invoice | `recordedOn` | `Promised <formatINR(amount,"full")> by <formatDisplayDate(promisedDate)>` | date ≤ today |
| `payment` | Debtor_Invoice with `invoice.paidOn ≤ today` | `paidOn` | `Paid. Resurrected` | date ≤ today |

- Order: `date` asc, then kind rank `invoice 0, due 1, ladder 2, promise 3, payment 4`, then `rowId` asc by code unit (invoice id for invoice/due/payment, event id, promise id). Total order, so the result doesn't depend on input order.
- `dateText = formatDisplayDate(date)` on the stored calendar string; no `Date` objects.
- `lit = date <= today`. `tone`: `promise`/`payment` ⇒ `spectral`; `due` ⇒ `ember` iff `today > date && tombstone.state !== "resurrected"`; else `bone`.
- A not-covered invoice has no Engine due date, so it has no `due` entry.

### Approvals changes

```ts
// lib/approvals/return-to.ts
export type ReturnTarget = "/approvals" | `/debtors/${string}`;
/** "/approvals" or "/debtors/<uuid>" exactly (uuid regex, case-insensitive); anything else ⇒ "/approvals". */
export function parseReturnTo(raw: string): ReturnTarget;
```

In `actions.ts` (no new decision logic):

- `finish(notice, override, target: ReturnTarget = "/approvals", buyerId: string | null = null)`: `revalidatePath("/approvals")`; if `buyerId` then `revalidatePath(`/debtors/${buyerId}`)`; builds the same `today`/`notice`/`label`/`n` params and redirects to `` `${target}?${params}` ``.
- `decide()` reads `parseReturnTo(field(form, "returnTo"))`, and inside `withSupplier` looks up `getDraftForSupplier(db, supplierId, draftId)` (only for a uuid draftId) to get `buyerId` (null when the Draft isn't this supplier's). The `redraftIn` invalid-language branch does the same. `checkLadderNow` is unchanged (Req 7.8).
- `DraftCard` gains `returnTo?: string`; `HiddenFields` adds `<input type="hidden" name="returnTo">` only when it is set. `/approvals` passes nothing, so its forms are byte-identical to today.

### Tombstone link

```ts
// lib/debtor/href.ts
export function debtorHref(buyerId: string, invoiceId: string, override: CalendarDate | null): string;
// "/debtors/<b>#invoice-<i>" or "/debtors/<b>?today=<override>#invoice-<i>"
```

`Tombstone` renders `<li><a className={styles.article} href={debtorHref(...)} aria-label={view.ariaLabel} data-state>…</a></li>`; `tabIndex` is removed, so there is one tab stop (Req 3.4). The plaque stays inside the link; existing focus-visible styles move to the `<a>`. `TombstoneGrid` and `(app)/page.tsx` pass `override` (the Graveyard's `resolveToday` override). `buildGraveyard` copies `record.buyerId` onto a new `TombstoneView.buyerId` field (Req 3.5); no other builder change.

### Page and components

- **Page**: heading = buyer name; Demo_Date_Chip when `override !== null` (reuse the dashboard chip markup); notice from `noticeMessage(searchParams)` with `role` status/alert (Req 7.6); Invoice_Panels; "Waiting for your approval" with `DraftCard item override returnTo={`/debtors/${buyerId}`}` or "No drafts waiting for this buyer" (Req 7.1–7.2, 7.5); Candle_Timeline. No Debtor_Invoice ⇒ "No invoices for this buyer on this date" + link to `/` (Req 4.7). Footer comes from `AppShell` (Req 4.8).
- **InvoicePanel** (`<section id={panelId}>`): invoice number, `principalText`, `Due <dueDateText> · MSMED-15`, overdue text, `Interest <text> · MSMED-16` or `bankRateMissingText(today)` (existing helper; not for `not_covered`), state text + `stateRuleId`, caveat badge (same `CAVEAT_TEXT`), `nextLabel`, promise text, placeholders. Mirrors the tombstone plaque rules (Req 4.2, 4.3, 4.6). `scroll-margin-top` ≥ App_Shell header height so the hash target isn't covered (Req 9.4). The browser's native fragment scroll does the rest; an unknown fragment matches nothing and the page stays at the top (Req 9.5).
- **PlaceholderActions**: `<button type="button" disabled aria-describedby="pay-<id>">Send pay link</button><span id="pay-<id>">Arrives with WhatsApp</span>`, same for "Start call" / "Arrives with voice call". No handler or action (Req 8). Disabled text uses secondary `#A9A497` on the ground, no opacity, so it keeps 4.5:1 (Req 9.3).
- **CandleTimeline**: `<ol>`; each `<li data-kind data-lit data-tone>` holds an `aria-hidden` candle span and text spans for date, text and invoice number (Req 5.7). Flicker keyframes sit inside `@media (prefers-reduced-motion: no-preference)`; lit/unlit/tone are static colours, so reduce keeps them (Req 5.8). Colours: bone `#ECE7DB`, spectral `#7CE8C0`, ember `#FF8A3D`, flame glow moonlight `#F3EBD3` (Req 9.1). No canvas or WebGL.
- **DebtorLoadError**: fixed text and a "Try again" link to `/debtors/<id>` plus `?today=<override>` when set (Req 1.6). `(debtor)/error.tsx` is the render backstop with the same fixed text; it builds the retry link from `usePathname()` and the `today` query value.

## Data Models

No schema change and no migration. New TypeScript shapes only: `GraveyardInvoiceRecord.buyerId/invoiceDate`, `DraftWithContext.buyerId`, `TombstoneView.buyerId`, `DebtorData`, `DebtorEventRow`, `DebtorPromiseRow`, `DebtorView`, `InvoicePanelView`, `TimelineEntry`, `ReturnTarget` (all above). Money stays integer paise (`Paise`); dates stay `CalendarDate` strings as stored (`occurred_on`, `recorded_on`, `promised_date`, `paid_on`, `invoice_date` are `date` columns in string mode).

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

Properties apply to the pure parts only: the Engine helpers, `buildDebtorView`, `buildCandleTimeline`, `debtorHref` and `parseReturnTo`. Rendering, routing and DB scoping are covered by example and integration tests below.

### Property 1: hasActivePromise matches the wisp rule

*For any* Escalation_History (empty, no promise events, or several promise events mixed with step events) and *any* Calendar_Date `today`, `hasActivePromise(history, today)` equals `history.some(e => e.kind === "promise" && e.promisedDate >= today)`, the reference written inside the test.

**Validates: Requirements 6.1, 6.5**

### Property 2: activePromiseUntil agrees with hasActivePromise and is the latest active date

*For any* history and `today`, `activePromiseUntil(history, today) !== null` equals `hasActivePromise(history, today)`, and when non-null it equals the maximum `promisedDate` among promise events with `promisedDate >= today`.

**Validates: Requirements 6.6, 10.6**

### Property 3: Wisp is "unpaid and active promise"

*For any* `TombstoneLookInput`, `tombstoneLook(input).wisp` equals `!input.paid && hasActivePromise(input.history, input.today)`.

**Validates: Requirements 6.2**

### Property 4: Panels equal the graveyard's tombstones for that buyer

*For any* generated set of records over several buyers, Bank_Rate (or null) and `today`, and *any* buyer in the set, the `tombstone` fields of `buildDebtorView(...).panels` (built from that buyer's records only) equal, in order, the tombstones of `buildGraveyard` over the full set filtered to that buyer, with `look.heightPx` excluded from the comparison.

**Validates: Requirements 4.1, 4.4**

### Property 5: Timeline membership and date exclusion

*For any* generated Debtor_Invoices, events, promise rows and `today`, `buildCandleTimeline` returns exactly one `invoice` entry per invoice, one `due` entry per invoice with a non-null Engine due date (whatever its date), and one `ladder`, `promise` and `payment` entry per source row or paid invoice whose date is on or before `today`, and no other entry.

**Validates: Requirements 5.1, 5.2**

### Property 6: Timeline order is total and input-order independent

*For any* timeline input and *any* permutation of its `events`, `promises` and `records`, the output is identical, and every adjacent pair is ordered by `date`, then kind rank (`invoice < due < ladder < promise < payment`), then `rowId` by code unit.

**Validates: Requirements 5.3**

### Property 7: Candle look encodes data

*For any* timeline entry produced for `today`, `lit === (entry.date <= today)`; `tone` is `spectral` for `promise` and `payment`; for `due`, `tone` is `ember` iff `today > entry.date` and the invoice is not `resurrected`; otherwise `tone` is `bone`.

**Validates: Requirements 5.6**

### Property 8: Tombstone link shape

*For any* uuid `buyerId`, uuid `invoiceId` and override (null or a valid demo date), `debtorHref` equals `/debtors/<buyerId>#invoice-<invoiceId>` when the override is null and `/debtors/<buyerId>?today=<override>#invoice-<invoiceId>` otherwise.

**Validates: Requirements 3.1, 3.2, 3.3**

### Property 9: returnTo allowlist

*For any* string `s`, `parseReturnTo(s)` is `s` when `s === "/approvals"` or `s` is `/debtors/` followed by exactly one uuid and nothing else, and `"/approvals"` otherwise. Generators mix valid targets, valid targets with a suffix (`?x`, `#x`, `/x`, `//`), protocol-relative and absolute URLs, and random strings.

**Validates: Requirements 7.4, 10.5**

### Property 10: Buyer's Drafts keep the queue order

*For any* list of `DraftWithContext` across several buyers, `buildDebtorView(...).drafts` is the order-preserving subsequence of that list whose `buyerId` is the page's buyer and whose invoice is a Debtor_Invoice.

**Validates: Requirements 7.1**

## Error Handling

Mirrors dashboard-ui. `redirect()` and `notFound()` are always called outside `try`.

| Condition | Detected by | Result |
|---|---|---|
| No `supplierId` | proxy matcher; `(debtor)/layout.tsx`; page | 307 → `/signin` (Req 1.1) |
| Stale_Session | `getSupplier` throws `SupplierNotFoundError` (first loader step) | 307 → `/signin?error=SessionExpired`; `proxy.ts` clears the cookie as today (Req 1.4) |
| `id` not a uuid | uuid regex, before any buyer query | `notFound()` → root `not-found.tsx`, 404 (Req 1.3) |
| Unknown buyer / other supplier's buyer | `getDebtorData` returns `null` | same 404, same markup (Req 1.3) |
| No Bank_Rate effective | `BankRateNotFoundError` | page renders; panel shows `bankRateMissingText(today)` (Req 4.6) |
| `getDb()` or any read throws, Engine `ValidationError` while building | loader catch | `DebtorLoadError` with fixed text and retry link; details to `console.error` only (Req 1.6) |
| Unexpected render error | `(debtor)/error.tsx` | fixed text, retry to the same path; error prop never read |
| Action with bad `returnTo` | `parseReturnTo` | redirect to `/approvals` (Req 7.4) |
| Unknown `#invoice-…` fragment | browser | no scroll, no error (Req 9.5) |

The 404 and stale cases return HTTP 404 and 307 because the `(debtor)` group has no Suspense boundary above the page (see Overview).

## Testing Strategy

Vitest for unit, component and property tests; fast-check (≥ 100 runs each, `numRuns: 100` minimum) for the Properties above. Each property test is one `it` tagged `// Feature: debtor-ui, Property <n>: <title>`. Engine generators reuse `packages/engine/test/arbitraries.ts`. Every test task is required; none is optional (Req 10.9).

| File | What it covers |
|---|---|
| `packages/engine/test/promise.property.test.ts` | Properties 1, 2 (Req 6.5, 10.6) |
| `packages/engine/test/promise.test.ts` | day before → false, same day → true, day after → true; empty history; exports from `index.ts` (Req 10.6) |
| `apps/web/test/graveyard-look.property.test.ts` | Property 3 added |
| `packages/db/test/debtor.test.ts` (pglite) | `getDebtorData` returns only the supplier's buyer rows, all event actions, `null` for another supplier's buyer and an unknown uuid; `listGraveyardInvoices` returns `buyerId`/`invoiceDate`; `DraftWithContext.buyerId` (Req 1.5, 3.5) |
| `apps/web/test/debtor-view.property.test.ts` | Properties 4, 10 |
| `apps/web/test/candle-timeline.property.test.ts` | Properties 5, 6, 7 |
| `apps/web/test/candle-timeline.test.ts` | exact `toEqual` Sharma Traders timeline at `2026-11-12`: `[{kind:"invoice", date:"2026-09-02", text:"Invoice LPC/26-27/0412 raised for " + formatINR(41200000,"full")…}, {kind:"due", date:"2026-10-17", text:"Due date (MSMED-15)"…}]`; the mixed fixture with future `ladder`/`promise`/`payment` (excluded), future `due` (kept) and same-date different kinds (Req 10.2) |
| `apps/web/test/debtor-view.test.ts` | exact Sharma Traders panel at `2026-11-12` with demo Bank_Rate: `LPC/26-27/0412`, `41200000`, `2026-10-17`/`MSMED-15`, `26`, `512794`/`MSMED-16`, `armed`, `139`, `IT-43BH`, "Next: WhatsApp nudge"; displayed amounts equal `formatINR(<literal>, "full")` (Req 10.1); promise-until text (Req 6.4) |
| `apps/web/test/debtor-load.test.ts` | loader: stale first for any id, non-uuid ⇒ `not_found` with no buyer query, `null` ⇒ `not_found`, thrown read ⇒ `error` with override; demo override honoured, other supplier gets IST date and `override: null` (Req 10.3, 10.4) |
| `apps/web/test/debtor-page.test.tsx` | signed-out → `/signin`; stale → `/signin?error=SessionExpired`; three 404 cases call `notFound` and render no buyer name; error view retry href and no error text; Demo_Date_Chip and `today` hidden fields; no chip/field for others; notice roles; empty states; placeholders `disabled` with `aria-describedby` texts and absent on resurrected; `returnTo` hidden field; `<ol>` timeline with `aria-hidden` candles (Req 10.3, 10.4, 10.7, 4.7, 7.2, 7.6, 8) |
| `apps/web/test/return-to.property.test.ts` | Property 9 |
| `apps/web/test/approvals-actions.test.ts` | with `redirect`/`revalidatePath` mocked: `/debtors/<uuid>` followed with `notice`, `label`, `n`, `today` kept; missing, `//evil.example`, `https://evil.example`, `/debtors/not-a-uuid`, `/` ⇒ `/approvals`; revalidates `/approvals` and `/debtors/<buyerId>` (Req 10.5, 7.7); existing `approvals-page.test.tsx` unchanged (Req 7.8) |
| `apps/web/test/graveyard-components.test.tsx` | each Tombstone is one `<a>` with `href` `/debtors/<buyerId>#invoice-<id>`, with `?today=` under an override, same `aria-label` (Req 10.7, 3.4); Property 8 in `debtor-href.property.test.ts` |
| `apps/web/test/lint.test.ts`, `money-lint.test.ts` | extended to `lib/debtor/**`, `components/debtor/**`, `app/(debtor)/**`: no float money ops (Req 4.5), no inline active-promise check (Req 6.3), no `<canvas>`/three/WebGL (Req 9.1), flicker keyframes only inside `prefers-reduced-motion: no-preference` (Req 5.8) |

### Playwright smoke test (Req 10.8)

Playwright isn't installed yet. This spec adds:

- `apps/web/package.json`: dev dependency `@playwright/test`; script `"e2e": "playwright test"`. Not part of `test`, so `pnpm test` and CI stay DB-free.
- `apps/web/playwright.config.ts`: `testDir: "e2e"`, one Chromium project, `baseURL: "http://localhost:3000"`, `webServer: { command: "pnpm build && pnpm start", url: "http://localhost:3000", reuseExistingServer: true }`. The `*.spec.ts` name keeps it out of Vitest's `**/*.test.ts` include.
- `apps/web/e2e/debtor-smoke.spec.ts`: sign in with "Enter the graveyard (demo)", open `/?today=2026-11-12`, click the Sharma Traders tombstone, assert the URL matches `/debtors/<uuid>?today=2026-11-12#invoice-<uuid>` (ids read from the clicked link's `href`), and that the page shows "Sharma Traders", `LPC/26-27/0412`, `formatINR(41200000, "full")`, "Overdue 26 days, interest accruing", `formatINR(512794, "full")` and "Tax bomb armed: 139 days left to 31 March" (expected amounts computed by importing the Engine `formatINR`).

Run against a demo-seeded database (env from `apps/web/.env.local`: `DATABASE_URL`, `AUTH_SECRET`):

```
pnpm --filter @dues-banshee/db db:reset-demo -- --yes   # fresh demo seed (destructive; demo DB only)
pnpm --filter web exec playwright install chromium       # first run only
pnpm --filter web e2e
```

### Manual checks

Contrast of disabled buttons and descriptions, 44 × 44 targets, no horizontal scroll at 360 px and 1920 px, no decoration over text, fragment scroll clears the header (Req 9.2–9.4).
