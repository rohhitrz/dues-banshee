# Implementation Plan: landing-3d

## Overview

Three commits, each green on `pnpm --filter web test` and the web typecheck:
1. The `lib/landing` modules (Sharma example, copy, pricing) with their tests and the landing money-lint scan.
2. The `/landing` page, its CSS Module and metadata, with the render test.
3. The Signin_Page link, its test and the Playwright smoke test.

Lite only: no three.js, GSAP, new dependency or `"use client"` module. All test sub-tasks are required.

## Tasks

- [ ] 1. Landing data modules and money lint
  - [ ] 1.1 Implement `apps/web/lib/landing/sharma-example.ts`
    - Export `EXAMPLE_DATE` ("2026-11-12"), `SharmaExample`, `sharmaInvoice()` and `sharmaExample()` as in design.md.
    - `sharmaInvoice()` finds the `DEMO_INVOICES` entry with `invoiceNumber` "LPC/26-27/0412" (throws if missing) and builds an Engine `Invoice` from it plus `DEMO_SUPPLIER`'s `supplierCategory`, `supplierActivity` and `udyamRegisteredOn`; `id` is the invoice number.
    - `sharmaExample()` calls `taxBomb(sharmaInvoice(), EXAMPLE_DATE)`, throws a data-free error unless `status` is "armed", and returns `buyerName` from the seed entry, `daysLeft`, `deductionAtRiskPaise`, `formatINR(…, "full")` and `formatDisplayDate(EXAMPLE_DATE)`.
    - No `₹`, `toFixed`, `parseFloat`, `Number(` or division.
    - _Requirements: 1.7, 2.4_
  - [ ] 1.2 Implement `apps/web/lib/landing/copy.ts` and `apps/web/lib/landing/pricing.ts`
    - `copy.ts`: `HERO`, `LADDER_COPY` (`as const satisfies Record<LadderStep, { name: string; line: string }>`, names per Requirement 2.3, the "Voice call" line saying it is an AI call over the internet and that phone (PSTN) calls are on the roadmap), `LADDER_APPROVAL`, `TAX_BOMB_COPY` (rule IDs typed as `RuleId`), `CA_COPY`, `ROADMAP_ITEMS`, `CREW_COPY` (href `https://github.com/rohhitrz/dues-banshee-crew`), `TALK_TO_US_URL`, `KIROWEEN_LINE`. No `₹` character and no import from `pricing.ts`.
    - `pricing.ts`: the header comment naming it the one landing money-lint exception, `PlanPrice`, `Plan`, `PRICING_HEADING`, `PRICING_LABEL`, `PLANS` (four plans in order, prices 0, 99_900 + 69_900, 49_900 paise, Custom with no price and the "Talk to us" CTA to `TALK_TO_US_URL`), and `PROBLEM_SIZE` (figure "about ₹8.1 lakh crore" and the source text of Requirement 2.7).
    - _Requirements: 2.2, 2.3, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 3.1, 3.2, 3.3, 3.4_
  - [ ] 1.3 Write the data tests in `apps/web/test/landing-page.test.tsx`
    - Requirement 6.2: `taxBomb(sharmaInvoice(), "2026-11-12")` has `status` "armed", `daysLeft` 139 and `deductionAtRiskPaise` 41_200_000, computed by calling the Engine in the test.
    - `sharmaExample()` returns `buyerName` "Sharma Traders", `deductionAtRiskText` "₹4,12,000", `daysLeft` 139, `exampleDateText` "12 Nov 2026".
    - `Object.keys(LADDER_COPY)` sorted equals `[...LADDER_STEPS]` sorted, and the step names in `LADDER_STEPS` order equal the five names of Requirement 2.3.
    - `PLANS` names are Free, Banshee, CA firms, Custom in order; every price `paise` is a non-negative safe integer; their `formatINR(…, "full")` texts are "₹0", "₹999", "₹699", "₹499"; the Custom CTA href equals `https://www.linkedin.com/in/rohitraaj`.
    - _Requirements: 2.3, 2.4, 3.2, 3.3, 3.4, 6.2_
  - [ ] 1.4 Add the landing scan to `apps/web/test/money-lint.test.ts`
    - Add `LANDING_DIRS` (`app/(site)/landing`, `lib/landing`), `RUPEE_EXCEPTION` ("lib/landing/pricing.ts") with the comment of design.md, and `findRupeeSigns(relPath, source)`.
    - Real scan: no `findOffences` hit, no `findDivisions` hit and no `findRupeeSigns` hit in any landing `.ts`/`.tsx` source; assert the scan finds `lib/landing/pricing.ts` (the `page.tsx` assertion is added in task 2.3).
    - Detector test: `findRupeeSigns("lib/landing/copy.ts", 'const a = "₹1";')` returns `[1]`; the same source with `"lib/landing/pricing.ts"` returns `[]`.
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [ ] 2. The `/landing` page
  - [ ] 2.1 Implement `apps/web/app/(site)/landing/page.tsx`
    - Export `metadata` with the exact title "Dues Banshee — They forgot your invoice. The taxman won't." and the one-sentence description of design.md; no `openGraph` or `twitter` images.
    - Synchronous default export `LandingPage()` rendering the nine sections in order with the `aria-label`s of Requirement 2.1: ladder from `LADDER_STEPS.map((s) => LADDER_COPY[s])`; tax-bomb values from `sharmaExample()` with `IT-43BH` and `MSMED-16` labels and no interest amount; prices only through `formatINR(price.paise, "full")`; External_Links with `target="_blank"` and `rel="noopener noreferrer"`; footer with only `KIROWEEN_LINE`.
    - No `FOOTER_TEXT` import, no form, no Razorpay link, no `auth`, `cookies`, `headers`, `searchParams`, `process.env`, database or `fetch`. Plain `<a>` links.
    - _Requirements: 1.1, 1.6, 1.7, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 3.1, 3.2, 3.3, 3.4, 3.5, 4.2, 4.5_
  - [ ] 2.2 Implement `apps/web/app/(site)/landing/landing.module.css`
    - Theme variables from `globals.css` and the look of `design/Landing.dc.html` / `ui-theme.md`; `clamp()` padding and headings; pricing grid `repeat(auto-fit, minmax(min(100%, 240px), 1fr))`; every link `min-height: 44px`.
    - Keyframes only on `aria-hidden` decoration; final `@media (prefers-reduced-motion: reduce)` block setting `animation: none !important; transition: none !important` on `.page` descendants and pseudo-elements.
    - _Requirements: 4.1, 4.3, 4.4, 4.5_
  - [ ] 2.3 Write the render tests in `apps/web/test/landing-page.test.tsx` and finish the lint scan
    - Render `LandingPage()` with `renderToStaticMarkup`, no mocks. Check every item of Requirement 6.1: exact `metadata.title` and no images; the nine `aria-label`s in strictly increasing order; within each section's slice: Hero `<h1>` and the `/signin` CTA, the five step names in order and the full "Voice call" line, "₹4,12,000", "139", "12 Nov 2026", `IT-43BH`, `MSMED-16`, the Problem_Size figure and source, the pricing heading, label, card names in order and four price texts, both External_Link hrefs with `target="_blank"` and `rel="noopener noreferrer"`, "Built for Kiroween 2026." in the footer; the Disclaimer text absent from the markup; no `<form`; no `href` containing "razorpay" (case-insensitive). Compare against HTML-escaped text (`&#x27;`).
    - In `money-lint.test.ts`, assert the landing scan also finds `app/(site)/landing/page.tsx`.
    - _Requirements: 1.6, 2.1–2.11, 3.1–3.5, 5.3, 6.1_

