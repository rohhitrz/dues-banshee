# Requirements Document

## Introduction

crew-api adds one read-only machine route, `GET /api/crew/summary`, that gives the Crew app (`dues-banshee-crew`, roadmap section 7) the Demo_Supplier's graveyard as JSON (roadmap section 7a). Today the only machine route is `POST /api/ladder/run`, which writes drafts and spends LLM calls.

The route reuses what exists and computes nothing itself:
- Auth: the `bearerMatches` helper, moved from `apps/web/app/api/ladder/run/route.ts` into `apps/web/lib/bearer.ts` with no behaviour change.
- Today: `resolveToday` from `apps/web/lib/graveyard/today.ts`, as in the ladder run route.
- Data: `findSupplierIdByUdyam` and `DEMO_SUPPLIER` from `@dues-banshee/db`, then `loadGraveyardData` from `apps/web/lib/graveyard/load.ts`, which returns the `GraveyardView` built by `buildGraveyard`.
- Money text: `formatINR(paise, "full")` from the Engine.

Global rules apply: Engine output (through the `GraveyardView`) is the single source of truth for money, dates and legal values; every amount text comes from `formatINR`; the disclaimer is "Reminders a supplier sends to its own buyers. Not legal advice."; tests are mandatory and no test task may be marked optional.

Size constraint: design.md stays lean and tasks.md plans about 3 parent tasks.

Non-goals: per-invoice total due; suppliers other than the Demo_Supplier; pagination; CORS; rate limiting; any write; triggering the ladder (the Crew cron calls `POST /api/ladder/run` itself with `LADDER_RUN_SECRET`).

## Glossary

- **Summary_Route**: the `GET` handler in `apps/web/app/api/crew/summary/route.ts`.
- **Ladder_Run_Route**: the existing `POST` handler in `apps/web/app/api/ladder/run/route.ts`.
- **Bearer_Helper**: the `bearerMatches(header, secret)` function in `apps/web/lib/bearer.ts`, moved unchanged from the Ladder_Run_Route.
- **Crew_Secret**: the value of the env var `CREW_READ_SECRET`.
- **Ladder_Secret**: the value of the env var `LADDER_RUN_SECRET`.
- **Demo_Supplier**: the supplier whose Udyam number is `DEMO_SUPPLIER.udyamNumber` (`UDYAM-MH-00-0000000`).
- **Graveyard_View**, **Tombstone_View**, **Graveyard_Totals**: the `GraveyardView`, `TombstoneView` and `GraveyardTotals` types in `apps/web/lib/graveyard/build-graveyard.ts`.
- **Load_Result**: the `GraveyardLoadResult` returned by `loadGraveyardData`: `{ kind: "ok", view, ... }`, `{ kind: "stale" }` or `{ kind: "error" }`.
- **Today**: the `today` field of `resolveToday(Date.now(), searchParams.get("today") ?? undefined)`.
- **Today_Override**: true when the `override` field of that `resolveToday` result is not null.
- **Summary_Body**: the JSON body of a 200 response from the Summary_Route.
- **Disclaimer**: the exact text "Reminders a supplier sends to its own buyers. Not legal advice."
- **Proxy_Matcher**: `config.matcher` in `apps/web/proxy.ts`.
- **Bank_Rate**: the Engine's `BankRate` value `{ annualBps, asOf }` passed to `buildGraveyard`; the Graveyard_View `rulesAsOf` is its `asOf`, or null when there is none.

## Requirements

### Requirement 1: Route

**User Story:** As the Crew app, I want one stable read-only URL, so that my daily job can fetch the graveyard without a browser session.

#### Acceptance Criteria

