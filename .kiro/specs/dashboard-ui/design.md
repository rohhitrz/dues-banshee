# Design Document: dashboard-ui

## Overview

The Graveyard of Dues is a server-rendered page at `/` in `apps/web`. It loads one supplier's invoices from `packages/db`, sends them through one pure function, `buildGraveyard`, that calls only Engine functions, and renders the resulting view model as tombstones plus a totals bar. No legal maths, date maths or money formatting is written in `apps/web`.

Key decisions:

| Decision | Choice | Why |
|---|---|---|
| Rendering | React Server Component; no client JS on `/` except the sign-out form (a server action) | All data is known at request time; nothing on the page is interactive besides links and focus. |
| Today | `resolveToday(nowMs, rawQuery)` called in the page with `Date.now()` | Keeps the clock at one server-only call site; the resolver itself is pure (Req 4.6). |
| Styling | CSS Modules (`*.module.css`), fonts through `next/font/google` | CSS Modules are what `apps/web` already uses (Req 9.9). `next/font` ships with Next, so there is **no new dependency**, and the fonts are self-hosted at build time (no runtime Google request). |
| Tombstone look | Pure `tombstoneLook()` with ordinal (rank) height, bucketed moss | Satisfies "larger principal is not shorter" with no float division of money (Req 3.5, 5.11). |
| Missing supplier / bank rate | Typed errors `SupplierNotFoundError`, `BankRateNotFoundError` in `packages/db` | The page must tell "stale session" and "no bank rate" apart from "DB is down" without matching error strings. |
| Stale-session cookie clearing | The page redirects once to `/signin?error=SessionExpired`; `proxy.ts` deletes the Auth.js session cookie on that request, before the Auth.js `auth()` wrapper runs | Server Components cannot write cookies in Next.js; the proxy can. The wrapper would re-set the cookie, so the clearing bypasses it. One redirect, no loop (see Decisions 3 and 4). |

New dependencies: none.

## Architecture

```mermaid
flowchart LR
  B[Browser GET /?today=…] --> P[proxy.ts<br/>JWT decode only]
  P -- no supplierId --> S[/signin]
  P -- supplierId --> G["app/(app)/page.tsx<br/>Graveyard_Page"]
  G --> T[resolveToday nowMs, today]
  G --> L[loadGraveyardData<br/>lib/graveyard/load.ts]
  L --> DB[(packages/db<br/>getSupplier · getBankRate ·<br/>listGraveyardInvoices)]
  L -- SupplierNotFoundError --> R[redirect /signin?error=SessionExpired]
  L -- other error --> E[LoadError view<br/>retry link]
  L -- ok --> BG[buildGraveyard<br/>pure]
  BG --> EN[packages/engine<br/>dueDate · statutoryInterest ·<br/>taxBomb · nextEscalationStep · formatINR]
  BG --> V[Graveyard_View] --> UI[Totals · TimeTravel · Tombstones]
```

Request flow for `/`:

1. `proxy.ts` (matcher now includes `/` and `/signin`) redirects signed-out requests to `/signin` (Req 1.1). The existing `app/(app)/layout.tsx` redirect stays as a second guard.
2. The page reads `session.supplierId` from `auth()` only (Req 2.1), awaits `searchParams.today`, and calls `resolveToday(Date.now(), today)`.
   - Clock and prerendering (Next.js 16.4.6): `apps/web/next.config.ts` sets only `transpilePackages`. It does not enable `cacheComponents`, `experimental.ppr`, `experimental.dynamicIO` or `output: "export"`, and no route in `apps/web/app` exports `dynamic`/`revalidate` except `(site)/signin/page.tsx` (`force-dynamic`). Without `cacheComponents`, `/` is rendered per request because it calls `auth()` (reads cookies) and awaits `searchParams`, both dynamic APIs; so `Date.now()` runs per request and Today is never the build date. `await connection()` from `next/server` is therefore **not** added. If `cacheComponents` is ever turned on, the page SHALL call `await connection()` before `Date.now()`.
3. `loadGraveyardData(db, supplierId, today)` returns a discriminated result: `{ kind: "ok", supplier, bankRate | null, records }`, `{ kind: "stale" }` or `{ kind: "error" }`. `redirect()` is called **outside** the `try` block, because it throws `NEXT_REDIRECT`.
   - `getBankRate` is awaited in its own `try`/`catch`: `BankRateNotFoundError` (checked with `instanceof`) maps to `bankRate = null` and loading continues to an `ok` result. Any other error from `getBankRate` is rethrown into the outer catch, which returns `{ kind: "error" }`. So the no-bank-rate case always renders the Graveyard and never the LoadError view or `error.tsx` (Req 2.5, 11.3). `getBankRate` is called with the already-validated Today, so its separate invalid-date throw (`packages/db/src/bank-rate.ts` line 16; the no-row throw at line 24 becomes `BankRateNotFoundError`) is unreachable from this page.
