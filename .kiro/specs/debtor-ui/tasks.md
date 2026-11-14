# Implementation Plan: debtor-ui

## Overview

TypeScript (strict), Next.js App Router, CSS Modules, Vitest + fast-check, PGlite for db tests, Playwright for one smoke test. Order follows the dependencies and keeps every commit green: the Engine promise helpers with their fast-check properties first, then the `packages/db` reads (`buyerId`, `invoiceDate`, `getDebtorData`, `DraftWithContext.buyerId`), then the wisp through the Engine and the Tombstone link, then `returnTo` on the approvals actions, then the pure debtor lib (panels and Candle_Timeline), then the loader, components, `(debtor)` route group, page and proxy matcher, then the Playwright smoke test.

`apps/web` adds no legal or money maths. Every figure comes from `buildGraveyard` (which takes it from the Engine), every amount goes through the Engine `formatINR`, and the only active-promise rule is the Engine `hasActivePromise` / `activePromiseUntil`. Approve, edit, reject and redraft stay in `apps/web/app/(app)/approvals/actions.ts`.

Every test task is required. No task is optional (Req 10.9). Expected values are exact literals with no tolerances.

Commit rule for every top-level task (git-workflow.md): one Conventional Commit using the message given in the task, files staged by path (`git add <paths>`), `git diff --staged` checked for secrets, no `Co-Authored-By` or other trailers. Before committing, `test`, `typecheck` and `lint` must pass for every package touched by the task.

## Tasks

- [ ] 1. Add the Engine active-promise helpers
  - Commit: `feat(engine): add hasActivePromise and activePromiseUntil helpers`
  - [ ] 1.1 Implement `packages/engine/src/promise.ts` and export it from `index.ts`
    - `activePromiseUntil(history, today): CalendarDate | null` returns the latest `promisedDate` among `promise` events with `promisedDate >= today` (CalendarDate string compare), else `null`; `hasActivePromise(history, today)` is `activePromiseUntil(history, today) !== null`; pure, no clock, inputs not mutated
    - Update the export list in `packages/engine/test/exports.test.ts` if it enumerates exports; `purity.test.ts` must still pass
    - _Requirements: 6.1, 6.6_
  - [ ] 1.2 Write `packages/engine/test/promise.test.ts`
    - `hasActivePromise` with one promise dated the day before `today` → `false`, the day of `today` → `true`, the day after → `true`; empty history and a history with only step events → `false` / `null`; `activePromiseUntil` with promises `2026-11-10`, `2026-11-20`, `2026-11-15` at `2026-11-12` → `"2026-11-20"`; both functions exported from the Engine `index.ts`
    - _Requirements: 6.1, 6.6, 10.6_
  - [ ] 1.3 Write property test in `packages/engine/test/promise.property.test.ts`
    - **Property 1: hasActivePromise matches the wisp rule**
    - Reference predicate `history.some(e => e.kind === "promise" && e.promisedDate >= today)` written inside the test; generators from `packages/engine/test/arbitraries.ts` cover empty histories, no `promise` events and several `promise` events
    - **Validates: Requirements 6.1, 6.5**
  - [ ] 1.4 Add property test to `packages/engine/test/promise.property.test.ts`
    - **Property 2: activePromiseUntil agrees with hasActivePromise and is the latest active date**
    - **Validates: Requirements 6.6, 10.6**

