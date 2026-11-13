# Implementation Plan: dashboard-ui

## Overview

TypeScript (strict), Next.js App Router, CSS Modules, Vitest + fast-check. Pure logic first (labels, Today_Resolver, look, `buildGraveyard`) with exact tests on the demo seed, then the `packages/db` read and typed errors, then proxy and sign-in changes, then the App_Shell, Graveyard_Page and route tests, then restyles. No new dependencies; no 3D, `<canvas>` or WebGL.

Every test task is required. No task is optional. Expected values are exact literals with no tolerances.

Commit rule for every top-level task (git-workflow.md): one Conventional Commit using the message given in the task, files staged by path (`git add <paths>`), `git diff --staged` checked for secrets, no `Co-Authored-By` or other trailers. Before committing, `pnpm --filter web test`, `typecheck` and `lint` (and `packages/db` tests when db files are touched) must pass for the touched files.

## Tasks

- [x] 1. Add label maps and the Today_Resolver
  - Commit: `feat(web): add graveyard labels and IST today resolver`
  - [x] 1.1 Implement `apps/web/lib/graveyard/labels.ts`
    - `STEP_TEXT` (`satisfies Record<LadderStep, string>`), `WAIT_TEXT` (`satisfies Record<WaitReason, string>`), `nextStepLabel`, `stateText` (Req 5.3 texts; `not_covered` → `Outside MSMED (<WAIT_TEXT[reason]>)`)
    - _Requirements: 5.3, 5.6, 5.7, 5.8, 5.9_
  - [x] 1.2 Write `apps/web/test/labels.test.ts` with exact labels
    - Exact `nextStepLabel` for each of the 5 `LadderStep`s and 7 `WaitReason`s; exact `stateText` for all six states (armed with N = 139)
    - _Requirements: 5.3, 5.7, 5.8, 12.12_
  - [x] 1.3 Write property test `apps/web/test/labels.property.test.ts`
    - **Property 7: Label maps are exhaustive and exact**
    - **Validates: Requirements 5.7, 5.8, 5.9**
  - [x] 1.4 Implement `apps/web/lib/graveyard/today.ts`
    - `DEMO_MIN`, `DEMO_MAX`, `istDate`, `resolveToday(nowMs, raw)`, `formatDisplayDate`, `TIME_TRAVEL_PRESETS`; first array value only; strict regex + Engine `isValidCalendarDate` + range; no clock read inside
    - _Requirements: 4.1, 4.3, 4.4, 4.5, 4.9_
  - [x] 1.5 Write `apps/web/test/today.test.ts` with injected instants
    - 2026-11-12T18:29:59Z → `2026-11-12`; 18:30:00Z and 19:00:00Z → `2026-11-13`; `2027-03-10`, `2024-01-01`, `2027-12-31` unchanged with override set; repeated value → first; `2026-2-3`, `2026-02-30`, `13/11/2026`, ` 2027-03-10 `, `2023-12-31`, `2028-01-01`, `""` → IST date with `override: null`; `formatDisplayDate("2027-03-10")` → `"10 Mar 2027"`
    - _Requirements: 4.2, 4.3, 4.4, 4.5, 12.4_
  - [x] 1.6 Write property test `apps/web/test/today.property.test.ts`
    - **Property 6: Today_Resolver returns a valid date and falls back correctly**
    - **Validates: Requirements 4.1, 4.3, 4.4, 4.5**

- [x] 2. Add tombstone look rules
  - Commit: `feat(web): add data-encoding tombstone look rules`
  - [x] 2.1 Implement `apps/web/lib/graveyard/look.ts`
    - `heightsByRank` (distinct-principal rank, `130 + floor(170 * rank / max(1, distinct - 1))`, integer comparison of paise only), `mossLevel` buckets (0 | 1–15 | 16–45 | 46–90 | >90), `cracked > 60`, `ember > 45`, `wisp` (unpaid on Today and a promise dated on or after Today)
    - _Requirements: 3.5, 5.11, 5.12_
  - [x] 2.2 Write `apps/web/test/look.test.ts` with exact boundaries
    - Moss at 0, 1, 15, 16, 45, 46, 90, 91; cracks at 60/61; ember at 45/46; equal principals → equal height; wisp with promise on Today, before Today, and on a paid invoice
    - _Requirements: 5.11, 5.12_