4. `buildGraveyard(supplier, records, bankRate, today)` returns the Graveyard_View; components render only fields of it (Req 2.4).

### Route and file map

```
apps/web/
  app/layout.tsx                    root layout: fonts + <AppShell> (wraps every page, incl. /signin, not-found)
  app/not-found.tsx                 themed Not_Found_Page, link to /            (Req 1.5)
  app/(app)/page.tsx                Graveyard_Page at "/"                       (Req 1–8)
  app/(app)/error.tsx               backstop for render errors, fixed text only (Req 11)
  app/(app)/import/…                restyle only                                 (Req 9.6–9.7)
  app/(site)/signin/…               restyle; actions.ts redirectTo "/"; messages.ts adds SessionExpired
  components/app-shell.tsx (+ .module.css, sign-out-action.ts)
  components/graveyard/{totals-bar,time-travel,tombstone,graveyard-scene,load-error}.tsx (+ .module.css)
  lib/graveyard/build-graveyard.ts  pure Graveyard_Builder
  lib/graveyard/labels.ts           STEP_TEXT, WAIT_TEXT, stateText, nextStepLabel
  lib/graveyard/look.ts             tombstoneLook (height rank, moss, cracks, ember, wisp)
  lib/graveyard/today.ts            resolveToday, formatDisplayDate, TIME_TRAVEL_PRESETS
  lib/graveyard/load.ts             loadGraveyardData (the only DB caller for "/")
  proxy.ts                          matcher + /signin SessionExpired cookie clearing
packages/db/src/
  graveyard.ts                      listGraveyardInvoices (new, read-only)
  errors.ts                         SupplierNotFoundError, BankRateNotFoundError (new)
```

Note: `structure.md` lists the dashboard under `app/(app)/graveyard`. Requirement 1 puts it at `/`, so the page is `app/(app)/page.tsx` (a route group does not add a path segment). The proxy matcher keeps `/graveyard/:path*`, which now has no route and renders the Not_Found_Page.

## Components and Interfaces

### packages/db additions

```ts
// errors.ts — subclasses keep the existing messages, so current db tests (toThrow(/…/)) still pass.
export class SupplierNotFoundError extends Error {}   // thrown by getSupplier
export class BankRateNotFoundError extends Error {}   // thrown by getBankRate when no row is effective

// graveyard.ts
export interface GraveyardInvoiceRecord {
  invoice: Invoice;                 // toEngineInvoice(invoiceRow, supplierRow)
  buyerName: string;
  invoiceNumber: string;
  history: EscalationHistory;       // StepEvent from escalation_events, PromiseEvent from promises
}
export function listGraveyardInvoices(db: Db, supplierId: string): Promise<GraveyardInvoiceRecord[]>;
```

`listGraveyardInvoices` runs three reads, each filtered by `invoices.supplier_id = supplierId`: invoices ⋈ buyers (on the composite `(buyer_id, supplier_id)` key) ⋈ suppliers; `escalation_events` ⋈ invoices; `promises` ⋈ invoices. The join through `invoices` on `supplier_id` is what keeps other suppliers' rows out (Req 2.3). History is ordered so output is deterministic: step events by `occurred_on` then `id`, promises by `recorded_on` then `id`. All three are exported from `packages/db/src/index.ts`.

### Today_Resolver (`lib/graveyard/today.ts`)

```ts
export const DEMO_MIN = "2024-01-01"; export const DEMO_MAX = "2027-12-31";
export interface ResolvedToday { today: CalendarDate; override: CalendarDate | null }
export function resolveToday(nowMs: number, raw: string | string[] | undefined): ResolvedToday;
export function istDate(nowMs: number): CalendarDate;      // fromEpochDay(Math.floor((nowMs + 19_800_000) / 86_400_000))
export function formatDisplayDate(d: CalendarDate): string; // "2027-03-10" → "10 Mar 2027", string slicing only
export const TIME_TRAVEL_PRESETS: readonly { label: string; today: CalendarDate | null }[];
```

- `raw` array → first element only (Req 4.5).
- Accept iff `/^\d{4}-\d{2}-\d{2}$/` matches, `isValidCalendarDate` (Engine) is true and `DEMO_MIN ≤ raw ≤ DEMO_MAX` (string comparison is valid for this fixed format). Otherwise `{ today: istDate(nowMs), override: null }` (Req 4.3–4.4).
- `istDate` uses Engine `fromEpochDay`; the offset arithmetic is on milliseconds, not money.
- Time_Travel_Control marks exactly one preset with `aria-current="page"`: "Today" when `override === null`, otherwise the preset whose date equals `override` (none if the override is another valid date).