1. THE Summary_Route SHALL be the `GET` export of `apps/web/app/api/crew/summary/route.ts` with `export const runtime = "nodejs"`, and that file SHALL export no other HTTP method handler.
2. THE Summary_Route SHALL set the response header `Cache-Control: no-store` on every response it returns: the 200, 401, 404, 500 and 503 responses.
3. THE Proxy_Matcher SHALL keep its current nine entries in their current order, so the existing assertions in `apps/web/test/proxy.test.ts` pass without edits, and no Proxy_Matcher entry SHALL match the path `/api/crew/summary`.
4. THE comment on the Proxy_Matcher in `apps/web/proxy.ts` SHALL name `/api/crew/summary` next to `/api/ladder/run` as a route that is deliberately absent from the matcher because it authenticates with its own bearer secret.

### Requirement 2: Auth and the shared Bearer_Helper

**User Story:** As the supplier, I want the feed protected by its own secret, so that only my Crew app can read my buyers' dues.

#### Acceptance Criteria

1. THE Bearer_Helper SHALL be exported from `apps/web/lib/bearer.ts` with the current `bearerMatches` logic (header matched against `^Bearer (.+)$`, SHA-256 digests of the presented token and the secret compared with `timingSafeEqual`, empty token rejected), and the Ladder_Run_Route SHALL import the Bearer_Helper instead of its local copy.
2. THE existing `apps/web/test/ladder-run-route.test.ts` SHALL pass without edits.
3. IF `CREW_READ_SECRET` is unset or empty, THEN THE Summary_Route SHALL respond 503 with body `{"error":"not_configured"}` without reading the `Authorization` header and without calling `getDb()`.
4. IF the `Authorization` header is missing, does not have the form `Bearer <token>` with a non-empty token, or carries a token the Bearer_Helper rejects against the Crew_Secret, THEN THE Summary_Route SHALL respond 401 with body `{"error":"Unauthorized"}` without calling `getDb()`.
5. IF the request presents the Ladder_Secret as its bearer token and the Ladder_Secret differs from the Crew_Secret, THEN THE Summary_Route SHALL respond 401 with body `{"error":"Unauthorized"}` without calling `getDb()`.
6. THE Summary_Route SHALL compare the presented token only with the Crew_Secret, and SHALL never write the Crew_Secret or the presented token to a response body or to any `console` method.

### Requirement 3: Data loading and Today

**User Story:** As the Crew app, I want the Demo_Supplier's graveyard for a given day, so that the demo shows the same figures as the dashboard.

#### Acceptance Criteria

1. WHEN the request is authorized, THE Summary_Route SHALL resolve Today with `resolveToday(Date.now(), searchParams.get("today") ?? undefined)`, the same call as the Ladder_Run_Route.
2. IF the `?today=` value is absent, or is not a strict `YYYY-MM-DD` real calendar date from 2024-01-01 to 2027-12-31 inclusive (the `isValidTodayOverride` rule used by `resolveToday`), THEN THE Summary_Route SHALL use the IST date of `Date.now()` as Today and report Today_Override as false.
3. WHEN the request is authorized, THE Summary_Route SHALL call `getDb()` once and look up the supplier with `findSupplierIdByUdyam(db, DEMO_SUPPLIER.udyamNumber)` on the returned database.
4. IF `findSupplierIdByUdyam` returns null, THEN THE Summary_Route SHALL respond 404 with body `{"error":"not_found"}` and SHALL NOT call `loadGraveyardData`.
5. WHEN the supplier id is found, THE Summary_Route SHALL call `loadGraveyardData(db, id, today)` exactly once, with `today` equal to the Today resolved in criterion 1.
6. IF the Load_Result kind is `stale`, THEN THE Summary_Route SHALL respond 404 with body `{"error":"not_found"}`.
7. IF the Load_Result kind is `error`, or `getDb()` throws, or `findSupplierIdByUdyam` throws, THEN THE Summary_Route SHALL respond 500 with a body exactly equal to `{"error":"load_failed"}`.
8. WHEN `getDb()` has returned, THE Summary_Route SHALL call the returned `close()` exactly once before the response is returned, on the 200, 404 and 500 paths.

### Requirement 4: Response JSON

