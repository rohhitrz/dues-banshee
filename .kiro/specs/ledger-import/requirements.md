# Requirements Document

## Introduction

Ledger import gets a supplier's unpaid invoices into Dues Banshee. The owner uploads a CSV or XLSX file (their own sheet or a Tally export), sees a preview with a status for every row, and confirms. Valid rows become invoices in Postgres. Importing the same file again creates no duplicates.

The feature spans three parts:

- `packages/ledger`: pure TypeScript that turns text cells into engine `Invoice` values. It parses amounts and dates leniently, maps headers, and builds the dedupe key. It reuses the engine's types and validation and never re-implements engine logic.
- `packages/db`: the Drizzle schema for Neon Postgres (PGlite in tests), the bank-rate config, the idempotent import write and the demo seed.
- `apps/web`: the first Next.js code. A one-click demo sign-in (Auth.js) and the import page with its API routes.

Later specs (escalation ladder, WhatsApp, voice, dashboard) add columns and behaviour to the tables created here.

Out of scope: the Google Sheets API, live Tally integration, dashboard styling, tenancy beyond one supplier per user in the schema, editing rows in the preview, recording payments through import, a demo "today" override (belongs to `dashboard-ui`), engine changes beyond the exports in Requirement 2, and file encodings other than UTF-8.

## Glossary