### Graveyard_Builder (`lib/graveyard/build-graveyard.ts`)

```ts
export function buildGraveyard(
  supplier: Supplier,
  records: readonly GraveyardInvoiceRecord[],
  bankRate: BankRate | null,
  today: CalendarDate,
): GraveyardView;
```

Per record with `acceptedOn ≤ today` (Req 3.7):

1. `due = dueDate(invoice)`; `bomb = taxBomb(invoice, today)`; `next = nextEscalationStep(invoice, history, today)`.
2. `interest = statutoryInterest(invoice, today, bankRate ?? { annualBps: 0, asOf: DEMO_MIN })`. With no Bank_Rate the call is still made with a zero placeholder so that `accrualDays` comes from the Engine (Req 3.2); its `interestPaise` is discarded and the view's interest is `null`, shown as "Bank rate not configured for <Today>". The placeholder is `annualBps: 0` because the Engine accepts 0: `validateBankRate` rejects only non-integers, values `< 0` and values `> 5000` (`packages/engine/src/validate.ts` lines 119–124; `types.ts` line 27 documents "Integer 0..5000"), and `compoundInterestPaise` returns 0 for `annualBps === 0` (`statutory-interest.ts` line 23) while `accrualDays` is computed independently of the rate (line 70). `asOf: DEMO_MIN` is a valid Calendar_Date, so the placeholder never raises a `ValidationError`.
3. `paid = invoice.paidOn !== undefined && invoice.paidOn <= today`.
4. State by precedence (Req glossary): `paid → resurrected`; `!due.applicable → not_covered`; `today <= due.dueDate → not_due`; `bomb.status === "exploded" → exploded`; `"armed" → armed`; else `overdue`.
5. `daysOverdue = paid || !interest.applicable ? 0 : interest.accrualDays`.
6. Labels from `labels.ts`, look from `look.ts`, money text from `formatINR(paise, "full")`.

Then sort (below), compute Totals, and return a fresh object. No input is mutated (records are read, never sorted in place).

Totals use plain integer addition over the filtered views and assert `Number.isSafeInteger` on each sum (throws otherwise; unreachable below ~900 invoices at `MAX_PAISE`).

### Sort comparator

```ts
const GROUP: Record<TombstoneState, number> =
  { armed: 0, exploded: 1, overdue: 1, not_due: 2, not_covered: 3, resurrected: 4 };
// primary key within group: armed → daysLeft asc; exploded/overdue → daysOverdue desc; not_due → dueDate asc
// tie-break: daysOverdue desc, invoiceNumber asc, id asc — via (a < b ? -1 : a > b ? 1 : 0), never localeCompare
```

Ids are unique, so the comparator is a total order and the result is independent of input order (Req 6.6).

### Labels (`lib/graveyard/labels.ts`)

```ts
export const STEP_TEXT = { whatsapp_nudge: "WhatsApp nudge", whatsapp_paylink: "WhatsApp + UPI link",
  voice_call: "Voice call", legal_notice: "Legal notice", odr_pack: "MSME ODR pack" } as const satisfies Record<LadderStep, string>;
export const WAIT_TEXT = { paid: "Paid", not_overdue: "Not due yet", promise_active: "Promise to pay active",
  cooldown: "Gap since last step", ladder_complete: "All steps done",
  medium_or_unregistered: "Not a Udyam micro/small supplier", trader: "Trader, outside MSMED" } as const satisfies Record<WaitReason, string>;
export function nextStepLabel(d: EscalationDecision): string; // "Next: …" | "Waiting: …"
export function stateText(v: { state; daysLeft; nonCoverageReason }): string; // Req 5.3 texts
```

A missing key fails `tsc` (Req 5.9). `not_covered` text is `Outside MSMED (<WAIT_TEXT[reason]>)`.

### Look (`lib/graveyard/look.ts`)

```ts
export interface TombstoneLook { heightPx: number; moss: 0 | 1 | 2 | 3 | 4; cracked: boolean; ember: boolean; wisp: boolean }
export function heightsByRank(principals: readonly Paise[]): number[]; // 130 + floor(170 * rank / max(1, distinct - 1))
export function mossLevel(days: number): 0|1|2|3|4;                   // 0 | 1–15 | 16–45 | 46–90 | >90
```

- Height: rank of the principal among the **distinct** principals in the view (ties get equal height). Integer comparison of paise only; no division of money.
- `cracked = daysOverdue > 60`; `ember = daysOverdue > 45`.
- `wisp = !paid && history.some(e => e.kind === "promise" && e.promisedDate >= today)` (Req 5.12, taken literally).

### Page components