**User Story:** As the Crew app, I want ready-to-show values with their raw paise, so that my dashboard page and tax-bomb skill do no money or date maths.

#### Acceptance Criteria

1. WHEN the Load_Result kind is `ok`, THE Summary_Route SHALL respond 200 with a Summary_Body holding exactly these top-level keys: `supplierName`, `today`, `todayOverride`, `rulesAsOf`, `disclaimer`, `totals`, `tombstones`.
2. THE Summary_Body SHALL copy `supplierName`, `today` and `rulesAsOf` unchanged from the Graveyard_View (`rulesAsOf` stays null when the Graveyard_View has null), set `todayOverride` to Today_Override, and set `disclaimer` to the Disclaimer.
3. THE Summary_Body `totals` SHALL hold exactly `outstanding`, `interestAccrued`, `deductionsAtRisk`, `explodedCount` and `paidCount`. The first three are `{ paise, text }` objects built from `outstandingPaise`, `interestAccruedPaise` and `deductionsAtRiskPaise` with `text = formatINR(paise, "full")`. `explodedCount` and `paidCount` are copied unchanged from the Graveyard_Totals.
4. IF the Graveyard_Totals `interestAccruedPaise` is null, THEN THE Summary_Body SHALL set `totals.interestAccrued` to null.
5. THE Summary_Body `tombstones` SHALL list one entry per Tombstone_View, in the same order as the Graveyard_View `tombstones`. Each entry SHALL hold exactly these keys: `id`, `buyerId`, `buyerName`, `invoiceNumber`, `state`, `stateText`, `stateRuleId`, `principal`, `dueDate`, `dueDateText`, `daysOverdue`, `interest`, `taxBomb`, `nextLabel`. Every value is copied unchanged from the Tombstone_View, including null for `stateRuleId`, `dueDate`, `dueDateText`, `interest` and `taxBomb`, except for these two keys:
   - `principal` is `{ paise: principalPaise, text: principalText }`.
   - `taxBomb`, when not null, is `{ status, daysLeft, deductionAtRiskPaise, deductionAtRiskText }` with `deductionAtRiskText = formatINR(deductionAtRiskPaise, "full")`.
6. THE Summary_Body SHALL omit the Tombstone_View fields `look`, `ariaLabel`, `caveat` and `next`.
7. THE Summary_Route SHALL use `formatINR(…, "full")` as its only value transformation, and SHALL contain no money, date or legal arithmetic.
8. WHEN Today is 2026-11-12 and the Graveyard_View is built from the demo seed with the demo Bank_Rate (`rulesAsOf` "2026-10-07"), as in `build-graveyard.test.ts`, THE Summary_Body tombstone with `invoiceNumber` "LPC/26-27/0412" SHALL have these values:
   - `buyerName` "Sharma Traders"
   - `state` "armed", `stateRuleId` "IT-43BH"
   - `principal` `{ paise: 41200000, text: "₹4,12,000" }`
   - `dueDate` "2026-10-17", `dueDateText` "17 Oct 2026"
   - `daysOverdue` 26
   - `interest` `{ paise: 512794, text: "₹5,127.94" }`
   - `taxBomb` `{ status: "armed", daysLeft: 139, deductionAtRiskPaise: 41200000, deductionAtRiskText: "₹4,12,000" }`
   - `nextLabel` "Next: WhatsApp nudge"

### Requirement 5: Read-only and lint constraints

**User Story:** As the builder, I want the feed unable to write or spend LLM calls, so that the Crew cron can poll it safely.

#### Acceptance Criteria

