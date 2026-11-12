# Implementation Plan: ledger-import

## Overview

Build the import pipeline in the dependency order from `design.md`: engine → ledger → db → web.

1. **Engine exports.** A small export-only change to `packages/engine`.
2. **Ledger.** The pure `packages/ledger` package, built bottom-up: amount, date, CSV, headers, then row mapping.
3. **Db.** `packages/db`: schema and migrations, then queries and the import, then seed and reset.
4. **Web.** `apps/web`: auth first, then the import routes, then the page.

Each package's `src/index.ts` re-exports a module when the module is written, so no code is left unwired.

Commit rules for every task (from `.kiro/steering/git-workflow.md`, Requirement 14):
- Commit only when `test`, `typecheck` and `lint` pass for every package the task touched. Tests run once with `vitest run`, never in watch mode.
- Make one commit per top-level task. The message is `<type>(<scope>): <subject>` with scope `engine`, `ledger`, `db`, `web` or `kiro`, at most 72 characters, imperative mood. The body is `Spec: ledger-import, task <n>`.
- Stage files by explicit path (`git add <paths>`). Quote any path containing `(`, `)`, `[` or `]`, because zsh treats them as glob characters. Run `git diff --staged` and confirm there are no `.env` files, keys, tokens or connection strings.
- Use the existing git identity. Add no `Co-Authored-By` or AI attribution trailers. Never push.
- Keep `.kiro/` and all its sub-folders tracked.
- Never commit a real `DATABASE_URL` or `AUTH_SECRET`. Tests use PGlite and need neither.

## Tasks

- [x] 1. Export validation helpers and supplier constants from the engine
  - [x] 1.1 Change `packages/engine/src/validate.ts` and `src/index.ts`
    - In `validate.ts`, replace the private `SUPPLIER_CATEGORIES` / `SUPPLIER_ACTIVITIES` arrays with exported frozen tuples (`Object.freeze([...] as const satisfies readonly SupplierCategory[])`). `validateInvoice` keeps using them, with no behaviour change
    - In `index.ts`, add `export { validateInvoice, SUPPLIER_CATEGORIES, SUPPLIER_ACTIVITIES } from "./validate"` and `export { isValidCalendarDate, fromEpochDay } from "./calendar-date"`
    - Change nothing else in `packages/engine/src`
    - _Requirements: 2.1, 2.2, 2.4_
  - [x] 1.2 Add `packages/engine/test/exports.test.ts`
    - The five names are importable from `../src/index`
    - `SUPPLIER_CATEGORIES` equals `["micro", "small", "medium", "unregistered"]` and `SUPPLIER_ACTIVITIES` equals `["manufacturing", "services", "trading"]`, in order, and both are frozen
    - `validateInvoice` throws `ValidationError` on `supplierCategory: "large"` (proves the exported constant is the one in use)
    - Run the full engine suite. Every existing test passes unchanged
    - _Requirements: 2.1, 2.2, 2.3_
  - [x] 1.3 Commit task 1
    - `git add packages/engine/src/validate.ts packages/engine/src/index.ts packages/engine/test/exports.test.ts`
    - Check `git diff --staged`. Commit `refactor(engine): export validation helpers and supplier constants`, body `Spec: ledger-import, task 1`
    - _Requirements: 14.1, 14.2, 14.3_

- [x] 2. Set up `packages/ledger`, its purity lint rules and its test-on-save hook
  - [x] 2.1 Create the package skeleton
    - `package.json`: name `@dues-banshee/ledger`, `type: module`, `exports: { ".": "./src/index.ts" }`, `dependencies: { "@dues-banshee/engine": "workspace:*" }`, scripts `test: vitest run`, `typecheck: tsc --noEmit`, `lint: eslint src test`
    - `tsconfig.json` like the engine's (extends `../../tsconfig.base.json`, `lib: ["ES2022"]`, `types: []`, includes `src` and `test`)
    - `vitest.config.ts` like the engine's, and `test/setup.ts` with `fc.configureGlobal({ numRuns: 200 })`
    - Empty `src/index.ts`
    - Run `pnpm install`
    - _Requirements: 1.1, 1.2_
  - [x] 2.2 Extend `eslint.config.js` to `packages/ledger/src/**/*.ts`
    - Apply the engine's existing `no-restricted-globals`, `no-restricted-imports` and `Math.random` rules to the ledger path too, with messages naming `packages/ledger`
    - Add to the ledger block:
      - `parseFloat` to the restricted globals;
      - `no-restricted-properties` for `Number.parseFloat` and for any `.toFixed`;
      - `no-restricted-syntax` with selector `Literal[raw=/^(\d[\d_]*)?\.\d|^\d[\d_]*[eE]/]` and message "no fractional or exponent literals in packages/ledger".
    - _Requirements: 1.3, 1.4_
  - [x] 2.3 Add `packages/ledger/test/lint.test.ts`
    - Use ESLint's Node API (`new ESLint({ cwd: <repo root> })`, `lintText(code, { filePath: "packages/ledger/src/__lint_fixture__.ts" })`) on a snippet containing `parseFloat("1")`, `const a = 0.5`, `const b = 1e3`, `x.toFixed(2)`, `Date.now()` and `Math.random()`
    - Expect exactly six errors, one per construct
    - Lint the same snippet as `packages/ledger/test/x.ts` and expect no restricted-rule errors (tests may use `Date`)
    - _Requirements: 1.3, 1.4_
  - [x] 2.4 Extend the tests-on-save hook to the ledger
    - In `.kiro/hooks/engine-tests-on-save.json`, add a second entry to the `hooks` array. Leave the existing engine entry unchanged:
      ```json
      {
        "name": "Ledger tests on save",
        "trigger": "PostFileSave",
        "action": {
          "type": "command",
          "command": "date >> /tmp/ledger-hook.log; pnpm --filter @dues-banshee/ledger test 2>&1 | tee -a /tmp/ledger-hook.log"
        },
        "description": "Runs the ledger's unit and property tests whenever a file under packages/ledger is saved.",
        "matcher": "packages/ledger/.*",
        "enabled": true
      }
      ```
    - Confirm the file is still valid JSON (`node -e 'JSON.parse(require("fs").readFileSync(".kiro/hooks/engine-tests-on-save.json","utf8"))'`)
    - Save a file under `packages/ledger/src` and confirm `/tmp/ledger-hook.log` gets a new timestamped run. Then save a file under `packages/engine/src` and confirm only the engine hook runs
    - _Requirements: 1.1 (test tooling for the ledger package)_
  - [x] 2.5 Commit task 2
    - `git add packages/ledger eslint.config.js pnpm-lock.yaml .kiro/hooks/engine-tests-on-save.json`
    - Check `git diff --staged`. Commit `chore(ledger): set up ledger package with purity lint and test hook`, body `Spec: ledger-import, task 2`
    - _Requirements: 14.1, 14.2, 14.3_