- **AppShell** (server): calls `auth()`. With `supplierId`: nav links "Graveyard" `/`, "Import" `/import`, and a `<form action={signOutAction}>` button "Sign out" (`signOut({ redirectTo: "/signin" })`). Always: footer "Reminders a supplier sends to its own buyers. Not legal advice." (Req 9.1–9.4).
- **TotalsBar**: four cards. Outstanding (`formatINR` short, full beneath), Interest_Accrued with `MSMED-16` or the bank-rate message, Deductions_At_Risk with `IT-43BH`, and a counts card "Exploded N · Resurrected N". Also "Rules as of D MMM YYYY" or "Bank rate not configured for D MMM YYYY" (Req 3.8–3.9, 7).
- **TimeTravel**: three `<Link>`s to `/`, `/?today=2027-03-10`, `/?today=2027-04-01`; the Demo_Date_Chip appears only when `override !== null` (Req 4.7–4.9).
- **Tombstone**: `<li><article tabIndex={0} aria-label=…>`; the stone face (R.I.P., height, moss, cracks, ember, wisp; all decorative children `aria-hidden`) above a plaque with buyer, invoice number, principal, "Due D MMM YYYY · MSMED-15", "Overdue N days", interest "· MSMED-16", state text with its rule id, the caveat badge, and the Next_Step_Label. No buttons (Req 5.6). Not-covered tombstones show no due date and no interest, because those figures have no rule ID that applies (Req 5.10).
- **GraveyardScene**: moon, stars, trees, fence, bats, fog. All `aria-hidden`, `pointer-events: none`, placed in a layer behind the tombstone grid (`z-index` below), and fog sits only in the ground strip below the plaques (Req 10.6).
- **LoadError**: "We couldn't load your graveyard just now. Please try again." plus a retry link to `/` (with `?today=<raw>` URL-encoded when one was given). Renders no error data (Req 11.1–11.2).
- **Empty state**: "The graveyard is quiet" + link "Import invoices" → `/import`; Totals and TimeTravel still render (Req 8).

### Proxy (`proxy.ts`)

```ts
export const config = { matcher: ["/", "/signin", "/import/:path*", "/graveyard/:path*", "/debtor/:path*", "/api/import/:path*"] };
```

The exported `proxy` is a plain function that checks first, then delegates:
1. `pathname === "/signin"` and `searchParams.get("error") === "SessionExpired"`: return the cookie-clearing `NextResponse.next()` directly, WITHOUT calling the `auth()`-wrapped handler. The response has the request cookie header stripped of, and response `Set-Cookie` expiring, every cookie matching `/^(__Secure-)?authjs\.session-token(\.\d+)?$/` (Auth.js chunks large tokens).
2. Every other request goes to `auth(proxyHandler)` unchanged. In `proxyHandler`:
   1. `pathname === "/signin"`: never redirect, pass through.
   2. `req.auth?.supplierId` present: pass through.
   3. `/api/*`: 401 JSON. Else redirect to `/signin`.

Why the bypass: with `next-auth@5.0.0-beta.32` the `auth()` wrapper appends its own session `Set-Cookie` after the handler's response, and `@auth/core` re-encodes a JWT that is still valid. Clearing inside the wrapped handler therefore sent an expiring cookie followed by a fresh one, and the session survived. The check in `proxy` runs before the wrapper, so nothing is appended after the expiring cookies.

`proxyHandler` is exported so tests can call it with a fake request. `next/server` is a bare package and passes the existing ESLint allowlist; it imports no DB code (Decision 4, Req 1.6).
### Sign-in changes

- `actions.ts`: `redirectTo: "/"` (Req 1.7). Error branches unchanged.
- `messages.ts`: `SESSION_EXPIRED_ERROR = "SessionExpired"` → "The demo was reset. Enter the graveyard again." Other values keep their current messages.
- `page.tsx`: markup wrappers and class names only.

## Data Models

```ts
type TombstoneState = "resurrected" | "not_covered" | "not_due" | "exploded" | "armed" | "overdue";

interface TombstoneView {
  id: string; buyerName: string; invoiceNumber: string;
  principalPaise: Paise; principalText: string;            // formatINR(p, "full")
  state: TombstoneState; stateText: string;
  stateRuleId: "IT-43BH" | "MSMED-SCOPE" | null;
  dueDate: CalendarDate | null; dueDateText: string | null; // null when not_covered
  daysOverdue: number;
  interest: { paise: Paise; text: string } | null;          // null: no bank rate or not_covered
  taxBomb: { status: TaxBombStatus; daysLeft: number; deductionAtRiskPaise: Paise } | null;
  caveat: Caveat | null;
  next: { action: "advance"; step: LadderStep } | { action: "wait"; reason: WaitReason };
  nextLabel: string;
  look: TombstoneLook;
  ariaLabel: string; // "<buyer>, <principalText>, <days> days overdue, <stateText>"
}

interface GraveyardTotals {
  outstandingPaise: Paise; interestAccruedPaise: Paise | null; deductionsAtRiskPaise: Paise;
  explodedCount: number; paidCount: number;
}

interface GraveyardView {
  supplierName: string; today: CalendarDate;
  rulesAsOf: CalendarDate | null;
  tombstones: readonly TombstoneView[];
  totals: GraveyardTotals;
}
```