- [x] 3. Implement the pure Graveyard_Builder
  - Commit: `feat(web): add pure buildGraveyard view model with exact demo tests`
  - [x] 3.1 Add the `GraveyardInvoiceRecord` type
    - Type-only export in `packages/db/src/graveyard.ts`, re-exported from `packages/db/src/index.ts` (the read function comes in task 5)
    - _Requirements: 2.3_
  - [x] 3.2 Implement `apps/web/lib/graveyard/build-graveyard.ts`
    - View types from design Data Models; per-record Engine calls (`dueDate`, `taxBomb`, `nextEscalationStep`, `statutoryInterest` with the placeholder stated in design.md (0 bps), i.e. `{ annualBps: 0, asOf: DEMO_MIN }`, when no Bank_Rate, because the Engine accepts 0 (`packages/engine/src/validate.ts` lines 119–124); interest `null`); state precedence; `daysOverdue`; `formatINR(…, "full")`; `ariaLabel`; exclude `acceptedOn > today`; `rulesAsOf`; no input mutation
    - _Requirements: 2.5, 3.1, 3.2, 3.3, 3.4, 3.6, 3.7, 3.8, 3.9, 5.2, 5.3, 5.4, 5.5, 5.10, 10.3_
  - [x] 3.3 Add sort comparator and Totals to `build-graveyard.ts`
    - Group map, primary keys, tie-breaks by `<`/`>` (never `localeCompare`); Totals by integer addition with `Number.isSafeInteger` guard; `interestAccruedPaise` `null` with no Bank_Rate
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 7.1, 7.2, 7.3, 7.4_
  - [x] 3.4 Write `apps/web/test/build-graveyard.test.ts` with exact demo-seed literals
    - Build records from `DEMO_SUPPLIER` + `DEMO_INVOICES` via `toEngineInvoice` (fixed ids in the test), Today `2026-11-12`, Bank_Rate 575 bps as of `2026-10-07`
    - Full `toEqual` of the Graveyard_View: `rulesAsOf` `2026-10-07`; Sharma `LPC/26-27/0412` due `2026-10-17`, 26 days, 512794 paise, armed 139, `whatsapp_nudge`, `nextLabel` "Next: WhatsApp nudge"; Kumar `LPC/26-27/0301` 88 days, 1026125; Bansal `LPC/23-24/0098` 956 days, 3167411, exploded, caveat `registered_after_supply`; Mehta `LPC/25-26/0388` 192 days, 1530351, exploded; Gupta `LPC/26-27/0466` not_due, at risk 18500000; Verma `LPC/26-27/0377` resurrected (defused)
    - Totals `toEqual({ outstandingPaise: 105200000, interestAccruedPaise: 6236681, deductionsAtRiskPaise: 83700000, explodedCount: 2, paidCount: 1 })`
    - Order `toEqual(["LPC/26-27/0301","LPC/26-27/0412","LPC/23-24/0098","LPC/25-26/0388","LPC/26-27/0466","LPC/26-27/0377"])`
    - No Bank_Rate: every `interest` and `interestAccruedPaise` `null`, `rulesAsOf` `null`, other figures unchanged
    - No-bank-rate build (`bankRate = null`) does not throw and returns a Graveyard_View with Rules_As_Of none (`rulesAsOf` `null`)
    - A record with `acceptedOn` after Today is absent and Totals unchanged; one with `acceptedOn` equal to Today is present; empty records → no tombstones, Totals all 0
    - _Requirements: 2.5, 3.7, 3.8, 3.9, 7.5, 8.1, 8.2, 12.1, 12.2, 12.3, 12.9, 12.12_
  - [x] 3.5 Write property test `apps/web/test/graveyard-deterministic.property.test.ts`
    - **Property 1: Builder is deterministic and non-mutating**
    - **Validates: Requirements 3.1, 3.6**
  - [x] 3.6 Write property test `apps/web/test/graveyard-engine.property.test.ts`
    - **Property 2: Views agree with the Engine**
    - **Validates: Requirements 3.2, 3.3, 3.4, 5.2, 5.3**
  - [x] 3.7 Write property test `apps/web/test/graveyard-sort.property.test.ts`
    - **Property 3: Sort order is a function of the set, not the input order**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6**
  - [x] 3.8 Write property test `apps/web/test/graveyard-totals.property.test.ts`
    - **Property 4: Totals are sums over the views**
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.4, 2.5**
  - [x] 3.9 Write property test `apps/web/test/graveyard-future.property.test.ts`
    - **Property 5: Future-accepted invoices are invisible**
    - **Validates: Requirements 3.7, 8.1, 12.9**
  - [x] 3.10 Write property test `apps/web/test/graveyard-look.property.test.ts`
    - **Property 8: Tombstone look encodes the data monotonically**
    - **Validates: Requirements 5.11, 5.12**
  - [x] 3.11 Write property test `apps/web/test/graveyard-aria.property.test.ts`
    - **Property 9: Aria-label shape**
    - **Validates: Requirements 10.3, 5.3**
  - [x] 3.12 Write `apps/web/test/money-lint.test.ts`
    - Fails if `apps/web/lib/graveyard/**` or `apps/web/components/graveyard/**` contains `toFixed`, `parseFloat` or `Number(`
    - _Requirements: 3.5_