- [x] 3. Add lenient amount parsing
  - [x] 3.1 Create `src/types.ts`
    - All types from the design's Types section, exactly: `ImportField`, `RawRow`, `RawTable`, `SupplierFacts`, `ColumnRef`, `HeaderMapping`, `RowError`, `DedupeKey`, `OkRow`, `ErrorRow`, `RowResult`, `FileErrorCode`, `FileError`, `ImportParse`, `StoredInvoiceFacts`
    - Re-export the types from `src/index.ts`
    - _Requirements: 6.1, 6.7_
  - [x] 3.2 Implement `src/amount.ts`
    - Use the single anchored, case-insensitive regex from the design: prefix, plain/Indian/western number, fraction, unit (longest first: `lakhs|lakh|lacs|lac|l|crores|crore`), `/-`, Balance_Suffix `dr|cr`
    - Follow the design's steps 1–6 in order. Arithmetic is BigInt only: `scaled = BigInt(digits) × multiplier`, `den = 10n ** BigInt(frac.length)`, reject on a non-zero remainder, reject above `BigInt(Number.MAX_SAFE_INTEGER)`
    - Return `new ValidationError("amount", reason, raw)` and never throw. Reasons are exactly as in the design's Error Handling table, with `JSON.stringify(raw)` as the quoted input
    - Don't import `parseINR`
    - Re-export `parseAmountLenient` from `src/index.ts`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 1.5_
  - [x] 3.3 Write `test/amount.test.ts`
    - One `it.each` over the 3.6 table, asserting exact paise
    - One `it.each` over every 3.7 input, asserting `instanceof ValidationError`, `field === "amount"` and the exact reason string. `4,12,000.00 Cr` and `4.12 Cr` get the credit-balance reason
    - _Requirements: 3.3, 3.6, 3.7_
  - [x] 3.4 Write `test/arbitraries.ts` and `test/amount.property.test.ts`
    - `arbPaise` and `arbAmountText(p)` as in the design's Generators section. The renderers don't call `parseAmountLenient` or share code with `amount.ts`. The Indian style uses the Engine's `formatINR(p, "full")` as its oracle
    - **Property 1: Every accepted amount style parses back to the same paise**
    - **Validates: Requirements 3.2, 3.4, 3.8**
  - [x] 3.5 Commit task 3
    - `git add packages/ledger/src packages/ledger/test`
    - Check `git diff --staged`. Commit `feat(ledger): add parseAmountLenient with lakh, crore and Dr support`, body `Spec: ledger-import, task 3`
    - _Requirements: 14.1, 14.2, 14.3_

- [x] 4. Add lenient date and credit-days parsing
  - [x] 4.1 Implement `src/date.ts`
    - Test the patterns in the design's order:
      1. all digits → Excel_Serial (36526–73050 → `fromEpochDay(n − 25569)`, else the range reason);
      2. ISO;
      3. day-month-year with the `\2` separator back-reference;
      4. a numeric two-digit year → rejected;
      5. `D-Mon-YYYY` / `D-Mon-YY` (two-digit year → `20YY`, unknown month → reason);
      6. anything else → `not a recognised date`.
    - Zero-pad the parts, then check with the Engine's `isValidCalendarDate`
    - Export `EXCEL_SERIAL_MIN = 36526` and `EXCEL_SERIAL_MAX = 73050`. Errors use field `date`, returned and never thrown
    - Re-export from `src/index.ts`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 1.5_
  - [x] 4.2 Implement `src/credit-days.ts`
    - Regex `^(?:net\s*)?(\d{1,6})(?:\s*days?)?$`, case-insensitive. Blank → `undefined`. Otherwise `ValidationError("creditDays", "not a number of days: <quoted raw>")`
    - `0` returns 0. The Engine rejects it later
    - Re-export from `src/index.ts`
    - _Requirements: 6.2_
  - [x] 4.3 Write `test/date.test.ts`
    - `it.each` over the 4.5 table, asserting exact Calendar_Dates
    - `it.each` over every 4.6 input, asserting `field === "date"` and the exact reason
    - _Requirements: 4.5, 4.6_
  - [x] 4.4 Write `test/credit-days.test.ts`
    - `45` → 45, `45 days` → 45, `Net 30` → 30, `1 day` → 1, `NET 15 DAYS` → 15, blank → `undefined`, `abc` and `1234567` → `ValidationError` with the exact reason
    - _Requirements: 6.2_
  - [x] 4.5 Commit task 4
    - `git add packages/ledger/src packages/ledger/test`
    - Check `git diff --staged`. Commit `feat(ledger): add parseDateLenient and parseCreditDays`, body `Spec: ledger-import, task 4`
    - _Requirements: 14.1, 14.2, 14.3_