Expected demo values at Today `2026-11-12`, bank rate 575 bps as of `2026-10-07` (checked against the Engine while writing this design):

| Invoice | Due | Days | Interest (paise) | Tax bomb | State | Next |
|---|---|---|---|---|---|---|
| Kumar `LPC/26-27/0301` | 2026-08-16 | 88 | 1026125 | armed, 139 | armed | whatsapp_nudge |
| Sharma `LPC/26-27/0412` | 2026-10-17 | 26 | 512794 | armed, 139 | armed | whatsapp_nudge |
| Bansal `LPC/23-24/0098` | 2024-03-31 | 956 | 3167411 | exploded | exploded, caveat | whatsapp_nudge |
| Mehta `LPC/25-26/0388` | 2026-05-04 | 192 | 1530351 | exploded | exploded | whatsapp_nudge |
| Gupta `LPC/26-27/0466` | 2026-11-16 | 0 | 0 | armed, 139, at risk 18500000 | not_due | wait not_overdue |
| Verma `LPC/26-27/0377` | 2026-09-09 | 0 | 0 | defused | resurrected | wait paid |

The table rows are in the expected sort order (Kumar and Sharma tie on 139 days left; Kumar has more Days_Overdue). Totals: Outstanding 105200000, Interest_Accrued 6236681, Deductions_At_Risk 83700000 (Sharma + Gupta + Kumar), Exploded_Count 2, Paid_Count 1.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

Generators reuse the Engine-valid invoice arbitraries style of `packages/db/test/arbitraries.ts`: micro/small/medium/unregistered suppliers, all activities, optional terms, optional `paidOn ≥ acceptedOn`, histories of steps and promises, optional bank rate, and `today` in 2024–2027.

### Property 1: Builder is deterministic and non-mutating

For any supplier, records, bank rate (or none) and today, two calls to `buildGraveyard` with structurally equal arguments return deeply equal views, and a deep snapshot of the arguments taken before the call equals the arguments after it.

**Validates: Requirements 3.1, 3.6**

### Property 2: Views agree with the Engine

For any inputs and any tombstone in the result, its due date, Days_Overdue, interest paise, tax-bomb status, days left, deduction at risk, caveat and next decision equal the values obtained by calling `dueDate`, `statutoryInterest`, `taxBomb` and `nextEscalationStep` directly on the same record, every money text equals `formatINR` of its paise value, every paise value is a safe integer, and the state is the first match in the precedence list.

**Validates: Requirements 3.2, 3.3, 3.4, 5.2, 5.3**

### Property 3: Sort order is a function of the set, not the input order

For any records and any permutation of them, `buildGraveyard` returns the same tombstone id sequence; and for every adjacent pair the group index is non-decreasing and, within a group, the primary key and tie-breaks of Requirement 6 are respected.

**Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6**

### Property 4: Totals are sums over the views

For any inputs, Outstanding equals the sum of `principalPaise` over non-`resurrected` views; Interest_Accrued equals the sum of `interest.paise` over `overdue`/`armed`/`exploded` views (or is `null` exactly when no bank rate is given); Deductions_At_Risk equals the sum of `deductionAtRiskPaise` over unpaid views with tax-bomb status `armed`; and the two counts equal the number of `exploded` and `resurrected` views.

**Validates: Requirements 7.1, 7.2, 7.3, 7.4, 2.5**

### Property 5: Future-accepted invoices are invisible

For any inputs and any extra record with `acceptedOn > today`, adding it leaves the view deeply equal to the view without it; a record with `acceptedOn === today` appears in the tombstones.

**Validates: Requirements 3.7, 8.1, 12.9**

### Property 6: Today_Resolver returns a valid date and falls back correctly

For any instant in 2023–2028 and any string (or string array, or undefined), `resolveToday` returns a valid `YYYY-MM-DD` date; it returns the first raw value with `override` set if and only if that value is a strict, real calendar date in 2024-01-01..2027-12-31; otherwise it returns `istDate(nowMs)` with `override: null`, and `istDate(nowMs)` equals the UTC date of `nowMs + 5h30m`.

**Validates: Requirements 4.1, 4.3, 4.4, 4.5**

### Property 7: Label maps are exhaustive and exact

For every `LadderStep` in `LADDER_STEPS` and every `WaitReason`, `nextStepLabel` of an advance (resp. wait) decision equals `"Next: " + STEP_TEXT[step]` (resp. `"Waiting: " + WAIT_TEXT[reason]`), and every text is non-empty.