- [x] 4. Checkpoint: pure logic
  - From the repo root run `pnpm -r --if-present test && pnpm -r --if-present typecheck && pnpm -r --if-present lint`; ensure all tests pass, ask the user if questions arise.

- [x] 5. Add the db read function and typed errors
  - Commit: `feat(db): add listGraveyardInvoices and typed not-found errors`
  - [x] 5.1 Add `packages/db/src/errors.ts` and throw the typed errors
    - `SupplierNotFoundError` from `getSupplier` (`suppliers.ts`), `BankRateNotFoundError` from `getBankRate` no-row branch (`bank-rate.ts`); keep existing messages so current db tests pass; export from `index.ts`
    - _Requirements: 1.3, 2.5, 11.3_
  - [x] 5.2 Implement `listGraveyardInvoices(db, supplierId)` in `packages/db/src/graveyard.ts`
    - Three reads filtered by `invoices.supplier_id`; buyers joined on `(buyer_id, supplier_id)`; history from `escalation_events` and `promises` ordered by date then id; export from `index.ts`
    - _Requirements: 2.2, 2.3_
  - [x] 5.3 Write `packages/db/test/graveyard.test.ts`
    - Returns the six demo records with buyer names, invoice numbers and history; returns none of a second supplier's invoices, buyers, steps or promises; `getSupplier`/`getBankRate` reject with `instanceof` the new error classes
    - _Requirements: 2.3, 1.3, 2.5_

- [x] 6. Clear stale sessions in proxy.ts
  - Commit: `feat(web): clear stale demo session cookie in proxy`
  - [x] 6.1 Update `apps/web/proxy.ts`
    - Export `proxyHandler`; matcher `["/", "/signin", "/import/:path*", "/graveyard/:path*", "/debtor/:path*", "/api/import/:path*"]`; `/signin` never redirects; `?error=SessionExpired` expires every `/^(__Secure-)?authjs\.session-token(\.\d+)?$/` cookie; signed-in pass; `/api/*` 401; else redirect `/signin`; imports only `next-auth`, `next/server`, `auth.config.ts`
    - _Requirements: 1.1, 1.3, 1.4, 1.6_
  - [x] 6.2 Write `apps/web/test/proxy.test.ts`
    - `/signin?error=SessionExpired` with stale cookie and chunk cookies → no `Location`, `Set-Cookie` expires each; `/signin` with stale session → passes (no loop); `/` signed out → redirect `/signin`; `/` signed in → passes; import list of `proxy.ts` is exactly the three allowed modules
    - _Requirements: 1.1, 1.4, 1.6, 12.5, 12.11_

- [x] 7. Update sign-in redirect and SessionExpired message
  - Commit: `feat(web): land demo sign-in on graveyard and add reset message`
  - [x] 7.1 Change `apps/web/app/(site)/signin/actions.ts` and `messages.ts`
    - `signInDemo` success `redirectTo: "/"`; error branches unchanged; add `SessionExpired` → "The demo was reset. Enter the graveyard again."; other messages unchanged
    - _Requirements: 1.3, 1.7, 9.7_
  - [x] 7.2 Edit exactly two lines of `apps/web/test/signin.test.tsx`
    - Line 28 test title: `/import` → `/`; line 33: `redirectTo: "/import"` → `redirectTo: "/"`; no other line changes (check with `git diff`)
    - _Requirements: 1.7, 9.8_
  - [x] 7.3 Write `apps/web/test/signin-session-expired.test.tsx`
    - `/signin?error=SessionExpired` renders "The demo was reset. Enter the graveyard again." and does not redirect
    - _Requirements: 1.3, 1.4, 12.11_

