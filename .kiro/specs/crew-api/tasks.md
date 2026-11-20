# Implementation Plan: crew-api

## Overview

Three commits, each green on `pnpm --filter web test` and typecheck: (1) shared bearer helper, proxy comment, env line and lint scans; (2) the pure `toCrewSummary` mapper with its tests; (3) the `GET /api/crew/summary` route with its tests and the non-vacuous scan assertion. All test sub-tasks are required.

## Tasks

- [x] 1. Shared bearer helper, proxy comment, env line and lint scans
  - [x] 1.1 Move `bearerMatches` into `apps/web/lib/bearer.ts`
    - Move `bearerMatches` and its private `sha256` verbatim (same regex, SHA-256 digests, `timingSafeEqual`, empty token rejected) and export `bearerMatches(header: string | null, secret: string): boolean`.
    - In `apps/web/app/api/ladder/run/route.ts`, delete the local copies and the `node:crypto` import and add `import { bearerMatches } from "@/lib/bearer"`. No other change.
    - `apps/web/test/ladder-run-route.test.ts` passes without edits.
    - _Requirements: 2.1, 2.2_
  - [x] 1.2 Update the proxy comment and `.env.example`
    - In `apps/web/proxy.ts`, edit only the matcher comment to name `/api/crew/summary` next to `/api/ladder/run` as deliberately absent because it authenticates with its own bearer secret. Keep the nine matcher entries and their order. `apps/web/test/proxy.test.ts` passes without edits.
    - Append `CREW_READ_SECRET=` (empty value) after `DEMO_BUYER_WHATSAPP=` in `apps/web/.env.example`. Leave the 15 existing lines unchanged.
    - _Requirements: 1.3, 1.4, 6.1_
  - [x] 1.3 Add the env assertion and the agent/voice import scan to `apps/web/test/lint.test.ts`
    - In the `.env.example` checks, assert that `emptyEnvNames` of `apps/web/.env.example` contains `CREW_READ_SECRET`. The existing "whatsapp-channel .env.example" block, the tracked-env-file checks and the public-key scan in `voice-lint.test.ts` pass without edits.
    - Add a detector for static import, dynamic `import()` and re-export of `@dues-banshee/agent` / `@dues-banshee/voice` (with subpaths), using `stripComments`. Detector test: each positive form is flagged; the package name inside a comment and an `@dues-banshee/db` import are not flagged.
    - Add the real scan over `app/api/crew` and `lib/crew` with `listWebSources` (missing dirs yield no files, so it is green now). The assertion that the scan finds `app/api/crew/summary/route.ts` is added in task 3.3.
    - _Requirements: 5.2, 6.2, 6.3_
  - [x] 1.4 Add the crew dirs to `apps/web/test/money-lint.test.ts`
    - Add `app/api/crew` and `lib/crew` to `SCANNED_DIRS` and update the test title to name them.
    - _Requirements: 5.3_

- [x] 2. Crew summary mapper
  - [x] 2.1 Implement `apps/web/lib/crew/summary.ts`
    - Export `CrewMoney`, `CrewTombstone`, `CrewSummary`, `CrewError`, `CREW_DISCLAIMER` ("Reminders a supplier sends to its own buyers. Not legal advice.") and `toCrewSummary(view, todayOverride)` as in design.md.
    - List every field explicitly (no spread); the only transformation is `formatINR(paise, "full")`. Import only `formatINR` and types from `@dues-banshee/engine` and types from `@/lib/graveyard/build-graveyard`.
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_
  - [x] 2.2 Write the property test for the mapper in `apps/web/test/crew-summary.property.test.ts`
    - **Property 1: The mapper is an exact projection of the view**
    - Tag `// Feature: crew-api, Property 1: The mapper is an exact projection of the view`, `{ numRuns: 100 }` minimum. Generate `GraveyardView` with `fc.record` over the real unions, nullable fields via `fc.option`, paise 0 to 10^12, and arbitrary `look`/`ariaLabel`/`caveat`/`next` so leaks show. Expected texts come from the real `formatINR`.
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6**
  - [x] 2.3 Write the Sharma Traders example test in the same file
    - Build the view with `buildGraveyard` from the `DEMO_INVOICES` seed, Bank_Rate `{ annualBps: 575, asOf: "2026-10-07" }`, today 2026-11-12 (fixed-id helper copied from `build-graveyard.test.ts`). Assert the exact `LPC/26-27/0412` tombstone values of Requirement 4.8, `rulesAsOf` "2026-10-07", `disclaimer`, and that `totals.interestAccrued` is null when the view's is null.
    - _Requirements: 4.3, 4.4, 4.8_