**Validates: Requirements 5.7, 5.8, 5.9**

### Property 8: Tombstone look encodes the data monotonically

For any view, of two tombstones the one with the larger principal has `heightPx` greater than or equal to the other's; `moss` is 0 iff Days_Overdue is 0 and never decreases as Days_Overdue grows; `cracked` iff Days_Overdue > 60; `ember` iff Days_Overdue > 45; `wisp` iff unpaid on today with a promise dated on or after today.

**Validates: Requirements 5.11, 5.12**

### Property 9: Aria-label shape

For any tombstone view, `ariaLabel` equals `` `${buyerName}, ${principalText}, ${daysOverdue} days overdue, ${stateText}` ``, and `stateText` is one of the Requirement 5.3 forms.

**Validates: Requirements 10.3, 5.3**

## Error Handling

| Condition | Where detected | Result |
|---|---|---|
| No session `supplierId` | proxy, then `(app)/layout.tsx` | Redirect `/signin`; no data loaded. |
| `supplierId` not in DB | `getSupplier` throws `SupplierNotFoundError` | One redirect to `/signin?error=SessionExpired`; proxy clears the session cookie on that request; `/signin` shows the reset message and never redirects. |
| No bank rate on or before Today | `getBankRate` throws `BankRateNotFoundError` | `bankRate = null`; page renders, interest figures and Interest_Accrued show "Bank rate not configured for D MMM YYYY". |
| Any other DB error | `loadGraveyardData` catch | `console.error` server-side; `LoadError` rendered inside the shell with retry link; no Totals or tombstones. |
| Engine `ValidationError` from bad stored data | thrown inside `buildGraveyard` | Same as "any other error": `loadGraveyardData` wraps building too, so the page shows `LoadError`. |
| Unexpected render error | `app/(app)/error.tsx` | Fixed text + retry link; never reads `error.message` or `error.digest` into the markup. |
| Unknown route | `app/not-found.tsx` | Themed page with link to `/`. |
| Invalid `today` query | `resolveToday` | Silent fallback to the IST date, no chip. |

## Theme, Motion and Accessibility

- Colours and fonts from `ui-theme.md`: background gradient `#1B1530 → #0C0A14 → #07080B`, bone `#ECE7DB`, secondary `#A9A497`, spectral `#7CE8C0`, ember `#FF8A3D` (labels in `#FFB27A`), moonlight `#F3EBD3`. Fonts: Fraunces 300 (headings), IM Fell English / SC (signage, epitaphs), Inter (body), JetBrains Mono (figures), via `next/font/google` CSS variables in the root layout.
- Focus: `article:focus-visible { outline: 3px solid #7CE8C0; outline-offset: 3px }`. `#7CE8C0` on `#0C0A14` is far above 3:1 (Req 10.2).
- Contrast: all text uses bone, secondary, spectral or `#FFB27A` on backgrounds no lighter than `#221F2E`; each pair is ≥ 4.5:1. Text on the stone face is decorative ("R.I.P.") and duplicated in the plaque, so data text never sits on the stone gradient.
- Motion: keyframes `drift`, `wisp`, `flicker`, `bat`, `ember` only inside `@media (prefers-reduced-motion: no-preference)`. Under `reduce`, no animation or transition is declared at all, and the wisp renders as a static glow (Req 10.5).
- Layout: tombstone list is `grid-template-columns: repeat(auto-fill, minmax(150px, 1fr))`; totals grid 4 → 2 → 1 columns at 900 px and 480 px; decorative layers use `overflow: hidden` on the scene so nothing widens the page (Req 10.7).
- Targets: links, buttons and tombstones have `min-height: 44px; min-width: 44px` (Req 10.9).
- No `<canvas>`, WebGL or three.js on these pages (Req 10.8); decoration is inline SVG and CSS gradients.

## Deviations from /design/Main.dc.html