- [x] 5. Add the CSV parser, normalisation keys and header detection
  - [x] 5.1 Implement `src/csv.ts`
    - Write the RFC 4180 state machine from the design: strip the BOM, comma delimiter, quoted fields with `""` escapes and embedded commas and line breaks, CRLF/LF/lone-CR record ends, no empty record after a final line break, `csv_syntax` on an unterminated quote naming the record number
    - Cells are plain strings. `rowNumber` is the 1-based record number
    - Re-export from `src/index.ts`
    - _Requirements: 5.1_
  - [x] 5.2 Write `test/csv.test.ts`
    - Exact cells and row numbers for: a quoted `"4,12,000"`, a `""` escape, CRLF, LF, lone CR, a leading BOM, a newline inside quotes (the next record keeps record numbering), a trailing newline, and an empty quoted field
    - Unterminated quote → `{ ok: false, error.code: "csv_syntax" }`
    - _Requirements: 5.1_
  - [x] 5.3 Implement `src/keys.ts` and `src/headers.ts`
    - `keys.ts`: `headerKey`, `textKey` and `dedupeKey` exactly as in the design. `value` is `JSON.stringify([supplierId, buyerKey, invoiceNumberKey])`
    - `headers.ts`: `HEADER_ALIASES`, `REQUIRED_FIELDS`, the Header_Key map, the Acceptance_Group and Delivery_Group key sets, and `detectHeader`, following design steps 1–4. The scan covers the first 20 rows. The acceptance-plus-delivery case maps the acceptance column and marks the delivery column unused. Any other repeat → `duplicate_header` naming every column. With no qualifying row → `missing_headers` against the best row
    - Re-export from `src/index.ts`
    - _Requirements: 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 7.1_
  - [x] 5.4 Write `test/headers.test.ts` and `test/keys.test.ts`
    - No Header_Key appears under two fields. `Invoice #` and `Invoice` map to `invoiceNumber`
    - Tally bills-receivable fixture with 3 title rows: header row 4; `Date`, `Ref. No.`, `Party's Name` and `Pending Amount` mapped; `Opening Amount`, `Due on` and `Overdue by days` unused
    - Each Delivery_Group header alone → `acceptanceDate` (three tests)
    - `Acceptance Date` + `Delivery Date` → acceptance mapped, delivery unused
    - `Delivery Date` + `Delivered On`, `Acceptance Date` + `Accepted On`, and `Amount` + `Total` → `duplicate_header` naming both columns
    - No qualifying row in the first 20 (and a valid header on row 21) → `missing_headers` listing the missing fields and their aliases
    - `textKey("  SHARMA   traders ") === textKey("Sharma Traders")`. `INV/001` and `INV-001` give different keys. A buyer name containing `"` or `,` still gives a distinct `value`
    - _Requirements: 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.12, 7.1, 7.2_
  - [x] 5.5 Commit task 5
    - `git add packages/ledger/src packages/ledger/test`
    - Check `git diff --staged`. Commit `feat(ledger): add CSV parser and header detection`, body `Spec: ledger-import, task 5`
    - _Requirements: 14.1, 14.2, 14.3_