- [ ] 3. Signin link and smoke test
  - [ ] 3.1 Add the link to the Signin_Page
    - In `apps/web/app/(site)/signin/page.tsx`, add `<Link href="/landing" className={styles.about}>What is Dues Banshee?</Link>` below the form; add `.about` to `signin.module.css` (secondary text colour, `min-height: 44px`).
    - Do not edit `apps/web/proxy.ts` or any file under `app/(app)`.
    - _Requirements: 1.2, 1.4, 1.5_
  - [ ] 3.2 Write the signin and Playwright tests
    - `apps/web/test/signin.test.tsx`: one new `it` rendering `SignInPage` with no error and matching `<a [^>]*href="/landing"[^>]*>What is Dues Banshee\?</a>`. Existing cases unedited and passing.
    - New `apps/web/e2e/landing-smoke.spec.ts`: fresh context with no cookies; `page.goto("/landing")` response status 200; the `<h1>` "They forgot your invoice. The taxman won't." visible; click "Enter the demo"; `expect(page).toHaveURL(/\/signin$/)`.
    - Run `pnpm --filter web e2e -- landing-smoke` when a demo-seeded `DATABASE_URL` is available; otherwise report that it was not run.
    - `apps/web/test/proxy.test.ts` and `graveyard-page.test.tsx` pass without edits.
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 6.3, 6.4, 6.5_

- [ ] 4. Final checkpoint
  - Run `pnpm --filter web test` and the web typecheck. Ensure all tests pass, ask the user if questions arise.
  - Manual: `/landing` at 375 px with no horizontal scroll, and with OS reduced motion on, nothing moves (Requirements 4.3, 4.4).

## Notes

- No optional tasks: every test sub-task is required.
- Each parent task ends green on tests and typecheck, so it can be one commit (git-workflow.md).
- The `page.tsx` existence assertion in the money lint waits for task 2.3, because the page only exists after task 2.1.
- Tasks 1.3 and 2.3 both edit `landing-page.test.tsx`, so they run in separate waves.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "1.4"] },
    { "id": 2, "tasks": ["2.1", "2.2"] },
    { "id": 3, "tasks": ["2.3", "3.1"] },
    { "id": 4, "tasks": ["3.2"] },
    { "id": 5, "tasks": ["4"] }
  ]
}
```