| Mock | Built | Why |
|---|---|---|
| Hard-coded buyers ("Mahto Agro", 71 days…) and in-browser float interest `o * (1 + r)^(late/30)` | Engine outputs for stored data | Req 3.2, 3.5; product rule: every legal figure comes from the Engine with a rule ID. |
| Stone height `130 + (max-130) * owed/top` (float division of money) | Rank-based height `130 + floor(170·rank/(distinct−1))` | Req 3.5 bans float division of money; rank keeps "taller = owes more" (Req 5.11). |
| Moss `min(1, days/90)` continuous | Five buckets (0, 1–15, 16–45, 46–90, >90) | Integer, testable, monotone; same visual meaning. |
| Ember dot hidden when promised; green dot for promise | Ember iff > 45 days; promise shown only as the wisp | Req 5.11–5.12 define each encoding independently. |
| Tilt on stones > 60 days | Not built | Rotation could push labels into neighbours; cracks already encode > 60 days. |
| Tombstones are buttons with `aria-pressed` that select a buyer | Focusable `<article tabIndex=0>`, no action | Selection drives the séance panel (debtor-ui, out of scope); Req 5.6 forbids escalation controls. |
| "Selected debtor" aside, "Hold the séance", "Send next haunting" | Not built | debtor-ui / escalation-ladder scope. |
| Nav: Séances, Invoices, Notices, voice button, "Wake the banshee", "Import CSV / Tally" | Graveyard, Import, Sign out | Req 9.1; other screens don't exist yet. |
| Totals: "Buried in dues", "Interest curse", "The tax bomb: 139 days", "Risen: ₹3.08L, 4 payments this month" | Outstanding, Interest_Accrued, Deductions_At_Risk, Exploded/Paid counts | Req 7 defines these totals; the mock's "this month" amount has no Engine source. Mock card titles are kept as headings. |
| Data only on the stone (amount, name, days) | Stone + plaque with invoice no., due date, interest, state, rule IDs, next step | Req 5.2–5.10 need more text than a stone holds; plaque keeps decoration away from numbers (Req 10.6). |
| Google Fonts `<link>` | `next/font/google` | Self-hosted, no layout shift, no runtime third-party request. |
| `min-height: 1180px`, fixed 4-column totals | Fluid layout 360–1920 px | Req 10.7. |
| Reduced motion: `animation: none !important` only | Animations declared only under `no-preference`; no transitions under `reduce` | Req 10.5 also covers transitions. |
| Added | Time_Travel_Control, Demo_Date_Chip, "Rules as of", empty state, legend entries for cracks and ember | Req 3.8, 4.7–4.9, 8; theme rule that every encoding is explained. |

## Testing Strategy

All tests are required; none are optional (Req 12.10). Vitest, `environment: "node"`, `renderToStaticMarkup` for components, `vi.mock` with `vi.hoisted` state, as in `test/signin.test.tsx` and `test/auth.test.ts`.

### Property tests (fast-check, one file per property in `apps/web/test/`)

- `fast-check` (`^4.10.2`) is already a root devDependency, so `apps/web` adds nothing.
- One file per property, so parallel tasks do not edit the same file:

  | Property | File |
  |---|---|
  | 1. Builder is deterministic and non-mutating | `test/graveyard-deterministic.property.test.ts` |
  | 2. Views agree with the Engine | `test/graveyard-engine.property.test.ts` |
  | 3. Sort order is a function of the set, not the input order | `test/graveyard-sort.property.test.ts` |
  | 4. Totals are sums over the views | `test/graveyard-totals.property.test.ts` |
  | 5. Future-accepted invoices are invisible | `test/graveyard-future.property.test.ts` |
  | 6. Today_Resolver returns a valid date and falls back correctly | `test/today.property.test.ts` |
  | 7. Label maps are exhaustive and exact | `test/labels.property.test.ts` |
  | 8. Tombstone look encodes the data monotonically | `test/graveyard-look.property.test.ts` |
  | 9. Aria-label shape | `test/graveyard-aria.property.test.ts` |

- One `fc.assert` per property above, `{ numRuns: 100 }` minimum.
- Each test is tagged: `// Feature: dashboard-ui, Property N: <title>`.

### Example tests (exact literals)