- [ ] 2. Add the debtor db reads
  - Commit: `feat(db): add getDebtorData and buyer ids on graveyard and draft reads`
  - [ ] 2.1 Update `packages/db/src/graveyard.ts` and `index.ts`
    - `GraveyardInvoiceRecord` gains `buyerId` and `invoiceDate`; one private `readRecords(db, supplierId, buyerId?)` shared by `listGraveyardInvoices` and `getDebtorData`, every query filtered by `invoices.supplier_id = supplierId` (plus `invoices.buyer_id = buyerId` when given); history rules unchanged (steps only from `approved` events)
    - Add `DebtorEventRow`, `DebtorPromiseRow`, `DebtorData` and `getDebtorData(db, supplierId, buyerId)`: buyer selected with `buyers.id = buyerId AND buyers.supplier_id = supplierId`, no row → `null`; `events` (every `action`) and `promises` through supplier-scoped joins on `invoices`; read-only; export from `index.ts`
    - Add `buyerId` and `invoiceDate` to the record fixtures and arbitraries in existing `apps/web` tests (`build-graveyard.test.ts` and the `graveyard-*.property.test.ts` generators) so the `apps/web` typecheck stays green; no assertion changes
    - _Requirements: 1.5, 3.5_
  - [ ] 2.2 Add `buyerId` to `DraftWithContext` in `packages/db/src/ladder.ts`
    - Fill it from `invoices.buyer_id` in `toDraftWithContext`; add `buyerId` to `DraftWithContext` fixtures in existing `apps/web` approvals tests only, with no assertion changes
    - _Requirements: 7.1, 7.7_
  - [ ] 2.3 Write `packages/db/test/debtor.test.ts` (PGlite)
    - Demo_Seed: `getDebtorData` for Sharma Traders returns the buyer name, its invoice records (with `buyerId`, `invoiceDate`) and every event action, including `drafted` and `rejected` rows inserted in the test; returns `null` for a second supplier's buyer and for an unknown uuid; no row of the second supplier appears in `records`, `events` or `promises`; `listGraveyardInvoices` returns `buyerId` and `invoiceDate` per record; `listPendingDrafts` rows carry the right `buyerId`
    - _Requirements: 1.3, 1.5, 3.5_

- [ ] 3. Checkpoint: engine and db
  - From the repo root run `pnpm -r --if-present test && pnpm -r --if-present typecheck && pnpm -r --if-present lint`; ensure all tests pass, ask the user if questions arise.

- [ ] 4. Use the Engine wisp rule and link tombstones to the Debtor_Page
  - Commit: `feat(web): link tombstones to debtor pages and use engine wisp rule`
  - [ ] 4.1 Update `apps/web/lib/graveyard/look.ts`
    - `wisp: !paid && hasActivePromise(history, today)` from the Engine; remove the inline promise check; existing `look.test.ts` passes unchanged
    - _Requirements: 6.2, 6.3_
  - [ ] 4.2 Add property test to `apps/web/test/graveyard-look.property.test.ts`
    - **Property 3: Wisp is "unpaid and active promise"**
    - **Validates: Requirements 6.2**
  - [ ] 4.3 Extend `apps/web/test/lint.test.ts` with the active-promise scan
    - Fails if any `apps/web` source outside tests compares `kind === "promise"` with `promisedDate` (only calls to `hasActivePromise` / `activePromiseUntil` allowed)
    - _Requirements: 6.3_
  - [ ] 4.4 Add `buyerId` to `TombstoneView`, `overdueText` to `labels.ts`, and `apps/web/lib/debtor/href.ts`
    - `buildGraveyard` copies `record.buyerId` onto `TombstoneView.buyerId`, no other builder change; update the exact `toEqual` in `build-graveyard.test.ts` with the fixture buyer ids
    - Copy the overdue-text rule out of `components/graveyard/tombstone.tsx` into `labels.overdueText(view)` unchanged (removed from the component in 4.6)
    - `debtorHref(buyerId, invoiceId, override)` → `/debtors/<b>#invoice-<i>` or `/debtors/<b>?today=<override>#invoice-<i>`
    - _Requirements: 3.1, 3.2, 3.3, 3.5, 4.2_
  - [ ] 4.5 Write property test `apps/web/test/debtor-href.property.test.ts`
    - **Property 8: Tombstone link shape**
    - **Validates: Requirements 3.1, 3.2, 3.3**
  - [ ] 4.6 Turn the Tombstone into a link
    - `tombstone.tsx`: `<li><a className={styles.article} href={debtorHref(view.buyerId, view.invoiceId, override)} aria-label={view.ariaLabel} data-state>…</a></li>`, no `tabIndex`, uses `labels.overdueText`; move focus-visible styles to the `<a>` in `tombstone.module.css`, keep ≥ 44 × 44 px; `tombstone-grid.tsx` passes `override`; `app/(app)/page.tsx` passes the `resolveToday` override to `TombstoneGrid`; the link triggers no escalation step
    - _Requirements: 3.1, 3.2, 3.3, 3.4_
  - [ ] 4.7 Update `apps/web/test/graveyard-components.test.tsx`
    - Each Tombstone, whatever its state, renders exactly one `<a>` with `href` `/debtors/<buyerId>#invoice-<invoiceId>`, with `?today=2027-03-10` before the fragment under an override and no `today` without one; same `aria-label` text as before; no `tabIndex` attribute; `graveyard-page.test.tsx` passes unchanged
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 10.7_