1. WHEN the Summary_Route handles a request, THE Summary_Route SHALL use the database only through `findSupplierIdByUdyam` and `loadGraveyardData` (plus `close()`), and SHALL call neither `fetch` nor any LLM client.
2. THE `apps/web/test/lint.test.ts` file SHALL gain a scan over every non-test source under `apps/web/app/api/crew` that fails on any static import, dynamic `import()` or re-export of `@dues-banshee/agent` or `@dues-banshee/voice` (including subpaths). The scan SHALL come with a detector test that flags a positive sample of each form and passes two near-miss samples: the package name inside a comment, and an import of `@dues-banshee/db`. The scan SHALL also assert that it finds `app/api/crew/summary/route.ts`, so it cannot pass with zero files.
3. THE `SCANNED_DIRS` list in `apps/web/test/money-lint.test.ts` SHALL include `app/api/crew`, and the Summary_Route source SHALL contain no `toFixed`, `parseFloat` or `Number(` token.

### Requirement 6: Env

**User Story:** As the owner, I want the new secret documented without a value, so that I can set it locally and on Vercel.

#### Acceptance Criteria

1. THE `apps/web/.env.example` file SHALL contain exactly one line `CREW_READ_SECRET=` with an empty value, and SHALL keep the 15 existing `NAME=` lines (`DATABASE_URL` through `DEMO_BUYER_WHATSAPP`) unchanged.
2. THE existing `.env.example` checks SHALL pass without edits. These are the "whatsapp-channel .env.example" describe block and the tracked-env-file checks in `apps/web/test/lint.test.ts`, and the public-key scan in `apps/web/test/voice-lint.test.ts`.
3. THE `apps/web/test/lint.test.ts` `.env.example` checks SHALL assert that `emptyEnvNames` of `apps/web/.env.example` contains `CREW_READ_SECRET`.

### Requirement 7: Tests

**User Story:** As the builder, I want the route pinned by tests, so that the Crew demo cannot silently break or leak data.

#### Acceptance Criteria

1. THE new `apps/web/test/crew-summary-route.test.ts` SHALL follow the style of `ladder-run-route.test.ts`: `vi.hoisted` mocks of `getDb` from `@/lib/db`, of `findSupplierIdByUdyam` from `@dues-banshee/db` and of `loadGraveyardData`, plus fake timers pinned to `2026-11-12T20:00:00Z` (IST date 2026-11-13), and SHALL build the `ok` Load_Result's Graveyard_View with `buildGraveyard` from the `DEMO_INVOICES` seed and the Bank_Rate `{ annualBps: 575, asOf: "2026-10-07" }`, as `build-graveyard.test.ts` does.
2. THE tests SHALL cover these responses, each asserting status and exact body: 503 with `CREW_READ_SECRET` unset or empty; 401 for a missing header, a wrong token and the Ladder_Secret value (with `LADDER_RUN_SECRET` set to a different value from the Crew_Secret); 404 for a null supplier lookup and for a `stale` Load_Result; 500 for an `error` Load_Result, for a throwing lookup and for a throwing `getDb()` (Requirement 3 criterion 7). The 503 and 401 tests SHALL also assert that `getDb` was not called. The throwing-`getDb()` test SHALL NOT expect `close()` to be called, because no database handle was returned.
3. THE tests SHALL check the 200 Summary_Body at `?today=2026-11-12` with the exact Sharma Traders values of Requirement 4 criterion 8, `today` "2026-11-12", the Disclaimer, `todayOverride: true`, `loadGraveyardData` called once with the demo supplier id and "2026-11-12", and the absence of `look`, `ariaLabel`, `caveat` and `next` on every tombstone.
4. THE tests SHALL check that an invalid `?today=` value (for example `2027-02-30`) makes `loadGraveyardData` receive the IST date "2026-11-13" and makes the Summary_Body hold `today` "2026-11-13" with `todayOverride: false`.
5. THE tests SHALL check that the `Cache-Control: no-store` header is set on a 200 response and on at least one 401, one 404 and one 500 response, and that `close()` is called exactly once on each 200, 404 and 500 path where `getDb()` returned.
6. THE tests SHALL check that, on the 200 path and on the throwing-lookup 500 path (where the thrown error's message contains the Crew_Secret), the Crew_Secret and the thrown error's message appear in no response body and in no argument passed to a spied `console.error`, `console.warn` or `console.log`.