| File | Covers |
|---|---|
| `test/build-graveyard.test.ts` | Full Graveyard_View `toEqual` from `DEMO_SUPPLIER` + `DEMO_INVOICES` (ids are fixed strings in the test) at `2026-11-12`, values from the table above; Totals literals; order `["LPC/26-27/0301","LPC/26-27/0412","LPC/23-24/0098","LPC/25-26/0388","LPC/26-27/0466","LPC/26-27/0377"]`; Sharma `nextLabel` "Next: WhatsApp nudge"; no-bank-rate view; `acceptedOn` after Today excluded (Req 12.1–12.3, 12.9, 12.12). |
| `test/labels.test.ts` | Exact label for each of the 5 steps and 7 wait reasons (Req 12.12). |
| `test/today.test.ts` | Every input in Req 12.4 with injected `nowMs`, plus 18:29:59Z / 18:30:00Z boundary (Req 4.2). |
| `test/graveyard-page.test.tsx` | Mocks `@/auth`, `next/navigation`, `@/lib/db`, `@dues-banshee/db` reads. Signed-out → `redirect("/signin")` (Req 12.5); signed-in render contains the Sharma `LPC/26-27/0412` tombstone; `?today=2027-03-10` shows "Demo date: 10 Mar 2027"; no chip without `today` (Req 12.6); load failure with an error carrying message, stack and `select * from invoices` text → markup contains none of them and has a retry link to `/` (Req 12.7); `getBankRate` rejecting with `BankRateNotFoundError` → the markup contains the tombstone list and Totals, every interest slot and Interest_Accrued show "Bank rate not configured for 12 Nov 2026", the "Rules as of" line is replaced by the same text, the LoadError message "We couldn't load your graveyard just now" is absent, and the page function resolves without throwing (so `error.tsx` is never reached) (Req 12.8, 2.5, 11.3); `getBankRate` rejecting with a plain `Error` → LoadError (contrast case); two signed-in renders with no `today`, `Date.now` mocked (`vi.spyOn(Date, "now")`) to `2026-11-12T18:29:59Z` and then `2026-11-12T19:00:00Z`, call the mocked `getBankRate` with Today `2026-11-12` and `2026-11-13` respectively (and, with `getBankRate` rejecting `BankRateNotFoundError`, render "Bank rate not configured for 12 Nov 2026" and "…13 Nov 2026"), proving Today is read per request (Req 4.1, 4.2, 4.6); `SupplierNotFoundError` → `redirect` called exactly once with `/signin?error=SessionExpired` and no markup (Req 12.11). |
| `test/proxy.test.ts` | Uses the REAL `auth()` wrapper (`next-auth` is not mocked), a test `AUTH_SECRET` and a session JWT made with `encode()` from `next-auth/jwt` that carries a `supplierId`. Calls the exported `proxy` with real `NextRequest`s: `/signin?error=SessionExpired` with that valid cookie, a chunked `.0`/`.1` pair and the `__Secure-` name → every session-token `Set-Cookie` is expired and none has a value; `/` with the valid cookie → passes through (proves the real wrapper still decodes sessions); `/` with no cookie, or a cookie signed with another secret → redirect `/signin`; `/signin` with another error value → no cookie clearing. Calls `proxyHandler` with fake requests for `/signin` (no loop), `/` and `/api/import` (Req 12.11, 1.4). |
| `test/signin.test.tsx` (existing) | Only line 33 (success-redirect assertion) and the line-28 title change (Decision 2, Req 9.8). New cases for SessionExpired go in `test/signin-session-expired.test.tsx`. |
| `test/app-shell.test.tsx` | Links and Sign out present only with `supplierId`; footer always; sign-out action calls `signOut({ redirectTo: "/signin" })` (Req 9.1–9.4). |
| `test/not-found.test.tsx` | Link to `/`. |
| `test/money-lint.test.ts` | Greps `apps/web/lib/graveyard` and `components/graveyard` for `toFixed`, `parseFloat`, `Number(` (Req 3.5). |
| `packages/db/test/graveyard.test.ts` | `listGraveyardInvoices` returns the six demo records with history, and none of a second supplier's invoices, buyers, steps or promises (Req 2.3). |

Not unit-tested (manual check in the task list): contrast values, reduced-motion behaviour, 360 px layout, 44 px targets. These are CSS facts, checked once in the browser with DevTools.

Gate: `pnpm --filter web test`, `typecheck`, `lint` and `packages/db` tests pass with zero failures.

## Decisions

1. **Req 9.7 scope.** 9.7 applies to the restyle only. The `signInDemo` success target `/` (Req 1.7) and the SessionExpired message (Req 1.3) are exempt, as recorded in Req 9.7. Existing messages and error targets do not change.
2. **`test/signin.test.tsx`.** Exactly two lines change (Req 9.8): line 33 (`redirectTo: "/import"` → `redirectTo: "/"`) and the line-28 test title ("…lands on /import" → "…lands on /"). No other line changes. Line 54's `new Error("NEXT_REDIRECT /import")` mock stays: it is only a non-AuthError being rethrown.
3. **Redirect loops.** Prevented as designed: the proxy's `/signin` branch runs first and never redirects away from `/signin`; `/signin` never redirects signed-in users; a stale session costs exactly one redirect (`/` → `/signin?error=SessionExpired`), and the proxy clears the session cookie on that request, so the next visit to `/` is a plain signed-out redirect. The clearing happens in the exported `proxy` before the `auth()` wrapper, not inside the wrapped handler: the wrapper appends its own session `Set-Cookie` after the handler's response and re-encodes a still-valid JWT, which would undo the clearing. The `/signin` branch of `proxyHandler` therefore only passes through.
4. **`proxy.ts` imports.** Only `next-auth`, `next/server` (for `NextResponse`, needed to clear the cookie, since Server Components cannot write cookies) and `auth.config.ts` (Req 1.6). Side effect: opening `/signin?error=SessionExpired` signs the visitor out, which is harmless for the demo.
5. **`<Today>` display format.** "Bank rate not configured for <Today>" uses `D MMM YYYY` ("12 Nov 2026"), matching the Demo_Date_Chip and "Rules as of".