- [ ] 5. Add returnTo to the approvals actions
  - Commit: `feat(web): let approvals actions return to the debtor page`
  - [ ] 5.1 Implement `apps/web/lib/approvals/return-to.ts`
    - `ReturnTarget`, `parseReturnTo(raw)`: `"/approvals"` or `/debtors/<uuid>` exactly (case-insensitive uuid regex, anchored, nothing after), anything else → `"/approvals"`
    - _Requirements: 7.4_
  - [ ] 5.2 Write property test `apps/web/test/return-to.property.test.ts`
    - **Property 9: returnTo allowlist**
    - Generators mix valid targets, valid targets with `?x`, `#x`, `/x`, `//` suffixes, protocol-relative and absolute URLs, and random strings
    - **Validates: Requirements 7.4, 10.5**
  - [ ] 5.3 Update `apps/web/app/(app)/approvals/actions.ts` and `components/approvals/draft-card.tsx`
    - `finish(notice, override, target = "/approvals", buyerId = null)`: `revalidatePath("/approvals")`, plus `revalidatePath(`/debtors/${buyerId}`)` when `buyerId`; same `today`/`notice`/`label`/`n` params; redirect to `` `${target}?${params}` ``
    - `decide()` and the `redraftIn` invalid-language branch read `parseReturnTo(field(form, "returnTo"))` and, inside `withSupplier`, get `buyerId` from `getDraftForSupplier` for a uuid draftId (null when not this supplier's); no new decision logic; `checkLadderNow` and the Stale_Session redirect unchanged
    - `DraftCard` gains optional `returnTo`; `HiddenFields` renders `<input type="hidden" name="returnTo">` only when set, so `/approvals` forms stay byte-identical
    - _Requirements: 7.3, 7.4, 7.5, 7.7, 7.8_
  - [ ] 5.4 Write `apps/web/test/approvals-actions.test.ts`
    - With `redirect` and `revalidatePath` mocked: `returnTo=/debtors/<uuid>` → redirect to `/debtors/<uuid>?…` with `notice`, `label`, `n` and `today` kept; missing, `""`, `//evil.example`, `https://evil.example`, `/debtors/not-a-uuid` and `/` → `/approvals?…`; revalidates `/approvals` and `/debtors/<buyerId>` for the supplier's Draft, only `/approvals` for another supplier's Draft; `approvals-page.test.tsx` and `approvals-double-submit.test.tsx` assertions pass unchanged
    - _Requirements: 7.4, 7.7, 7.8, 10.5_

- [ ] 6. Checkpoint: graveyard and approvals
  - From the repo root run `pnpm -r --if-present test && pnpm -r --if-present typecheck && pnpm -r --if-present lint`; ensure all tests pass, ask the user if questions arise.

- [ ] 7. Build the pure Debtor_View and Candle_Timeline
  - Commit: `feat(web): add pure debtor view and candle timeline builders`
  - [ ] 7.1 Implement `apps/web/lib/debtor/build-debtor-view.ts`
    - `InvoicePanelView`, `DebtorView`, `buildDebtorView({ supplier, data, bankRate, drafts, today, override })`: `panels` from `buildGraveyard(supplier, data.records, bankRate, today).tombstones` in that order; `panelId` `invoice-<id>`; `overdueText` via `labels.overdueText`; `promiseUntilText` "Promise to pay active until <formatDisplayDate(activePromiseUntil(...))>" when not `resurrected` and non-null; `showPlaceholders` iff state ≠ `resurrected`; `drafts` keeps `buyerId === data.buyer.id` and invoice in the panels, order kept; `timeline` from `buildCandleTimeline`; no money maths
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 6.4, 7.1, 8.1_
  - [ ] 7.2 Implement `apps/web/lib/debtor/candle-timeline.ts`
    - `EntryKind`, `TimelineEntry`, `ACTION_TEXT` (`satisfies Record<EscalationAction, string>`), `buildCandleTimeline`: entries, texts, date filter, order (date, kind rank, `rowId` by code unit), `dateText` via `formatDisplayDate` on the stored string, `lit`, `tone` exactly per the design table; amounts only through `formatINR(…, "full")`; no `Date` objects
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_
  - [ ] 7.3 Write `apps/web/test/debtor-view.test.ts`
    - Demo_Seed records via `toEngineInvoice`, Today `2026-11-12`, Bank_Rate 575 bps as of `2026-10-07`; exact `toEqual` on the Sharma Traders panel: `LPC/26-27/0412`, principal 41200000, due `2026-10-17` with `MSMED-15`, 26 days overdue, interest 512794 with `MSMED-16`, state `armed`, 139 days, `IT-43BH`, "Next: WhatsApp nudge"; displayed amounts equal `formatINR(41200000, "full")` and `formatINR(512794, "full")`; with an unpaid invoice and a promise to `2026-11-20` → "Promise to pay active until 20 Nov 2026"; paid invoice → `promiseUntilText` `null`, `showPlaceholders` `false`; no Bank_Rate → interest `null`, other figures unchanged
    - _Requirements: 4.1, 4.2, 4.4, 4.6, 6.4, 8.1, 10.1_
  - [ ] 7.4 Write property test `apps/web/test/debtor-view.property.test.ts`
    - **Property 4: Panels equal the graveyard's tombstones for that buyer** (`look.heightPx` excluded)
    - **Validates: Requirements 4.1, 4.4**
  - [ ] 7.5 Add property test to `apps/web/test/debtor-view.property.test.ts`
    - **Property 10: Buyer's Drafts keep the queue order**
    - **Validates: Requirements 7.1**
  - [ ] 7.6 Write `apps/web/test/candle-timeline.test.ts`
    - Exact `toEqual` of the full Sharma Traders timeline at `2026-11-12` (kinds, dates, `dateText`, texts, invoice numbers, `lit`, `tone`, order), starting with the `invoice` entry on `2026-09-02` "Invoice LPC/26-27/0412 raised for " + `formatINR(41200000, "full")` and the `due` entry on `2026-10-17` "Due date (MSMED-15)" (`ember`)
    - Mixed fixture: future `ladder`, `promise` and `payment` excluded; future `due` kept and unlit; two entries of different kinds on one date ordered by kind; a `not_covered` invoice gives an `invoice` entry and no `due` entry; `ladder` text "<Step_Text> <Action_Text>" for each action; `promise` text "Promised <formatINR> by <D MMM YYYY>"; `payment` text "Paid. Resurrected"
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.6, 10.2_
  - [ ] 7.7 Write property test `apps/web/test/candle-timeline.property.test.ts`
    - **Property 5: Timeline membership and date exclusion**
    - **Validates: Requirements 5.1, 5.2**
  - [ ] 7.8 Add property test to `apps/web/test/candle-timeline.property.test.ts`
    - **Property 6: Timeline order is total and input-order independent**
    - **Validates: Requirements 5.3**
  - [ ] 7.9 Add property test to `apps/web/test/candle-timeline.property.test.ts`
    - **Property 7: Candle look encodes data**
    - **Validates: Requirements 5.6**

- [ ] 8. Serve the Debtor_Page at /debtors/[id]
  - Commit: `feat(web): add the debtor seance page at /debtors/[id]`
  - [ ] 8.1 Implement `apps/web/lib/debtor/load.ts`
    - `DebtorLoadResult`, `loadDebtorData(db, supplierId, buyerIdRaw, nowMs, rawToday)` in the design's step order: `getSupplier` (`SupplierNotFoundError` → `stale`), `resolveSupplierToday`, uuid regex (non-uuid → `not_found` with no buyer query), `getBankRate` (`BankRateNotFoundError` → `null`), `getDebtorData` (`null` → `not_found`), `listPendingDrafts`, `buildDebtorView`; any other error → `{ kind: "error", override }` with `console.error` only; never throws or redirects
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.3, 4.6_
  - [ ] 8.2 Write `apps/web/test/debtor-load.test.ts`
    - Stale first for any id (including a non-uuid); non-uuid → `not_found` and `getDebtorData` not called; `null` → `not_found`; a read that throws → `error` with the override; no Bank_Rate → `ok`; demo supplier with `today=2027-03-10` → Today `2027-03-10`, `override` set; another supplier with the same query → real IST date, `override: null`
    - _Requirements: 1.3, 1.4, 1.6, 2.1, 2.3, 4.6, 10.3, 10.4_
  - [ ] 8.3 Implement `apps/web/components/debtor/` components with `.module.css`
    - `invoice-panel.tsx` (`<section id={panelId}>`, plaque fields and rule IDs as the Tombstone, caveat badge via `CAVEAT_TEXT`, `bankRateMissingText(today)` when interest is `null` and not `not_covered`, promise text, `scroll-margin-top` ≥ App_Shell header height); `placeholder-actions.tsx` (two `<button type="button" disabled aria-describedby>` with "Arrives with WhatsApp" / "Arrives with voice call", secondary `#A9A497`, no opacity, no handler or action); `candle-timeline.tsx` (`<ol>`, `<li data-kind data-lit data-tone>`, `aria-hidden` candle, text spans for date, text, invoice number; flicker only inside `prefers-reduced-motion: no-preference`; ui-theme colours); `debtor-load-error.tsx` (fixed text, "Try again" link to `/debtors/<id>` plus `?today=<override>` when set); no `<canvas>`, three or WebGL
    - _Requirements: 1.6, 4.2, 4.3, 4.6, 5.6, 5.7, 5.8, 6.4, 8.1, 8.2, 8.3, 9.1, 9.2, 9.3, 9.4, 9.5_
  - [ ] 8.4 Add the `(debtor)` route group, page and proxy matcher
    - `app/(debtor)/layout.tsx` (copy of the `(app)/layout.tsx` session guard), `app/(debtor)/error.tsx` (fixed text, retry from `usePathname()` + `today`, never reads the error), `app/(debtor)/debtors/[id]/page.tsx` + `debtor.module.css`; no `loading.tsx` in the group
    - Page: `auth()` → `supplierId` only; `loadDebtorData(db, supplierId, id, Date.now(), searchParams.today)`; `redirect("/signin")`, `redirect("/signin?error=SessionExpired")` and `notFound()` outside any `try`; heading = buyer name; Demo_Date_Chip with override; `noticeMessage` with `role="status"` / `role="alert"`; Invoice_Panels or "No invoices for this buyer on this date" + link to `/`; "Waiting for your approval" with `DraftCard item override returnTo={`/debtors/${buyerId}`}` or "No drafts waiting for this buyer"; Candle_Timeline; footer from `AppShell`
    - `apps/web/proxy.ts` matcher gains `"/debtors/:path*"` (keep `"/debtor/:path*"`)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.6, 2.1, 2.2, 2.3, 4.1, 4.7, 4.8, 7.1, 7.2, 7.3, 7.5, 7.6, 9.4, 9.5_
  - [ ] 8.5 Write `apps/web/test/debtor-page.test.tsx`
    - Signed-out → `redirect("/signin")`; stale → `redirect` once with `/signin?error=SessionExpired`, no markup; non-uuid, unknown uuid and another supplier's buyer each call `notFound` and render no buyer name; thrown read → retry link to `/debtors/<id>` (with `?today=` only under an override), markup has no message, stack or `select` text; `(debtor)/error.tsx` renders none of message, stack, digest; Demo_Date_Chip "Demo date: 10 Mar 2027" and `today` hidden fields for the demo supplier, none for another supplier; notice roles; both empty states; placeholders `disabled` with `aria-describedby` texts, absent on a resurrected panel; every Draft form has `returnTo=/debtors/<buyerId>`; timeline is an `<ol>` with `aria-hidden` candles and text content; footer disclaimer present
    - _Requirements: 1.1, 1.3, 1.4, 1.6, 2.2, 2.3, 4.7, 4.8, 5.7, 7.1, 7.2, 7.5, 7.6, 8.1, 8.2, 10.3, 10.4, 10.7_
  - [ ] 8.6 Extend `apps/web/test/proxy.test.ts`
    - `/debtors/<uuid>` signed out → redirect `/signin`; signed in → passes; `/debtors/...` is in the exported matcher
    - _Requirements: 1.1, 10.3_
  - [ ] 8.7 Extend `apps/web/test/lint.test.ts` and `apps/web/test/money-lint.test.ts`
    - Scan `lib/debtor/**`, `components/debtor/**` and `app/(debtor)/**`: no `toFixed`, `parseFloat`, `Number(` or float division on money; no inline active-promise check; no `<canvas>`, `three` or WebGL; flicker keyframes only inside `@media (prefers-reduced-motion: no-preference)`; `ACTION_TEXT` uses `satisfies Record<EscalationAction, string>`
    - _Requirements: 4.5, 5.5, 5.8, 6.3, 9.1_

- [ ] 9. Checkpoint: Debtor_Page
  - From the repo root run `pnpm -r --if-present test && pnpm -r --if-present typecheck && pnpm -r --if-present lint`; ensure all tests pass, ask the user if questions arise.

- [ ] 10. Add the Playwright smoke test
  - Commit: `test(web): add Playwright smoke test for the debtor page`
  - [ ] 10.1 Add Playwright to `apps/web`
    - `@playwright/test` dev dependency and script `"e2e": "playwright test"` in `apps/web/package.json` (not part of `test`); `apps/web/playwright.config.ts` with `testDir: "e2e"`, one Chromium project, `baseURL: "http://localhost:3000"`, `webServer: { command: "pnpm build && pnpm start", url: "http://localhost:3000", reuseExistingServer: true }`; confirm Vitest's include does not pick up `e2e/**/*.spec.ts`; lint and typecheck cover the new files
    - _Requirements: 10.8, 10.9_
  - [ ] 10.2 Write `apps/web/e2e/debtor-smoke.spec.ts`
    - Sign in with "Enter the graveyard (demo)", open `/?today=2026-11-12`, click the Sharma Traders Tombstone; assert the URL matches `/debtors/<uuid>?today=2026-11-12#invoice-<uuid>` using the ids from the clicked link's `href`; assert the page shows "Sharma Traders", `LPC/26-27/0412`, `formatINR(41200000, "full")`, "Overdue 26 days, interest accruing", `formatINR(512794, "full")` and "Tax bomb armed: 139 days left to 31 March" (amounts from the Engine `formatINR`)
    - _Requirements: 10.8_

- [ ] 11. Final checkpoint
  - From the repo root run `pnpm -r --if-present test && pnpm -r --if-present typecheck && pnpm -r --if-present lint` with zero failures and zero errors; ensure all tests pass, ask the user if questions arise.
  - Ask the user to run the smoke test against the demo database (destructive reset, demo DB only): `pnpm --filter @dues-banshee/db db:reset-demo -- --yes`, then `pnpm --filter web exec playwright install chromium` (first run only), then `pnpm --filter web e2e`; it must pass with zero failures (Req 10.8, 10.9).
  - Ask the user to confirm the manual checks from design.md: disabled-button and "Arrives with …" contrast, 44 × 44 targets, no horizontal scroll at 360 px and 1920 px, no decoration over text, `#invoice-<id>` scroll clears the App_Shell header, unknown fragment stays at the top, `curl -I` on an unknown buyer returns 404 and on a stale session returns 307 (Req 1.3, 1.4, 9.2–9.5).
  - Any scratch files for these checks go only in `/tmp`, never in the repo.

## Notes

- No task is optional; every test and property test is required (Req 10.9).
- Property tests use fast-check, `{ numRuns: 100 }` minimum, tagged `// Feature: debtor-ui, Property N: <title>`. Engine generators reuse `packages/engine/test/arbitraries.ts`. Properties that share a design file (1–2, 4 and 10, 5–7) are added in separate waves to avoid write conflicts.
- Sub-tasks inside one top-level task may not typecheck on their own (7.1 and 7.2 import each other's types); the commit happens once per top-level task, after all its sub-tasks pass.
- Task 2.1 and 2.2 touch existing `apps/web` test fixtures only to add the new required fields; no existing assertion changes until 4.4 (`buyerId` in the exact Graveyard_View) and 4.7 (Tombstone is a link).
- `structure.md` names `app/(app)/debtor/[id]`; this spec uses `app/(debtor)/debtors/[id]/` per `roadmap.md` and design.md, so 404 and 307 are real status codes.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "5.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.1", "5.2"] },
    { "id": 2, "tasks": ["1.4", "2.2", "4.1"] },
    { "id": 3, "tasks": ["2.3", "4.2", "4.3", "4.4"] },
    { "id": 4, "tasks": ["4.5", "4.6", "5.3"] },
    { "id": 5, "tasks": ["4.7", "5.4", "7.1"] },
    { "id": 6, "tasks": ["7.2"] },
    { "id": 7, "tasks": ["7.3", "7.4", "7.6", "7.7", "8.1"] },
    { "id": 8, "tasks": ["7.5", "7.8", "8.2", "8.3"] },
    { "id": 9, "tasks": ["7.9", "8.4"] },
    { "id": 10, "tasks": ["8.5", "8.6", "8.7", "10.1"] },
    { "id": 11, "tasks": ["10.2"] }
  ]
}
```