- **Engine**: `packages/engine` (spec `legal-engine`). Provides `Invoice`, `CalendarDate`, `Paise`, `BankRate`, `ValidationError`, `MAX_PAISE`, `LADDER_STEPS`, `APPROVAL_STEP_LIST` and the validation functions.
- **Ledger**: The new `packages/ledger` package. Pure: no I/O, no clock, no randomness, no floating-point arithmetic.
- **Db**: The new `packages/db` package: Drizzle schema, migrations, queries, seed.
- **Web_App**: `apps/web`, the Next.js App Router application.
- **Calendar_Date**: The Engine's date type, a `YYYY-MM-DD` string for an IST calendar day, years 1900 to 9999.
- **Paise**: An integer count of paise (₹1 = 100 paise).
- **MAX_SAFE**: `Number.MAX_SAFE_INTEGER` = 9,007,199,254,740,991. The largest Paise value the Ledger's parser returns.
- **MAX_PAISE**: The Engine's invoice cap, 1,00,000,00,00,000 paise (₹1,000 crore). Enforced by Engine validation, not by the parser.
- **Lakh_Unit**: One of `L`, `lakh`, `lakhs`, `lac`, `lacs`, case-insensitive. Means × 1,00,000 rupees.
- **Crore_Unit**: One of `crore`, `crores`, case-insensitive. Means × 1,00,00,000 rupees. `Cr` is not a Crore_Unit, because Tally uses `Cr` for a credit balance.
- **Balance_Suffix**: A trailing `Dr` or `Cr`, case-insensitive, as written by Tally. `Dr` (debit, a receivable) is accepted and ignored. `Cr` (credit) is rejected.
- **Excel_Serial**: A day number in Excel's 1900 date system. The Ledger accepts 36526 (2000-01-01) to 73050 (2099-12-31) only.
- **Supplier_Record**: The supplier's stored facts: id, name, Udyam number, `supplierCategory`, `supplierActivity` and `udyamRegisteredOn`. Import reads these facts from the record, never from the file.
- **Supplier_Snapshot**: The `supplier_category` and `supplier_activity` stored on an invoice row, copied from its Supplier_Record when the invoice is inserted. It never differs from the Supplier_Record at insert time.
- **Registered_After_Supply_Caveat**: The Engine's `caveat: "registered_after_supply"`, returned for a covered invoice whose `acceptedOn` is before the supplier's `udyamRegisteredOn` (`MSMED-SCOPE`: flag, don't exclude).
- **Raw_Table**: A file's contents as rows of text cells, in file order, each row carrying its 1-based row number in the file.
- **Import_Field**: One of the canonical columns the Ledger understands: `invoiceNumber`, `buyerName`, `amount`, `invoiceDate` (required) and `acceptanceDate`, `creditDays` (optional).
- **Acceptance_Group / Delivery_Group**: The two groups of `acceptanceDate` aliases. Acceptance_Group: Acceptance Date, Accepted On, Date of Acceptance. Delivery_Group: Delivery Date, Date of Delivery, Delivered On.
- **Header_Key**: A header cell normalised for matching: Unicode NFKC, lowercased, with every character other than `a`–`z` and `0`–`9` removed. "Party's Name" → `partysname`; "Ref. No." → `refno`.
- **Text_Key**: A value normalised for deduplication: Unicode NFKC, trimmed, runs of whitespace collapsed to one space, lowercased. Punctuation is kept, so `INV/001` and `INV-001` are different keys.
- **Dedupe_Key**: The triple (supplier id, Text_Key of the buyer name, Text_Key of the invoice number).
- **Row_Result**: The outcome of mapping one data row: `{ ok: true, invoice, … }` or `{ ok: false, errors }`, where each error is `{ column, reason }`.
- **Import_Preview**: The list of Row_Results for a file, each with a status of `new`, `already_imported` or `error`.
- **Demo_User**: The single built-in user, linked to the demo Supplier_Record.

## Requirements

### Requirement 1: Packages, purity and lint

**User Story:** As the developer, I want the ledger logic in a pure package and the database in its own package, so that parsing is property-testable and the engine stays free of I/O.

#### Acceptance Criteria

1. THE Workspace SHALL contain the packages `@dues-banshee/ledger` at `packages/ledger`, `@dues-banshee/db` at `packages/db` and the app `apps/web`, each compiled with the root `tsconfig.base.json` strict settings and each exposing `test`, `typecheck` and `lint` scripts.
2. THE Ledger SHALL depend at runtime only on the Engine and on libraries that perform no I/O.
3. THE root ESLint config SHALL apply the Engine's existing bans (restricted globals `Date`, `process`, `fetch`, `setTimeout`, `setInterval`, `performance`; Node built-in and I/O imports; `Math.random`) to `packages/ledger/src/**/*.ts`.
4. THE root ESLint config SHALL also ban, in `packages/ledger/src/**/*.ts`, the global `parseFloat`, the property `Number.parseFloat`, the method `toFixed`, and numeric literals with a fractional part or exponent.
5. THE Ledger SHALL do all money and Excel_Serial arithmetic with integers or BigInt.

### Requirement 2: Engine exports for reuse

**User Story:** As the developer, I want the ledger and db to call the engine's own validation and date helpers, so that no engine rule exists in two places.

#### Acceptance Criteria

1. THE Engine SHALL export from its package index, without changing their behaviour: `validateInvoice`, `isValidCalendarDate`, `fromEpochDay`, and two new frozen constants `SUPPLIER_CATEGORIES` (`micro`, `small`, `medium`, `unregistered`) and `SUPPLIER_ACTIVITIES` (`manufacturing`, `services`, `trading`).
2. THE Engine's `validate.ts` SHALL use the exported `SUPPLIER_CATEGORIES` and `SUPPLIER_ACTIVITIES` constants instead of private copies.
3. WHEN the Engine's tests run after this change, THE Engine SHALL pass every existing test unchanged.
4. THE Ledger and the Db SHALL NOT re-implement calendar validation, invoice validation, coverage, due dates, interest, tax-bomb logic or rupee formatting.

### Requirement 3: Lenient amount parsing

**User Story:** As an owner whose sheet writes amounts many ways, I want "₹4,12,000/-", "4.12 lakh" and "412000.00 Dr" all read as the same amount, so that I don't have to clean my sheet before importing.

#### Acceptance Criteria

1. THE Ledger SHALL export `parseAmountLenient(raw: string)` that returns either a Paise integer or an Engine `ValidationError` with field `amount` and a reason that quotes the input. It SHALL return the error, not throw it.
2. THE Ledger SHALL accept, after trimming surrounding whitespace, text of the form `[prefix] number [unit] [/-] [Dr]` with optional whitespace between the parts, where:
   - prefix is one of `₹`, `Rs`, `Rs.`, `INR`, case-insensitive;
   - number is a plain digit string, or a digit string with Indian grouping (last three digits, then pairs) or western grouping (groups of three), optionally followed by `.` and one or more digits;
   - unit is a Lakh_Unit or a Crore_Unit. No unit means rupees;
   - `/-` is the Indian "rupees only" mark and is ignored;
   - `Dr` is the Balance_Suffix for a receivable and is ignored.
3. IF the text ends with the Balance_Suffix `Cr`, THEN THE Ledger SHALL return a `ValidationError` with reason "Credit balance (Cr) is not a receivable".
4. THE Ledger SHALL compute the result exactly with BigInt as number × unit × 100, and accept trailing zeros beyond paise precision ("500.000" → 50,000).
5. THE Ledger SHALL NOT call the Engine's `parseINR`.
6. WHEN `parseAmountLenient` is called with each input below, THE Ledger SHALL return exactly the listed Paise value (example tests):

   | Input | Paise |
   |---|---|
   | `500` | 50_000 |
   | `500.00` | 50_000 |
   | `500.5` | 50_050 |
   | `0.01` | 1 |
   | `0` | 0 |
   | `4,12,000` | 41_200_000 |
   | `412,000` | 41_200_000 |
   | `₹4,12,000` | 41_200_000 |
   | `₹4,12,000.50` | 41_200_050 |
   | `Rs. 500` | 50_000 |
   | `rs500` | 50_000 |
   | `INR 500` | 50_000 |
   | `INR 1,250,000.75` | 125_000_075 |
   | `500/-` | 50_000 |
   | `₹4,12,000/-` | 41_200_000 |
   | `4,12,000.00 Dr` | 41_200_000 |
   | `4.12 L` | 41_200_000 |
   | `4.12 lakh` | 41_200_000 |
   | `4.12 lakhs` | 41_200_000 |
   | `4.12 lac` | 41_200_000 |
   | `4.12 lacs` | 41_200_000 |
   | `₹4.12L` | 41_200_000 |
   | `4.1234567 L` | 41_234_567 |
   | `4.12 crore` | 4_120_000_000 |
   | `4.12 crores` | 4_120_000_000 |
   | `1,250 crore` | 1_250_000_000_000 |
   | `  500  ` | 50_000 |
   | `90071992547409.91` | 9_007_199_254_740_991 |

7. IF the input is any of the following, THEN THE Ledger SHALL return a `ValidationError`, and each listed input SHALL have an example test:
   - empty or whitespace only (``, `   `);
   - negative (`-500`, `₹-500`, `(500)`);
   - a credit balance (`4,12,000.00 Cr`, `4.12 Cr`), with the reason in criterion 3;
   - more than one-paisa precision after scaling (`500.001`, `4.12345678 L`);
   - malformed grouping (`4,1,2000`, `500,00`, `4 12 000`);
   - a point with no digit on one side (`500.`, `.50`);
   - a prefix or unit with no number (`Rs`);
   - a repeated prefix, unit or suffix (`₹ ₹500`, `4 L crore`, `500/-/-`);
   - letters other than the prefixes, units and `Dr` (`500 USD`, `abc`, `1.5 K`);
   - above MAX_SAFE (`90071992547409.92`, `1,00,00,000 crore`).
8. FOR ALL Paise values `p` from 0 to MAX_SAFE, THE Ledger SHALL return exactly `p` when `p` is written in each of these styles (property-based test, fast-check):
   - plain rupees, with `.PP` paise digits (and with or without `.00` when the paise part is zero);
   - Indian grouping;
   - western grouping;
   - each of the above with each prefix `₹`, `Rs`, `Rs.`, `INR`, with and without a space;
   - the exact decimal of `p` in lakh (up to 7 decimal places) with each Lakh_Unit spelling, and in crore (up to 9 decimal places) with each Crore_Unit spelling, trailing zeros removed, in random case;
   - each of the above optionally followed by `/-` and optionally by ` Dr` in random case.

### Requirement 4: Lenient date parsing

**User Story:** As an owner whose dates come from Excel and Tally in different formats, I want the common Indian formats read correctly, so that due dates are computed from the right day.

#### Acceptance Criteria

1. THE Ledger SHALL export `parseDateLenient(raw: string)` that returns either an Engine Calendar_Date or an Engine `ValidationError` with field `date` and a reason that quotes the input. It SHALL return the error, not throw it.
2. THE Ledger SHALL accept, after trimming surrounding whitespace:
   - ISO `YYYY-M-D` (1–2 digit month and day);
   - `D/M/YYYY`, `D-M-YYYY` and `D.M.YYYY`, with the same separator in both places;
   - `D-Mon-YYYY` and `D-Mon-YY`, where `Mon` is a three-letter English month abbreviation, case-insensitive, and a two-digit year `YY` means `20YY`;
   - an Excel_Serial: exactly five digits from 36526 to 73050, converted with integer arithmetic as `fromEpochDay(serial − 25569)`.
3. THE Ledger SHALL always read numeric slash, dash and dot dates as day first, then month, and SHALL accept two-digit years only in the `D-Mon-YY` form.
4. THE Ledger SHALL confirm each result with the Engine's `isValidCalendarDate` and reject days that do not exist.
5. WHEN `parseDateLenient` is called with each input below, THE Ledger SHALL return exactly the listed Calendar_Date (example tests):

   | Input | Calendar_Date |
   |---|---|
   | `2026-09-02` | 2026-09-02 |
   | `02/09/2026` | 2026-09-02 |
   | `2/9/2026` | 2026-09-02 |
   | `02-09-2026` | 2026-09-02 |
   | `02.09.2026` | 2026-09-02 |
   | `02-Sep-2026` | 2026-09-02 |
   | `2-sep-2026` | 2026-09-02 |
   | `2-Sep-26` | 2026-09-02 |
   | `02-SEP-26` | 2026-09-02 |
   | `29-Feb-28` | 2028-02-29 |
   | `09/02/2026` | 2026-02-09 |
   | `29/02/2028` | 2028-02-29 |
   | `46267` | 2026-09-02 |
   | `46312` | 2026-10-17 |
   | `46812` | 2028-02-29 |
   | `36526` | 2000-01-01 |
   | `73050` | 2099-12-31 |
   | ` 02/09/2026 ` | 2026-09-02 |

6. IF the input is any of the following, THEN THE Ledger SHALL return a `ValidationError`, and each listed input SHALL have an example test:
   - empty (``);
   - a day that does not exist (`31/02/2026`, `29/02/2026`, `2026-02-30`, `12/31/2026`, `13/13/2026`, `29-Feb-26`);
   - mixed separators (`02/09-2026`);
   - a numeric date with a two-digit year (`02/09/26`, `02-09-26`, `02.09.26`);
   - a month-name date with a three-digit year (`2-Sep-226`);
   - another layout (`Sep 2, 2026`);
   - an Excel_Serial out of range (`36525`, `73051`, `2026`, `60`, `0`);
   - a fractional serial (`46267.5`).

### Requirement 5: Reading files and mapping headers

**User Story:** As an owner, I want the importer to recognise my column names, including Tally's, so that I can upload the file I already have.

#### Acceptance Criteria

1. THE Ledger SHALL parse CSV text (RFC 4180: quoted fields, embedded commas and quotes, CRLF or LF line endings, a leading UTF-8 byte-order mark removed) into a Raw_Table of text cells with no type inference.
2. THE Web_App SHALL read XLSX files with exceljs from the first worksheet into a Raw_Table, converting each cell as follows:
   - a numeric cell, or a formula cell whose cached result is a number, becomes `String(value)` (the JavaScript shortest round-trip decimal), never the cell's display text, so number formats cannot round paise away;
   - a date-typed cell, or a formula cell whose cached result is a date, becomes `YYYY-MM-DD` built from the date's UTC year, month and day;
   - any other cell, or a formula cell with any other cached result, becomes its plain text.
3. WHEN an XLSX cell holds the number 412000.6 with number format `#,##0` in the amount column, THE Web_App and Ledger together SHALL map it to 41_200_060 paise (test).
4. THE Ledger SHALL match headers by Header_Key against this alias table:

   | Import_Field | Accepted headers |
   |---|---|
   | `invoiceNumber` | Invoice No, Invoice No., Invoice Number, Invoice #, Bill No, Bill Number, Voucher No, Voucher No., Voucher Number, Ref. No. (Tally), Reference No |
   | `buyerName` | Party Name, Party's Name (Tally), Buyer, Buyer Name, Customer, Customer Name, Particulars (Tally sales register) |
   | `amount` | Amount, Invoice Value, Invoice Amount, Bill Amount, Total, Gross Total (Tally sales register), Pending Amount (Tally bills receivable) |
   | `invoiceDate` | Invoice Date, Bill Date, Voucher Date, Date (Tally) |
   | `acceptanceDate` | Acceptance_Group: Acceptance Date, Accepted On, Date of Acceptance. Delivery_Group: Delivery Date, Date of Delivery, Delivered On |
   | `creditDays` | Credit Days, Credit Period, Terms, Payment Terms |

   The Delivery_Group headers map to `acceptanceDate` because MSMED Act s.2(b) defines the day of acceptance as the day of actual delivery.
5. WHEN a header row contains a Delivery_Group header and no Acceptance_Group header, THE Ledger SHALL map the delivery column to `acceptanceDate` (one example test per Delivery_Group header).
6. WHEN a header row contains exactly one Acceptance_Group header and exactly one Delivery_Group header, THE Ledger SHALL map the acceptance column to `acceptanceDate` and list the delivery column as unused (example test: `Acceptance Date` with `Delivery Date`).
7. IF two columns in the header row match the same Import_Field, other than the case in criterion 6, THEN THE Ledger SHALL return a file-level error that names both columns and the field. This includes two columns from the same `acceptanceDate` group (example tests: `Delivery Date` with `Delivered On`; `Acceptance Date` with `Accepted On`).
8. THE Ledger SHALL use as the header row the first row, among the first 20 rows, in which all four required Import_Fields match. Rows above it (such as Tally's company and report titles) SHALL be ignored.
9. IF no row in the first 20 matches all required Import_Fields, THEN THE Ledger SHALL return a file-level error that lists the missing fields and their accepted headers.
10. THE Ledger SHALL ignore columns that match no alias and list them in the Import_Preview as unused.
11. THE Ledger SHALL skip data rows in which every mapped cell is blank.
12. WHEN header detection runs on a Tally bills-receivable export with title rows and the headers `Date`, `Ref. No.`, `Party's Name`, `Opening Amount`, `Pending Amount`, `Due on`, `Overdue by days`, THE Ledger SHALL map `Date`, `Ref. No.`, `Party's Name` and `Pending Amount`, and list the other three as unused (example test).

### Requirement 6: Mapping a row to an engine invoice

**User Story:** As an owner, I want each row checked by the same rules the engine uses and every problem shown against its column, so that I can fix my sheet and nothing invalid is saved.

#### Acceptance Criteria

1. THE Ledger SHALL export a `mapRow` function that takes a data row, the header mapping and a Supplier_Record, and returns a Row_Result with the row's 1-based file row number.
2. THE Ledger SHALL parse `amount` with `parseAmountLenient`, `invoiceDate` and `acceptanceDate` with `parseDateLenient`, and `creditDays` as a whole number of days written as digits, optionally followed by `day` or `days` or preceded by `Net` (case-insensitive). A blank `creditDays` cell means no agreed term.
3. IF `invoiceNumber` or `buyerName` is blank after trimming, or any Import_Field fails to parse, THEN THE Ledger SHALL return `{ ok: false }` with one error per failing column. Each error names the column header as written in the file and gives the reason.
4. WHEN every Import_Field parses, THE Ledger SHALL build an Engine `Invoice` with `amountPaise` from `amount`, `acceptedOn` from `acceptanceDate`, `agreedTermDays` from `creditDays` (omitted when blank), `supplierCategory`, `supplierActivity` and `udyamRegisteredOn` from the Supplier_Record only, no `paidOn`, and a deterministic non-empty `id` derived from the Dedupe_Key.
5. WHILE the `acceptanceDate` cell is blank or the column is absent, THE Ledger SHALL set `acceptedOn` to the invoice date and set `acceptanceDateDefaulted: true` on the Row_Result.
6. WHEN the Engine `Invoice` is built, THE Ledger SHALL validate it with the Engine's `validateInvoice` and, on a `ValidationError`, return `{ ok: false }` with the error mapped to the source column: `amountPaise` → the amount column, `acceptedOn` → the acceptance column (or the invoice-date column when defaulted), `agreedTermDays` → the credit-days column. An amount of 0 or above MAX_PAISE, and a credit term of 0 days, are rejected this way.
7. WHEN a row maps successfully, THE Ledger SHALL return `{ ok: true, invoice, buyerName, invoiceNumber, invoiceDate, acceptanceDateDefaulted, dedupeKey, warnings }`, with `buyerName` and `invoiceNumber` trimmed as written.
8. WHEN `agreedTermDays` is greater than 45, THE Ledger SHALL add the warning "Credit term of N days is above the 45-day limit; the due date uses 45 days (MSMED-15)" and still return `ok: true`.
9. IF the Supplier_Record fails Engine validation of its category or activity, THEN THE Ledger SHALL reject the whole import with a file-level error before mapping any row.
10. WHEN `mapRow` is given the Sharma Traders row (Invoice No `LPC/26-27/0412`, Party Name `Sharma Traders`, Amount `₹4,12,000`, Invoice Date `02/09/2026`, Credit Days `45`, no acceptance column) and the demo Supplier_Record, THE Ledger SHALL return `ok: true`, `amountPaise` 41_200_000, `acceptedOn` 2026-09-02, `agreedTermDays` 45 and `acceptanceDateDefaulted: true` (example test).

### Requirement 7: Dedupe key

**User Story:** As an owner, I want the same invoice recognised however its buyer name or number is spaced or capitalised, so that importing twice never doubles a debt.

#### Acceptance Criteria

1. THE Ledger SHALL compute the Dedupe_Key from the supplier id and the Text_Keys of the buyer name and invoice number.
2. WHEN two rows differ only in the case or spacing of the buyer name or invoice number (`Sharma Traders` / `  SHARMA   traders `), THE Ledger SHALL give them the same Dedupe_Key.
3. IF a data row has the same Dedupe_Key as an earlier valid row in the same file, THEN THE Ledger SHALL return `{ ok: false }` for the later row with an error on the invoice-number column: "Duplicate of row N".

### Requirement 8: Database schema

**User Story:** As the developer, I want one typed schema for every table the product needs, so that later specs add columns instead of new foundations.

#### Acceptance Criteria

1. THE Db SHALL define with Drizzle, and ship as committed SQL migrations, the tables `suppliers`, `buyers`, `invoices`, `escalation_events`, `promises`, `messages`, `calls`, `approvals`, `payment_links`, `agent_runs` and `config`, with at least these columns besides an id and `created_at`:

   | Table | Columns |
   |---|---|
   | `suppliers` | name, udyam_number, supplier_category, supplier_activity, udyam_registered_on |
   | `buyers` | supplier_id, name, name_key |
   | `invoices` | supplier_id, buyer_id, invoice_number, invoice_number_key, invoice_date, accepted_on, acceptance_date_defaulted, agreed_term_days, amount_paise, paid_on, supplier_category, supplier_activity |
   | `escalation_events` | invoice_id, step, occurred_on |
   | `promises` | invoice_id, promised_date, amount_paise, recorded_on |
   | `messages` | invoice_id, channel, direction, body, status |
   | `calls` | invoice_id, started_at, ended_at, transcript |
   | `approvals` | invoice_id, step, status, decided_at |
   | `payment_links` | invoice_id, provider_link_id, url, amount_paise, status |
   | `agent_runs` | tool, input, output, invoice_id |
   | `config` | key, value_int, effective_from |

2. THE Db SHALL store every money column as Postgres `bigint` read and written as a JS safe integer of Paise.
3. THE Db SHALL store every calendar date as Postgres `date` in Drizzle string mode, so values are Engine Calendar_Dates, and every instant as `timestamptz`.
4. THE Db SHALL derive the enum values of `escalation_events.step` from the Engine's `LADDER_STEPS`, of `approvals.step` from `APPROVAL_STEP_LIST`, and of the supplier category and activity columns from `SUPPLIER_CATEGORIES` and `SUPPLIER_ACTIVITIES`. A test SHALL assert each database enum equals its Engine constant, in order.
5. THE Db SHALL enforce with unique constraints that no two buyers share (supplier_id, name_key) and no two invoices share (supplier_id, buyer_id, invoice_number_key), so the Dedupe_Key is unique even under concurrent imports.
6. THE Db SHALL constrain `suppliers.udyam_number` to the pattern `UDYAM-XX-00-0000000` (two capital letters, two digits, seven digits).
7. WHEN an invoice is inserted by import or seed, THE Db SHALL set its Supplier_Snapshot by copying `supplier_category` and `supplier_activity` from the Supplier_Record, and SHALL offer no way to set them to other values. A PGlite test SHALL assert that every seeded and imported invoice's Supplier_Snapshot equals its supplier's values.
8. THE Db SHALL export `toEngineInvoice(row)` that builds an Engine `Invoice` from a stored invoice and its supplier, taking `udyamRegisteredOn` from the supplier, with no recomputation of engine values.
9. THE Db SHALL read `DATABASE_URL` from the environment and use the Neon driver in the app and PGlite in tests, applying the same migrations to both.

### Requirement 9: Bank rate config

**User Story:** As the developer, I want the RBI bank rate stored with its effective date, so that interest uses the rate in force and changes after an MPC meeting need no code change.

#### Acceptance Criteria

1. THE Db SHALL store the bank rate in `config` as key `rbi_bank_rate_bps`, an integer `value_int` in basis points, and `effective_from` as a Calendar_Date, unique per (key, effective_from).
2. THE Db SHALL export `getBankRate(db, today)` that returns an Engine `BankRate` `{ annualBps, asOf }` from the row with the latest `effective_from` on or before `today`, with `asOf` set to that `effective_from`.
3. IF no bank-rate row has `effective_from` on or before `today`, THEN THE Db SHALL throw an error naming the key and `today`.
4. WHEN the seed has run, THE Db SHALL return `{ annualBps: 575, asOf: "2026-10-07" }` from `getBankRate` at `today` 2026-10-07 and 2026-11-12, and throw at `today` 2026-10-06 (PGlite test).

### Requirement 10: Idempotent import write

**User Story:** As an owner, I want to re-upload my file every week without creating duplicates, so that the graveyard always matches my ledger.

#### Acceptance Criteria

1. THE Db SHALL export an import function that takes a supplier id and the `ok: true` Row_Results and, in one transaction, inserts missing buyers and invoices and skips any whose Dedupe_Key already exists.
2. THE Db SHALL never update or delete an existing invoice during import.
3. WHEN the import finishes, THE Db SHALL return the counts of inserted invoices and of skipped (already imported) invoices.
4. IF any insert fails for a reason other than an existing Dedupe_Key, THEN THE Db SHALL roll back the whole import and report the error.
5. THE Db SHALL export a lookup that returns, for each Row_Result whose Dedupe_Key is already stored, the stored `amount_paise`, `invoice_date` and `accepted_on`. Such rows get the preview status `already_imported`.
6. WHEN an `already_imported` row's amount, invoice date or accepted date differs from the stored invoice, THE Web_App SHALL keep the status `already_imported`, write nothing for that row, and add the warning "Differs from stored invoice: <fields>", listing the differing fields as `amount`, `invoice date` and `accepted date` in that order.
7. WHEN the Sharma Traders invoice is stored and a file with the same Dedupe_Key and Amount `₹4,15,000` is previewed and committed, THE Web_App SHALL show `already_imported` with the warning "Differs from stored invoice: amount", and the stored `amount_paise` SHALL remain 41_200_000 (PGlite test).
8. FOR ALL lists of valid Row_Results (including repeated Dedupe_Keys) and all N from 1 to 5, WHEN the list is imported N times into a fresh PGlite database, THE Db SHALL hold exactly as many invoices as the list has distinct Dedupe_Keys (property-based test, fast-check).
9. WHEN the same file is imported twice, THE Db SHALL report all rows as skipped on the second import (PGlite test).

### Requirement 11: Demo seed

**User Story:** As the presenter, I want a seeded supplier with invoices in several legal states, including a caveat case, so that the demo and the dashboard show real numbers from day one.

#### Acceptance Criteria

1. THE Db SHALL provide a `db:seed` script that creates, or leaves unchanged when present, the demo supplier, buyers, invoices and bank rate. Running it twice SHALL leave the same rows.
2. THE seed SHALL create the supplier "Laxmi Precision Components (Demo)" with Udyam number `UDYAM-MH-00-0000000`, category `micro`, activity `manufacturing` and `udyam_registered_on` 2024-04-15.
3. THE seed SHALL create the bank-rate row 575 bps effective from 2026-10-07.
4. THE seed SHALL create these invoices, each with the Supplier_Snapshot `micro` / `manufacturing`. A PGlite test SHALL load each with `toEngineInvoice` and assert the Engine results at `today` 2026-11-12 with the seeded bank rate:

   | Buyer | Invoice no. | Paise | Accepted | Term | Paid | Engine at 2026-11-12 |
   |---|---|---|---|---|---|---|
   | Sharma Traders | LPC/26-27/0412 | 41_200_000 | 2026-09-02 | 45 | — | due 2026-10-17; interest exactly 512794 paise (26 accrual days); tax bomb `armed`, 139 days left; next step `whatsapp_nudge` |
   | Gupta Engineering Works | LPC/26-27/0466 | 18_500_000 | 2026-11-01 | — | — | covered, not overdue: due 2026-11-16; interest 0; ladder `wait` `not_overdue` |
   | Kumar Textiles | LPC/26-27/0301 | 24_000_000 | 2026-07-02 | 45 | — | overdue: due 2026-08-16; 88 accrual days |
   | Verma Auto Parts | LPC/26-27/0377 | 8_500_000 | 2026-08-10 | 30 | 2026-09-05 | paid: tax bomb `defused`; ladder `wait` `paid` |
   | Mehta Polymers | LPC/25-26/0388 | 16_000_000 | 2026-03-20 | 45 | — | 31 March passed: due 2026-05-04; tax bomb `exploded`, Deduction_Deadline 2026-05-04 |
   | Bansal Hardware | LPC/23-24/0098 | 5_500_000 | 2024-03-01 | 30 | — | supplied before Udyam registration (2024-04-15): covered with the Registered_After_Supply_Caveat; see criterion 5 |

5. WHEN the seed test runs the Engine on the Bansal Hardware invoice at `today` 2026-11-12 with the seeded bank rate, THE Db test SHALL assert exactly:
   - `coverage` returns `{ applicable: true, caveat: "registered_after_supply", ruleIds: ["MSMED-SCOPE"] }`;
   - `dueDate` returns due date 2024-03-31;
   - `statutoryInterest` returns `accrualDays` 956 and `interestPaise` 3167411 (₹31,674.11), the values the Engine returns. `design.md` SHALL hand-check both;
   - `taxBomb` returns status `exploded`.
6. THE seed SHALL set each invoice's `invoice_date` equal to its accepted date and `acceptance_date_defaulted` to false.

### Requirement 12: Demo sign-in

**User Story:** As a hackathon judge, I want to get into the app with one click, so that I can try it without creating an account.

#### Acceptance Criteria

1. THE Web_App SHALL use the latest stable Next.js with the App Router and Auth.js with JWT sessions, and read `AUTH_SECRET` and `DATABASE_URL` from the environment. A committed `.env.example` SHALL list the variable names with no values.
2. THE Web_App SHALL show a sign-in page with one button, "Enter the graveyard (demo)", and no form fields. Pressing it SHALL sign in as the Demo_User and redirect to `/import`.
3. THE Web_App SHALL put the demo supplier's id in the session.
4. THE Web_App SHALL protect the `(app)` routes and `/api/import/*` in `proxy.ts` (the Next.js 16 name for `middleware.ts`). Unauthenticated page requests SHALL redirect to the sign-in page and unauthenticated API requests SHALL get HTTP 401.
5. THE Web_App's import route handlers SHALL also check the session themselves and return HTTP 401 without one (test).
6. THE README SHALL state that the demo sign-in is for judging only and that production would use phone OTP.

### Requirement 13: Import page

**User Story:** As an owner, I want to upload a file, see what will be imported and why rows fail, and then confirm, so that nothing is saved until I've checked it.

#### Acceptance Criteria

1. THE Web_App SHALL provide an import page at `/import` with minimal styling that accepts one `.csv` or `.xlsx` file.
2. IF the file is larger than 5 MB, has more than 5,000 data rows, or is not valid CSV or XLSX, THEN THE Web_App SHALL reject it with a message and write nothing.
3. WHEN a file is uploaded, THE Web_App SHALL call a preview route that returns the Import_Preview without writing to the database.
4. THE Web_App SHALL show a preview table with, for each row: file row number, status (`new`, `already_imported` or `error`), invoice number, buyer, amount formatted with the Engine's `formatINR` in `full` style, invoice date, accepted date, a marker when the acceptance date was defaulted, warnings, and for error rows each column and reason. Unused columns and summary counts per status SHALL appear above the table.
5. WHEN the owner confirms, THE Web_App SHALL send the file again to a commit route, which repeats parsing and validation on the server and writes only rows that are valid and not already imported. It SHALL NOT trust row data sent from the browser.
6. WHEN the commit finishes, THE Web_App SHALL show the inserted and skipped counts.
7. THE Web_App SHALL take the supplier id only from the session, never from the request body.

### Requirement 14: Delivery constraints for the tasks phase

**User Story:** As the developer, I want each finished task committed on its own following the git-workflow steering file, so that history stays reviewable.

#### Acceptance Criteria

1. WHEN a task in `tasks.md` is finished and the tests, typecheck and lint pass for the packages it touched, THE developer SHALL create exactly one commit for that task.
2. THE developer SHALL write commit messages as `<type>(<scope>): <subject>` with scope `ledger`, `db`, `web`, `engine` or `kiro`, a subject of at most 72 characters in imperative mood, and the body line `Spec: ledger-import, task <n>`.
3. THE developer SHALL use the existing git identity, add no `Co-Authored-By` or AI attribution trailers, stage files by explicit path, and check `git diff --staged` for `.env` files, keys and tokens before committing.

## Notes

- The seed has no not-covered invoice. The Engine's two Non_Coverage_Reasons (`medium_or_unregistered`, `trader`) depend only on supplier facts, the demo supplier is micro manufacturing, and invoices never carry facts that differ from their Supplier_Record. Bansal Hardware shows the caveat case instead.
- The Bansal Hardware interest applies 575 bps to all 956 days, because the Engine uses one Bank_Rate per calculation (out of scope in `legal-engine`). The bank rate in force during 2024–26 was not 575 bps for the whole period, so this figure is a demo value, not a sound claim against a real buyer. Supporting rate changes during the accrual period needs an engine change in a later spec.
- `legal-rules.md` has no rule ID for MSMED s.2(b). The delivery aliases are an import mapping only. If the agent ever tells a buyer that acceptance equals delivery, add a rule ID first.
- Auth.js `next-auth` v5 is still on the beta channel (5.0.0-beta.32 as of the [July 2026 security update](https://better-auth.com/blog/security-update-july-2026)), and v4 is in maintenance. The design will pin the v5 beta.
- Next.js 16 [renamed `middleware.ts` to `proxy.ts`](https://nextjs.org/docs/messages/middleware-to-proxy). The old name still runs but is deprecated.
- exceljs returns JS `Date` objects for date cells and guesses types when it reads CSV. That is why CSV is parsed as plain text in the Ledger and XLSX cells are converted explicitly (Requirement 5.2).