- [x] 8. Checkpoint: db, proxy and sign-in
  - From the repo root run `pnpm -r --if-present test && pnpm -r --if-present typecheck && pnpm -r --if-present lint`; ensure all tests pass, ask the user if questions arise.

- [x] 9. Build the App_Shell and theme
  - Commit: `feat(web): add themed app shell with nav, sign out and footer`
  - [x] 9.1 Add fonts and theme tokens to `apps/web/app/layout.tsx`
    - `next/font/google` (Fraunces, IM Fell English / SC, Inter, JetBrains Mono) as CSS variables; `ui-theme.md` colour tokens in a global CSS Module; root layout wraps children in `<AppShell>`
    - _Requirements: 9.9, 10.1, 10.4_
  - [x] 9.2 Implement `apps/web/components/app-shell.tsx`, `app-shell.module.css`, `sign-out-action.ts`
    - Nav "Graveyard" `/`, "Import" `/import` and "Sign out" form only with `supplierId`; `signOut({ redirectTo: "/signin" })`; footer "Reminders a supplier sends to its own buyers. Not legal advice." always; 44 × 44 px targets; focus outline `#7CE8C0`
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 10.2, 10.9_
  - [x] 9.3 Write `apps/web/test/app-shell.test.tsx`
    - Links and Sign out present with `supplierId`, absent without; footer text in both; sign-out action calls `signOut({ redirectTo: "/signin" })`
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [x] 10. Build the graveyard components and loader
  - Commit: `feat(web): add graveyard components and data loader`
  - [x] 10.1 Implement `apps/web/lib/graveyard/load.ts`
    - `loadGraveyardData(db, supplierId, today)` → `ok` / `stale` / `error`; `getBankRate` in its own `try` with `instanceof BankRateNotFoundError` → `null`; `SupplierNotFoundError` → `stale`; any other error (including Engine `ValidationError` from building) → `error` with `console.error` only
    - _Requirements: 1.3, 2.2, 2.5, 11.1, 11.3_
  - [x] 10.2 Implement components in `apps/web/components/graveyard/`
    - `totals-bar`, `time-travel` (three links, `aria-current="page"`, Demo_Date_Chip only with override), `tombstone` (`<li><article tabIndex={0} aria-label>`, plaque with rule IDs, caveat badge, Next_Step_Label, no buttons), `graveyard-scene` (inline SVG/CSS, `aria-hidden`, behind grid), `load-error` (fixed text, retry link keeping URL-encoded `today`), each with a `.module.css`; animations only under `prefers-reduced-motion: no-preference`; fluid grid 360–1920 px
    - _Requirements: 2.4, 2.5, 3.8, 3.9, 4.7, 4.8, 4.9, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.10, 5.11, 5.12, 7.5, 8.1, 8.2, 10.1, 10.2, 10.3, 10.5, 10.6, 10.7, 10.8, 10.9, 11.1, 11.2_

- [x] 11. Wire the Graveyard_Page and its route tests
  - Commit: `feat(web): serve the graveyard of dues at /`
  - [x] 11.1 Implement `apps/web/app/(app)/page.tsx`
    - `auth()` → `supplierId` only; `resolveToday(Date.now(), (await searchParams).today)`; `loadGraveyardData`; `redirect("/signin?error=SessionExpired")` outside `try`; `buildGraveyard`; render Totals, TimeTravel, Tombstones, empty state ("The graveyard is quiet" + `/import` link) or LoadError
    - design.md: cacheComponents/prerendering does not apply, so no `await connection()`; if `cacheComponents` is ever enabled, call `await connection()` from `next/server` before `Date.now()`.
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.4, 4.6, 8.1, 8.2, 11.1_
  - [x] 11.2 Write `apps/web/test/graveyard-page.test.tsx`
    - Signed-out → `redirect("/signin")`; signed-in render contains Sharma `LPC/26-27/0412`; `?today=2027-03-10` shows "Demo date: 10 Mar 2027"; no chip without `today`; `SupplierNotFoundError` → `redirect` called exactly once with `/signin?error=SessionExpired`, no markup; `BankRateNotFoundError` → tombstones and Totals render, every interest slot, Interest_Accrued and the rules line show "Bank rate not configured for 12 Nov 2026", no "We couldn't load your graveyard just now", page resolves; plain `Error` from `getBankRate` → LoadError; failure with message, stack and `select * from invoices` → markup contains none, has retry link to `/`; `Date.now` spied to 2026-11-12T18:29:59Z then 2026-11-12T19:00:00Z → different Today (`2026-11-12`, then `2026-11-13`), seen as `getBankRate` called with `2026-11-12` then `2026-11-13`; supplier id in query is ignored; empty records → "The graveyard is quiet", `/import` link, `formatINR(0)` totals
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.5, 4.1, 4.2, 4.6, 4.7, 4.8, 8.1, 8.2, 11.1, 11.2, 11.3, 12.5, 12.6, 12.7, 12.8, 12.11_