- [x] 6. Map rows to engine invoices and build the import
  - [x] 6.1 Implement `src/map-row.ts`
    - Follow the design's steps 1–5:
      1. collect every field error (`is required`, or the parser's reason) with the column header as written;
      2. return `{ ok: false }` if there were any;
      3. build the `Invoice` from the supplier only, with `agreedTermDays` omitted when blank, `acceptedOn` defaulted to the invoice date with the flag set, and `id = dedupeKey.value`;
      4. call `validateInvoice`, mapping `amountPaise`, `acceptedOn` and `agreedTermDays` to columns and rethrowing anything else;
      5. add the MSMED-15 warning for terms above 45.
    - Re-export from `src/index.ts`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8_
  - [x] 6.2 Implement `src/build-import.ts` and `src/compare.ts`
    - `buildImport`: check the supplier (membership in `SUPPLIER_CATEGORIES` and `SUPPLIER_ACTIVITIES`, `isValidCalendarDate` for `udyamRegisteredOn`) → `invalid_supplier`. Then `detectHeader`, skip all-blank mapped rows, `mapRow` the rest, and turn later same-key `ok` rows into `Duplicate of row N` on the invoice-number column
    - `compareWithStored`: `null` when equal, otherwise `Differs from stored invoice: ` plus the differing fields in the order `amount`, `invoice date`, `accepted date`
    - Re-export both from `src/index.ts`
    - _Requirements: 5.11, 6.9, 7.3, 10.6_
  - [x] 6.3 Write `test/map-row.test.ts`
    - Sharma row (6.10): `ok: true`, `amountPaise` 41_200_000, `acceptedOn` 2026-09-02, `agreedTermDays` 45, `acceptanceDateDefaulted: true`, `buyerName` `Sharma Traders`, `invoiceNumber` `LPC/26-27/0412`, supplier facts copied from the supplier
    - Blank buyer plus bad amount → exactly two errors, one per column
    - Amount `0`, amount `₹1,000.01 crore` and credit days `0` → the Engine's reason on the amount or credit-days column
    - Bad invoice date with no acceptance column → error on the invoice-date column
    - Credit days `60` → `ok: true` with the exact MSMED-15 warning
    - A `Delivery Date` cell is used as `acceptedOn` and the defaulted flag is false
    - _Requirements: 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.10_
  - [x] 6.4 Write `test/build-import.test.ts` and `test/compare.test.ts`
    - All-blank data row → skipped (no Row_Result)
    - Supplier category `large` → `invalid_supplier`, and no row is mapped
    - The same key twice (`Sharma Traders` / `  SHARMA   traders `, same invoice number) → the second row is `Duplicate of row N` with the first row's number
    - `compareWithStored` with each of the 8 subsets of {amount, invoice date, accepted date} → `null` or the exact warning text in the fixed order
    - _Requirements: 5.11, 6.9, 7.2, 7.3, 10.6_
  - [x] 6.5 Commit task 6
    - `git add packages/ledger/src packages/ledger/test`
    - Check `git diff --staged`. Commit `feat(ledger): map rows to engine invoices with dedupe keys`, body `Spec: ledger-import, task 6`
    - _Requirements: 14.1, 14.2, 14.3_

- [ ] 7. Set up `packages/db` with the schema and migrations
  - [ ] 7.1 Create the package skeleton
    - `package.json`: name `@dues-banshee/db`, `type: module`, `exports: { ".": "./src/index.ts", "./testing": "./src/testing.ts" }`
    - Dependencies: `@dues-banshee/engine` and `@dues-banshee/ledger` (`workspace:*`), `drizzle-orm`, `@neondatabase/serverless`. Dev dependencies: `drizzle-kit`, `@electric-sql/pglite`, `tsx`. Pin the latest stable versions at install time and check them against the design's research notes
    - Scripts: `test: vitest run`, `typecheck: tsc --noEmit`, `lint: eslint src test scripts`, `db:generate: drizzle-kit generate`, `db:migrate: drizzle-kit migrate`, `db:seed: tsx scripts/seed.ts`, `db:reset-demo: tsx scripts/reset-demo.ts`
    - `drizzle.config.ts` with dialect `postgresql`, schema `./src/schema.ts`, out `./drizzle`, and `dbCredentials.url` from `process.env.DATABASE_URL`
    - `tsconfig.json` (`types: ["node"]`), `vitest.config.ts`, and `test/setup.ts` (no global `numRuns`)
    - _Requirements: 8.9, 1.1_
  - [ ] 7.2 Implement `src/schema.ts`
    - Enums from Engine constants through the `tuple()` helper: `ladder_step`, `approval_step`, `supplier_category`, `supplier_activity`, plus `approval_status` (`pending`, `approved`, `rejected`)
    - All 11 tables with the columns, types and constraints in the design's Tables section:
      - every table: uuid ids, `created_at timestamptz`;
      - money as `bigint` in number mode, calendar dates as `date` in string mode, foreign keys `on delete restrict`;
      - `escalation_events.occurred_on`;
      - `suppliers`: `udyam_number` check regex and unique;
      - `buyers`: `unique(supplier_id, name_key)` and `unique(id, supplier_id)`;
      - `invoices`: unique on the dedupe key, composite FK to buyers, amount check from `MAX_PAISE`, positive-term check;
      - `config`: `unique(key, effective_from)`.
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_
  - [ ] 7.3 Implement `src/client.ts` and `src/testing.ts`, then generate the migration
    - `client.ts`: `createDb(url)` returns `{ db, close }` using `drizzle-orm/neon-serverless` with a `Pool`. Export `type Db`, satisfied by both the Neon and PGlite Drizzle instances
    - `testing.ts`: `createTestDb()` runs in-memory PGlite with `migrate()` from `drizzle-orm/pglite/migrator` on `./drizzle`. `cloneTestDb(template)` wraps `pglite.clone()` in a Drizzle instance
    - Run `pnpm --filter @dues-banshee/db db:generate` and commit the generated SQL under `packages/db/drizzle/`. Read the SQL and confirm every constraint from 7.2 is present
    - Re-export the client and schema from `src/index.ts`
    - _Requirements: 8.1, 8.9_
  - [ ] 7.4 Write `test/schema.test.ts` (PGlite)
    - Values from `pg_enum` ordered by `enumsortorder` equal `LADDER_STEPS`, `APPROVAL_STEP_LIST`, `SUPPLIER_CATEGORIES` and `SUPPLIER_ACTIVITIES` exactly, in order
    - `UDYAM-mh-00-0000000` and `UDYAM-MH-0-0000000` violate the check. `UDYAM-MH-00-0000000` is accepted
    - A raw duplicate (supplier, buyer, invoice_number_key) → unique violation. An invoice pointing at another supplier's buyer → FK violation. `amount_paise` 0 and `MAX_PAISE + 1` → check violation. `agreed_term_days` 0 → check violation
    - A `date` column round-trips as `"2026-09-02"`. `amount_paise` 10¹³ round-trips as the number 10000000000000
    - _Requirements: 8.2, 8.3, 8.4, 8.5, 8.6_
  - [ ] 7.5 Commit task 7
    - `git add packages/db pnpm-lock.yaml`
    - Check `git diff --staged` (`drizzle.config.ts` must read the URL from the environment, never contain one). Commit `feat(db): add Drizzle schema and initial migration`, body `Spec: ledger-import, task 7`
    - _Requirements: 14.1, 14.2, 14.3_

- [ ] 8. Add supplier, bank-rate and idempotent invoice import queries
  - [ ] 8.1 Implement `src/suppliers.ts` and `src/bank-rate.ts`
    - `getSupplier(db, id)` returns `SupplierFacts & { name, udyamNumber }`, omitting `udyamRegisteredOn` when null. `findSupplierIdByUdyam(db, udyamNumber)` returns an id or `null`
    - `getBankRate(db, today)`: check `today` with `isValidCalendarDate`, select the latest `effective_from <= today` for `BANK_RATE_KEY`, return `{ annualBps, asOf }`, or throw `config "rbi_bank_rate_bps": no row effective on or before <today>`
    - Re-export from `src/index.ts`
    - _Requirements: 9.1, 9.2, 9.3_
  - [ ] 8.2 Implement `src/invoices.ts`
    - `insertInvoiceRows(tx, supplierRow, rows)` (not exported from `index.ts`): the only writer of `invoices`. Its row type has no category or activity fields. It copies the Supplier_Snapshot from `supplierRow`. Inserts run in chunks of 500 with `ON CONFLICT (supplier_id, buyer_id, invoice_number_key) DO NOTHING RETURNING id`
    - `importInvoices(db, supplierId, rows)`, all in one transaction:
      1. assert every `dedupeKey.supplierId` matches;
      2. select the supplier;
      3. insert the distinct buyers with `ON CONFLICT DO NOTHING`, then select their ids;
      4. call `insertInvoiceRows`;
      5. return `{ inserted, skipped }`.
    - `findStoredInvoices(db, supplierId, keys)` uses one query with `unnest` and returns a `Map<DedupeKey.value, StoredInvoiceFacts>`
    - `toEngineInvoice(invoice, supplier)` maps fields only: snapshot category and activity, `udyamRegisteredOn` from the supplier, null optionals omitted
    - Re-export the public functions from `src/index.ts`
    - _Requirements: 8.7, 8.8, 10.1, 10.2, 10.3, 10.4, 10.5_
  - [ ] 8.3 Write `test/queries.test.ts` (PGlite)
    - `getBankRate` with config rows inserted in the test: the latest row on or before `today` wins, `asOf` equals its `effective_from`, it throws before the first row, and it throws on an invalid `today`
    - Import 3 rows, then import them again → `{ inserted: 3, skipped: 0 }` then `{ inserted: 0, skipped: 3 }`
    - **Rollback after a partial write.**
      - Input: 3 valid `OkRow`s from `mapRow` (with new buyer names), followed by one hand-built `OkRow` for the same supplier with a valid `dedupeKey` and `invoice.amountPaise` 0. `mapRow` would reject 0, so build it directly.
      - What happens: the buyers insert succeeds inside the transaction, then the invoice insert fails on the `invoices_amount_range` check constraint.
      - Assert: `importInvoices` rejects, and the error names `invoices_amount_range`. Afterwards `buyers` and `invoices` are both empty (count 0), which shows the buyer rows were rolled back too
    - After import, every invoice's `supplier_category` / `supplier_activity` equals its supplier's values
    - `findStoredInvoices` returns the stored amount and dates for the existing keys only
    - `toEngineInvoice` returns exact fields, with `agreedTermDays`, `paidOn` and `udyamRegisteredOn` omitted when null (checked with `Object.hasOwn`)
    - _Requirements: 8.7, 8.8, 9.2, 9.3, 10.1, 10.2, 10.3, 10.4, 10.5, 10.9_
  - [ ] 8.4 Write `test/arbitraries.ts` and `test/import.property.test.ts`
    - Build `arbImportRows` and `N` as in the design's Generators section. Rows go through the Ledger's `mapRow` with the demo supplier's facts
    - `beforeAll`: a migrated template with one supplier. Each run: `cloneTestDb(template)`, import the list N times, assert the invoice count equals the number of distinct `dedupeKey.value`s and that `inserted === 0` after the first import, then close the clone. Use `numRuns: 50` on this assertion
    - **Property 2: Re-importing never adds invoices**
    - **Validates: Requirements 7.1, 7.2, 8.5, 10.1, 10.2, 10.8**
  - [ ] 8.5 Commit task 8
    - `git add packages/db/src packages/db/test`
    - Check `git diff --staged`. Commit `feat(db): add idempotent invoice import and bank-rate lookup`, body `Spec: ledger-import, task 8`
    - _Requirements: 14.1, 14.2, 14.3_

- [ ] 9. Add the demo seed and the demo reset
  - [ ] 9.1 Implement `src/seed.ts` and `scripts/seed.ts`
    - Export `DEMO_SUPPLIER` ("Laxmi Precision Components (Demo)", `UDYAM-MH-00-0000000`, `micro`, `manufacturing`, registered 2024-04-15) and `DEMO_INVOICES`, the six rows of the 11.4 table, with `invoice_date` equal to the accepted date and `acceptance_date_defaulted` false
    - `seed(db)` runs in one transaction:
      1. insert the supplier with `ON CONFLICT (udyam_number) DO NOTHING`, then read it back;
      2. insert config `rbi_bank_rate_bps` 575 effective 2026-10-07 with `ON CONFLICT DO NOTHING`;
      3. insert the buyers with `ON CONFLICT DO NOTHING`, then the invoices through `insertInvoiceRows`.
    - `scripts/seed.ts`: read `DATABASE_URL` (exit 1 if unset), `createDb`, `seed`, `close`
    - Re-export `seed`, `DEMO_SUPPLIER` and `DEMO_INVOICES` from `src/index.ts`
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.6, 9.1_
  - [ ] 9.2 Implement `src/reset.ts` and `scripts/reset-demo.ts`
    - `RESET_TABLES`: every table except `config`, as listed in the design. `resetDemo(db)` runs `TRUNCATE <tables> RESTART IDENTITY CASCADE` then `seed(tx)` in one transaction
    - `scripts/reset-demo.ts`: without `--yes` in `process.argv`, print the refusal message and exit 1 before creating a client. Exit 1 if `DATABASE_URL` is unset. Otherwise print the target host only (never user or password), run `resetDemo`, print `Demo data reset.`, and close the client. Export a `main(argv, env, deps)` so the test can call it without spawning a process
    - Add the script and its `--yes` usage to the repository README's database section
    - _Requirements: 11.1 (supports the design's demo reset)_
  - [ ] 9.3 Write `test/seed.test.ts` (PGlite)
    - Seeding twice gives identical contents (natural-column comparison as in the design) and the same row counts
    - Load each seeded invoice with `toEngineInvoice` and run the Engine at `today` 2026-11-12 with `getBankRate(db, "2026-11-12")`:
      - Sharma: due 2026-10-17, `accrualDays` 26, `interestPaise` 512794, tax bomb `armed` with `daysLeft` 139, `nextEscalationStep` `advance` `whatsapp_nudge`
      - Gupta: due 2026-11-16, interest 0, ladder `wait` `not_overdue`
      - Kumar: due 2026-08-16, `accrualDays` 88
      - Verma: tax bomb `defused`, ladder `wait` `paid`
      - Mehta: due 2026-05-04, tax bomb `exploded`, `deductionDeadline` 2026-05-04
      - Bansal: `coverage` equals `{ applicable: true, caveat: "registered_after_supply", ruleIds: ["MSMED-SCOPE"] }`, due 2024-03-31, `accrualDays` 956, `interestPaise` 3167411, tax bomb `exploded`
    - `getBankRate` after seed: 2026-10-07 and 2026-11-12 → `{ annualBps: 575, asOf: "2026-10-07" }`; 2026-10-06 → throws
    - Every seeded invoice's Supplier_Snapshot is `micro` / `manufacturing`
    - _Requirements: 8.7, 9.4, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_
  - [ ] 9.4 Write `test/reset.test.ts` (PGlite)
    - `RESET_TABLES` equals every table name from `schema.ts` except `config`, as sets
    - Seed, import 3 extra rows, add a second config row, then `resetDemo` → contents equal a fresh seeded clone. The extra config row survives
    - `resetDemo` with `seed` forced to throw (`vi.spyOn`) → rejects, and the 3 extra rows are still present
    - `main([], env, deps)` → exit code 1, the refusal message, and the `createDb` stub never called. `main(["--yes"], {}, deps)` → exit code 1 (no `DATABASE_URL`)
    - _Requirements: 11.1 (supports the design's demo reset)_
  - [ ] 9.5 Commit task 9
    - `git add packages/db/src packages/db/scripts packages/db/test README.md`
    - Check `git diff --staged`. Commit `feat(db): add demo seed and guarded demo reset`, body `Spec: ledger-import, task 9`
    - _Requirements: 14.1, 14.2, 14.3_

- [ ] 10. Add the Next.js app with one-click demo sign-in
  - [ ] 10.1 Create the `apps/web` skeleton
    - `package.json`: name `web`, dependencies `next`, `react`, `react-dom`, `next-auth@5.0.0-beta.32` (pinned exactly, since it's a beta), `exceljs`, and `@dues-banshee/engine`, `ledger` and `db` (`workspace:*`). Dev dependencies `@types/react` and `@types/react-dom`. Pin the latest stable versions at install time
    - Scripts: `dev: next dev`, `build: next build`, `test: vitest run`, `typecheck: tsc --noEmit`, `lint: eslint .`
    - `next.config.ts` with `transpilePackages: ["@dues-banshee/engine", "@dues-banshee/ledger", "@dues-banshee/db"]`, `tsconfig.json` with the `@/*` path alias to the app root, `app/layout.tsx`, and `vitest.config.ts` (node environment, same alias)
    - Confirm `next build` accepts the root TypeScript version. If it doesn't, stop and report before changing versions
    - _Requirements: 12.1, 1.1_
  - [ ] 10.2 Add `lib/db.ts`, `auth.config.ts`, `auth.ts` and the auth route
    - `lib/db.ts`: `getDb()` reads `DATABASE_URL` (throws if unset) and returns `createDb(url)`
    - `auth.config.ts`: as in the design. JWT session, `pages.signIn: "/signin"`, `providers: []`, `jwt` and `session` callbacks copying `supplierId`, no Db imports
    - `auth.ts`: `NextAuth({ ...authConfig, providers: [Credentials({ id: "demo", credentials: {}, authorize: authorizeDemo })] })`. `authorizeDemo` uses `getDb()` and `findSupplierIdByUdyam(DEMO_SUPPLIER.udyamNumber)`, closes the client in `finally`, and returns `{ id: "demo-user", name: "Demo owner", supplierId }` or `null`
    - `types/next-auth.d.ts` adds `supplierId` to `Session`, `User` and `JWT`. `app/api/auth/[...nextauth]/route.ts` exports `handlers`
    - _Requirements: 12.1, 12.3_
  - [ ] 10.3 Add `proxy.ts` and its import ban
    - `proxy.ts`: exactly the design's snippet. `const { auth } = NextAuth(authConfig)` from `./auth.config` only, with 401 JSON for `/api/*`, a redirect to `/signin` for pages, and the matcher for `/import`, `/graveyard`, `/debtor` and `/api/import`
    - `eslint.config.js`: a `no-restricted-imports` block for `apps/web/proxy.ts` and `apps/web/auth.config.ts` banning `./auth`, `@/auth`, `@/lib/db`, `./lib/db` and `@dues-banshee/db`
    - `apps/web/test/lint.test.ts`: a `proxy.ts` snippet importing `./auth` gives exactly one error, and the real `proxy.ts` and `auth.config.ts` give none
    - _Requirements: 12.4_
  - [ ] 10.4 Add the sign-in page, the protected layout, `.env.example` and the README note
    - `app/(site)/signin/page.tsx`: one `<form action={signInDemo}>` with a single `<button>Enter the graveyard (demo)</button>` and no inputs. `signInDemo` is a server action calling `signIn("demo", { redirectTo: "/import" })`. Show "Demo data is not seeded" when sign-in fails
    - `app/(app)/layout.tsx`: `auth()`, then `redirect("/signin")` when there is no `supplierId`. A placeholder `app/(app)/import/page.tsx` ("Import coming in task 12") so the redirect target exists
    - `apps/web/.env.example` with `DATABASE_URL=` and `AUTH_SECRET=` and no values
    - README: the demo sign-in is for judging only, and production would use phone OTP. Add local setup lines (`.env.local`, `db:migrate`, `db:seed`)
    - _Requirements: 12.1, 12.2, 12.6_
  - [ ] 10.5 Write `apps/web/test/auth.test.ts`
    - With `vi.mock("@/lib/db")` returning a seeded PGlite clone: `authorizeDemo()` returns `supplierId` equal to the seeded demo supplier's id. On an unseeded clone it returns `null`. The mocked `close` is called both times
    - The `jwt` and `session` callbacks copy `supplierId` from user to token to session
    - _Requirements: 12.2, 12.3_
  - [ ] 10.6 Commit task 10
    - `git add apps/web eslint.config.js pnpm-lock.yaml README.md` (the parent directory `apps/web` covers `app/(site)`, `app/(app)` and `app/api/auth/[...nextauth]`, so no bracketed path is typed)
    - Check `git diff --staged`: no `.env.local`, and `.env.example` has no values. Commit `feat(web): add Next.js app with one-click demo sign-in`, body `Spec: ledger-import, task 10`
    - _Requirements: 14.1, 14.2, 14.3_

- [ ] 11. Add the import preview and commit routes
  - [ ] 11.1 Implement `lib/import/limits.ts`, `read-xlsx.ts` and `read-upload.ts`
    - `limits.ts` imports nothing. It exports `MAX_UPLOAD_BYTES = 4 * 1024 * 1024`, `MAX_DATA_ROWS = 5000`, `MULTIPART_OVERHEAD_BYTES = 64 * 1024`, and `uploadTooLargeMessage()` → `File is larger than 4 MB`
    - `read-xlsx.ts`: the first worksheet, `eachRow({ includeEmpty: false })`, `cellText` per the design's table (numbers → `String(value)`, dates → UTC `YYYY-MM-DD`, formulas → their result, recursively, rich text and hyperlinks → text, errors → the code), keeping worksheet row numbers
    - `read-upload.ts`: the checks in the design's table, in order (size → 413, `.csv` UTF-8 decode and `parseCsv`, `.xlsx` magic bytes and `readXlsx`, other → 415, row-count guard)
    - _Requirements: 5.2, 13.2_
  - [ ] 11.2 Implement `lib/import/analyse.ts`
    - `analyseUpload(db, supplierId, file)`:
      1. `readUpload`;
      2. `getSupplier`;
      3. `buildImport` (file errors → 422);
      4. more than `MAX_DATA_ROWS` data rows → 422;
      5. `findStoredInvoices`;
      6. classify `new` / `already_imported` (plus the `compareWithStored` warning) / `error`.
    - `amountText` is `formatINR(amountPaise, "full")`. Return `PreviewResponse` and `okRows`
    - _Requirements: 10.5, 10.6, 13.3, 13.4_
  - [ ] 11.3 Implement the preview and commit routes
    - Both: `auth()` from `@/auth`, 401 without `supplierId`. `Content-Length` over `MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES` → 413 before reading the body. Read `formData().get("file")`, `getDb()`, `close()` in `finally`, and take `supplierId` from the session only
    - Preview returns the `PreviewResponse`. Commit reruns `analyseUpload`, calls `importInvoices(db, supplierId, okRows)`, and returns `{ inserted, skipped, errors }`
    - Unexpected errors → 500 `Import failed. Nothing was saved.`, logging the error and row numbers but never cell contents
    - _Requirements: 10.1, 12.5, 13.3, 13.5, 13.6, 13.7_
  - [ ] 11.4 Write `apps/web/test/read-upload.test.ts`
    - Build a workbook with exceljs in the test containing:
      - a header row;
      - an amount cell of 412000.6 with `numFmt "#,##0"`;
      - a date cell for 2026-09-02;
      - a formula cell with a numeric cached result.

      `readUpload` then `buildImport` gives `amountPaise` 41_200_060, the date cell `"2026-09-02"`, and the formula cell's result text
    - 4 MB + 1 byte → 413. `.txt` → 415. Invalid UTF-8 CSV → 422. `.xlsx` without the `PK` header → 422. A CSV with 5,001 data rows → 422
    - `MAX_UPLOAD_BYTES === 4 * 1024 * 1024`
    - _Requirements: 5.2, 5.3, 13.2_
  - [ ] 11.5 Write `apps/web/test/import-routes.test.ts`
    - Setup: `vi.mock("@/lib/db")` returns a seeded PGlite clone per test with `close` as a no-op, and `vi.mock("@/auth")` controls the session. Call the route handlers directly with `Request` objects carrying `FormData`
    - `auth` → `null`: preview and commit return 401, and the invoice count in the clone is unchanged
    - Sharma CSV after seed → `already_imported`, no warning
    - Sharma CSV with `₹4,15,000` → preview shows `already_imported` with `Differs from stored invoice: amount`. Commit → `inserted: 0`, and the stored `amount_paise` is still 41_200_000
    - A new-invoice CSV → preview `new`, commit `{ inserted: 1, skipped: 0 }`, and a second commit `{ inserted: 0, skipped: 1 }`
    - Commit `FormData` with an extra `supplierId` naming a second supplier inserted in the clone → rows are written under the session's supplier, and the second supplier has 0 invoices
    - A `Content-Length` header over the limit → 413 without the body being read
    - _Requirements: 10.5, 10.6, 10.7, 10.9, 12.5, 13.2, 13.5, 13.7_
  - [ ] 11.6 Commit task 11
    - `git add apps/web/lib apps/web/app/api apps/web/test` (none of these paths contain parentheses or brackets; `app/api` holds `[...nextauth]` and is staged through its parent)
    - Check `git diff --staged`. Commit `feat(web): add import preview and commit routes`, body `Spec: ledger-import, task 11`
    - _Requirements: 14.1, 14.2, 14.3_

- [ ] 12. Build the import page
  - [ ] 12.1 Replace the placeholder `app/(app)/import/page.tsx` with the client component
    - A file input (`accept=".csv,.xlsx"`). On selection, compare `file.size` with `MAX_UPLOAD_BYTES` from `@/lib/import/limits`, and over the limit show `uploadTooLargeMessage()` without sending anything
    - A **Preview** button posts the file to `/api/import/preview` and shows file-level errors, or:
      - the summary counts and unused columns;
      - a table with row number, status, invoice number, buyer, `amountText`, invoice date, accepted date, "defaulted to invoice date" when flagged, warnings, and for error rows each column and reason.
    - **Import N new invoices** (disabled when N is 0) posts the same `File` object to `/api/import/commit` and shows the inserted, skipped and error counts
    - Real `<button>` and `<label>` elements and 44px targets. Minimal `import.module.css`, with no theme work
    - _Requirements: 13.1, 13.2, 13.4, 13.5, 13.6_
  - [ ] 12.2 Manual browser check
    - With `.env.local` pointing at a Neon dev branch: run `db:migrate` and `db:seed`, then `pnpm --filter web dev` (in your own terminal; don't run it from the agent)
    - **Signed out** (a private window, or after clearing the `authjs.session-token` cookie):
      - visiting `http://localhost:3000/import` redirects to `/signin`;
      - `curl -i -X POST http://localhost:3000/api/import/preview` returns `HTTP/1.1 401` with body `{"error":"Unauthorized"}`.
    - **Signed in:**
      - Sign in with the button. Upload a Sharma CSV and confirm `already_imported`.
      - Upload a Tally-style XLSX with a new invoice, commit, then re-upload and confirm `already_imported`.
      - Choose a 5 MB file and confirm the browser blocks it with no network request.
    - Record each result in the commit body
    - _Requirements: 12.2, 12.4, 13.1, 13.2, 13.4, 13.5, 13.6_
  - [ ] 12.3 Commit task 12
    - `git add 'apps/web/app/(app)/import'` (quoted: zsh treats the parentheses as a glob)
    - Check `git diff --staged`. Commit `feat(web): add import page with preview table`, body `Spec: ledger-import, task 12` plus the manual-check results
    - _Requirements: 14.1, 14.2, 14.3_

- [ ] 13. Final checkpoint
  - [ ] 13.1 Run the whole workspace from a clean install
    - `pnpm install --frozen-lockfile && pnpm test && pnpm typecheck && pnpm lint` all exit 0
    - `pnpm --filter web build` exits 0 with dummy `AUTH_SECRET` and `DATABASE_URL` values set only in the shell, never written to a file
    - `git grep -nE "Math\.random|Date\.now|parseFloat" packages/ledger/src` finds nothing
    - Ask the user before fixing anything outside this spec's files
    - _Requirements: 1.1, 1.3, 1.4, 2.3_
  - [ ] 13.2 Mark the spec complete and commit
    - Tick every task in this file
    - `git add .kiro/specs/ledger-import/tasks.md`. Commit `chore(kiro): mark ledger-import tasks complete`, body `Spec: ledger-import, task 13`
    - _Requirements: 14.1, 14.2, 14.3_

## Notes

- All sub-tasks are required, including every property test, unit test and the manual browser check. The commit for a task requires `test`, `typecheck` and `lint` to pass for every package it touched.
- Ledger property tests use `numRuns: 200` (from `test/setup.ts`). Property 2 sets `numRuns: 50` because every run clones a PGlite database. Each property test carries the comment `// Feature: ledger-import, Property N: <title>`.
- Saving files in `packages/engine` triggers the existing engine-tests-on-save hook during task 1. From task 2.4 on, saving any file under `packages/ledger` runs the ledger tests through the second entry in the same hook file.
- Task 9's demo reset supports the design's Decisions 11 and 12. It traces to Requirement 11.1 because it ends by reseeding. The nightly schedule belongs to the deploy step.
- Never run `next dev` from the agent. It is a long-running process. Task 12.2 is run by the user.
- The commit sub-tasks touch the git index, so each runs alone in its wave and only after the task's other sub-tasks.
- Sub-tasks that write the same file (`src/index.ts` in each package, `eslint.config.js`, `test/arbitraries.ts`) are in different waves.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3"] },
    { "id": 3, "tasks": ["2.1"] },
    { "id": 4, "tasks": ["2.2"] },
    { "id": 5, "tasks": ["2.3", "2.4"] },
    { "id": 6, "tasks": ["2.5"] },
    { "id": 7, "tasks": ["3.1"] },
    { "id": 8, "tasks": ["3.2"] },
    { "id": 9, "tasks": ["3.3", "3.4"] },
    { "id": 10, "tasks": ["3.5"] },
    { "id": 11, "tasks": ["4.1"] },
    { "id": 12, "tasks": ["4.2", "4.3"] },
    { "id": 13, "tasks": ["4.4"] },
    { "id": 14, "tasks": ["4.5"] },
    { "id": 15, "tasks": ["5.1"] },
    { "id": 16, "tasks": ["5.2", "5.3"] },
    { "id": 17, "tasks": ["5.4"] },
    { "id": 18, "tasks": ["5.5"] },
    { "id": 19, "tasks": ["6.1"] },
    { "id": 20, "tasks": ["6.2", "6.3"] },
    { "id": 21, "tasks": ["6.4"] },
    { "id": 22, "tasks": ["6.5"] },
    { "id": 23, "tasks": ["7.1"] },
    { "id": 24, "tasks": ["7.2"] },
    { "id": 25, "tasks": ["7.3"] },
    { "id": 26, "tasks": ["7.4"] },
    { "id": 27, "tasks": ["7.5"] },
    { "id": 28, "tasks": ["8.1"] },
    { "id": 29, "tasks": ["8.2"] },
    { "id": 30, "tasks": ["8.3", "8.4"] },
    { "id": 31, "tasks": ["8.5"] },
    { "id": 32, "tasks": ["9.1"] },
    { "id": 33, "tasks": ["9.2", "9.3"] },
    { "id": 34, "tasks": ["9.4"] },
    { "id": 35, "tasks": ["9.5"] },
    { "id": 36, "tasks": ["10.1"] },
    { "id": 37, "tasks": ["10.2"] },
    { "id": 38, "tasks": ["10.3", "10.4"] },
    { "id": 39, "tasks": ["10.5"] },
    { "id": 40, "tasks": ["10.6"] },
    { "id": 41, "tasks": ["11.1"] },
    { "id": 42, "tasks": ["11.2", "11.4"] },
    { "id": 43, "tasks": ["11.3"] },
    { "id": 44, "tasks": ["11.5"] },
    { "id": 45, "tasks": ["11.6"] },
    { "id": 46, "tasks": ["12.1"] },
    { "id": 47, "tasks": ["12.2"] },
    { "id": 48, "tasks": ["12.3"] },
    { "id": 49, "tasks": ["13.1"] },
    { "id": 50, "tasks": ["13.2"] }
  ]
}
```