- [x] 3. Summary route
  - [x] 3.1 Implement `apps/web/app/api/crew/summary/route.ts`
    - `export const runtime = "nodejs"` and `export async function GET` only, as in design.md: 503 when `CREW_READ_SECRET` is unset or empty; 401 via `bearerMatches` against the Crew_Secret only (never read `LADDER_RUN_SECRET`); `resolveToday(Date.now(), searchParams.get("today") ?? undefined)`; `getDb()` throw → 500 without `close`; `findSupplierIdByUdyam(db, DEMO_SUPPLIER.udyamNumber)` null → 404; `loadGraveyardData(db, id, today)` once, `stale` → 404, `error` or throw → 500 `load_failed`; `ok` → 200 `toCrewSummary(view, override !== null)`; `close()` once in `finally`.
    - `Cache-Control: no-store` on every response. Logs carry only `"crew summary failed"` and a `{ stage }` label. No `fetch`, no LLM client, no agent/voice import, no `toFixed`/`parseFloat`/`Number(`.
    - _Requirements: 1.1, 1.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 4.1, 4.7, 5.1, 5.3_
  - [x] 3.2 Write `apps/web/test/crew-summary-route.test.ts`
    - Style of `ladder-run-route.test.ts`: `vi.hoisted` mocks of `getDb` (`@/lib/db`), `findSupplierIdByUdyam` (`@dues-banshee/db`, spread over the actual module so `DEMO_SUPPLIER` is real) and `loadGraveyardData` (`@/lib/graveyard/load`); fake timers at `2026-11-12T20:00:00Z`; `ok` view from `buildGraveyard` with the `DEMO_INVOICES` seed and Bank_Rate `{ annualBps: 575, asOf: "2026-10-07" }`.
    - 503 for unset and empty secret; 401 for missing header, wrong token and the Ladder_Secret (stubbed to a different value); `getDb` not called on these. 404 for a null lookup (`loadGraveyardData` not called) and for `stale`; 500 for `error`, a throwing lookup and a throwing `getDb()` (no `close` expected). Exact status and body on each.
    - 200 at `?today=2026-11-12`: exact Sharma Traders values, `today` "2026-11-12", `todayOverride: true`, Disclaimer, `loadGraveyardData` called once with the demo id and "2026-11-12", no `look`/`ariaLabel`/`caveat`/`next` on any tombstone.
    - `?today=2027-02-30`: `loadGraveyardData` receives "2026-11-13"; body `today` "2026-11-13", `todayOverride: false`.
    - `Cache-Control: no-store` on 200 and on at least one 401, 404 and 500; `close` called once on each 200/404/500 path where `getDb` returned.
    - Secret hygiene: on the 200 path and on a throwing-lookup 500 whose message contains the Crew_Secret, neither the secret nor the message appears in any body or in any argument of spied `console.error`/`warn`/`log`.
    - Module shape: `runtime === "nodejs"` and `GET` is the only HTTP-method export.
    - _Requirements: 1.1, 1.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.2, 3.4, 3.5, 3.6, 3.7, 3.8, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_
  - [x] 3.3 Write the property test for the auth gate and make the import scan non-vacuous
    - **Property 2: Only the Crew_Secret opens the route**
    - In `crew-summary-route.test.ts`, tag `// Feature: crew-api, Property 2: Only the Crew_Secret opens the route`, `fc.asyncProperty` with `{ numRuns: 100 }` minimum over missing headers, random tokens `!== secret` without line breaks, mutations of the secret and the Ladder_Secret, filtering out values whose trimmed form equals `Bearer <Crew_Secret>`; assert 401, body, `Cache-Control: no-store`, `getDb` not called; clear mocks between runs.
    - In `apps/web/test/lint.test.ts`, assert that the agent/voice import scan from task 1.3 finds `app/api/crew/summary/route.ts`.
    - **Validates: Requirements 2.4, 2.5, 5.2**

- [x] 4. Final checkpoint
  - Run `pnpm --filter web test` and the web typecheck. Ensure all tests pass, ask the user if questions arise.

## Notes

- No optional tasks: every test sub-task is required.
- Each parent task ends green on tests and typecheck, so it can be one commit (git-workflow.md).
- The route-file existence assertion waits for task 3.3 because `app/api/crew/summary/route.ts` only exists after task 3.1; design.md does not address this ordering.
- Task 3.3 edits `crew-summary-route.test.ts` after task 3.2, so they run in separate waves.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "1.4"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["2.2"] },
    { "id": 3, "tasks": ["2.3"] },
    { "id": 4, "tasks": ["3.1"] },
    { "id": 5, "tasks": ["3.2"] },
    { "id": 6, "tasks": ["3.3"] },
    { "id": 7, "tasks": ["4"] }
  ]
}
```