- [~] 12. Add not-found and error pages
  - Commit: `feat(web): add themed not-found and graveyard error pages`
  - [x] 12.1 Implement `apps/web/app/not-found.tsx` and `apps/web/app/(app)/error.tsx`
    - Not_Found_Page with link to `/`; `error.tsx` fixed text and retry link, never renders `error.message` or `error.digest`
    - _Requirements: 1.5, 11.1, 11.2_
  - [-] 12.2 Write `apps/web/test/not-found.test.tsx`
    - Not_Found_Page has a link to `/`; `error.tsx` given an error with message, stack and digest renders none of them and has a retry link to `/`
    - _Requirements: 1.5, 11.2, 12.7_

- [ ] 13. Restyle /signin and /import
  - Commit: `style(web): restyle sign-in and import pages to the graveyard theme`
  - [ ] 13.1 Restyle `apps/web/app/(site)/signin/page.tsx` + `signin.module.css` and `apps/web/app/(app)/import/page.tsx` + `import.module.css`
    - Class names, wrappers and CSS only; keep form fields, button labels ("Enter the graveyard (demo)"), server actions, API routes, redirect targets and messages; existing tests pass unchanged
    - _Requirements: 9.5, 9.6, 9.7, 9.8, 9.9, 10.4, 10.9_

- [ ] 14. Final checkpoint
  - From the repo root run `pnpm -r --if-present test && pnpm -r --if-present typecheck && pnpm -r --if-present lint` with zero failures and zero errors; ensure all tests pass, ask the user if questions arise.
  - Ask the user to confirm these manual checks in the browser:
    - (a) Sign in, then run `pnpm --filter @dues-banshee/db db:reset-demo --yes`; reload `/` → lands on `/signin` with "The demo was reset. Enter the graveyard again."; signing in again works; no redirect loop.
    - (b) Each time-travel preset ("Today", "10 Mar 2027 (tax-bomb week)", "1 Apr 2027 (after 31 March)") shows the Demo_Date_Chip when an override is set (none for "Today") and the expected states; at 1 Apr 2027, Sharma, Kumar and Gupta show "Tax bomb exploded".
    - (c) Side-by-side visual check against `/design/Main.dc.html`.
    - (d) The CSS-only checks from design.md: contrast, reduced motion, 360 px layout, 44 px targets (Req 10.4, 10.5, 10.7, 10.9).
    - Any sample or scratch files used for these checks go only in `/tmp`, never in the repo.

## Notes

- No task is optional; every test and property test is required (Req 12.10).
- Property tests use fast-check (already a root devDependency), `{ numRuns: 100 }` minimum, tagged `// Feature: dashboard-ui, Property N: <title>`. They are split into one file per property (instead of the design's single `graveyard.property.test.ts`) so they can run in parallel waves without file conflicts.
- `GraveyardInvoiceRecord` is added as a type in task 3.1 so the pure builder can be written before the db read in task 5.
- Each top-level task is one commit, with the message listed in the task.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.4", "2.1", "3.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.5", "1.6", "2.2", "3.2"] },
    { "id": 2, "tasks": ["3.3"] },
    { "id": 3, "tasks": ["3.4", "3.5", "3.6", "3.7", "3.8", "3.9", "3.10", "3.11", "3.12"] },
    { "id": 4, "tasks": ["5.1", "6.1", "7.1"] },
    { "id": 5, "tasks": ["5.2", "6.2", "7.2", "7.3"] },
    { "id": 6, "tasks": ["5.3", "9.2"] },
    { "id": 7, "tasks": ["9.1", "10.1"] },
    { "id": 8, "tasks": ["9.3", "10.2"] },
    { "id": 9, "tasks": ["11.1", "12.1"] },
    { "id": 10, "tasks": ["11.2", "12.2", "13.1"] }
  ]
}
```
