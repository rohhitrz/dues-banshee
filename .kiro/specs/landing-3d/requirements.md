# Requirements Document

## Introduction

landing-3d adds a public marketing page at `/landing` (roadmap section 8, **Lite only**). It is the startup website for the Best Startup category. The Full bonus (meridian 3D hero, pinned ladder, dot-field, three.js, GSAP) is out of scope for this spec.

The page reuses what exists and computes nothing itself:
- Ladder order: `LADDER_STEPS` from `@dues-banshee/engine`.
- Tax-bomb example: the Engine's `taxBomb` on the Sharma Traders entry of `DEMO_INVOICES` and `DEMO_SUPPLIER` from `@dues-banshee/db`, at the fixed Example_Date 2026-11-12. The page reads no database, no env var and no `?today` parameter, so the example values never change.
- Money text: `formatINR` from the Engine. Date text: `formatDisplayDate` from the Engine.

Decisions made while writing this spec:
- **Copy follows the roadmap, look follows the design.** `design/Landing.dc.html` has a different hero headline and pricing heading. The roadmap copy wins; the design file sets layout, colours and type, together with `ui-theme.md`.
- **The interest line states the MSMED-16 rule without an amount.** An interest amount needs the bank rate, which lives in the database `config` table. Reading it would make the public page depend on the database.
- **Step names follow the roadmap** ("WhatsApp pay link", "Samadhaan pack"), not the dashboard's `STEP_TEXT` ("WhatsApp + UPI link", "MSME ODR pack"). `STEP_TEXT` stays unchanged.
- **Plan prices are integer paise rendered with `formatINR`**, so the global "every amount through `formatINR`" rule holds on this page too.
- **The problem-size figure lives in the pricing file.** The roadmap allows one hand-typed-figures file. The ₹8.1 lakh crore statistic and its source text sit there next to the plan prices, so that file stays the only exception to the landing money lint.

Global rules apply: Engine output is the single source of truth for legal and money values; the Disclaimer appears on the page; every legal claim cites a rule ID from `legal-rules.md`; tests are mandatory and no test task may be marked optional.

Size constraint: design.md stays lean and tasks.md plans about 3 parent tasks.

Non-goals: billing or checkout, payment links, signup, analytics, a contact form, 3D or WebGL, new dependencies, any change to `/` or to the proxy.

## Glossary

- **Landing_Page**: the server component at `apps/web/app/(site)/landing/page.tsx`, served at `/landing`.
- **Signin_Page**: the existing page at `apps/web/app/(site)/signin/page.tsx`.
- **Pricing_File**: `apps/web/lib/landing/pricing.ts`, which holds the plan constants and the Problem_Size figure.
- **Landing_Dirs**: `apps/web/app/(site)/landing` and `apps/web/lib/landing`.
- **Example_Date**: the calendar date `2026-11-12`, a single named constant in the landing code.
- **Sharma_Invoice**: the Engine `Invoice` built from the `DEMO_INVOICES` entry with `invoiceNumber` "LPC/26-27/0412" and the category, activity and Udyam registration date of `DEMO_SUPPLIER`.
- **Sharma_Bomb**: `taxBomb(Sharma_Invoice, Example_Date)`. Its expected values are `status` "armed", `daysLeft` 139, `deductionAtRiskPaise` 41200000.
- **Disclaimer**: the exact text "Reminders a supplier sends to its own buyers. Not legal advice."
- **Proxy_Matcher**: `config.matcher` in `apps/web/proxy.ts`.
- **Talk_To_Us_URL**: `https://www.linkedin.com/in/rohitraaj`.
- **Crew_Repo_URL**: `https://github.com/rohhitrz/dues-banshee-crew`.
- **External_Link**: an `<a>` with `target="_blank"` and `rel="noopener noreferrer"`.

## Requirements

### Requirement 1: Route and access

**User Story:** As a visitor or a hackathon judge, I want to open the product page without signing in, so that I can understand Dues Banshee before entering the demo.

#### Acceptance Criteria

1. THE Landing_Page SHALL be served at `/landing` from `apps/web/app/(site)/landing/page.tsx` as a server component, with its styles in a CSS Module in the same folder.
2. THE Proxy_Matcher SHALL stay unchanged, so `apps/web/test/proxy.test.ts` passes without edits and no Proxy_Matcher entry matches `/landing`.
3. WHEN a signed-out visitor requests `/landing`, THE app SHALL respond 200 with the Landing_Page, without a redirect to `/signin`.
4. THE `/` route SHALL stay the graveyard dashboard, with no change to its files.
5. THE Signin_Page SHALL show one link with the text "What is Dues Banshee?" whose `href` is `/landing`, and the existing `apps/web/test/signin.test.tsx` assertions SHALL pass without edits.
6. THE Landing_Page SHALL export Next.js `metadata` with `title` "Dues Banshee — They forgot your invoice. The taxman won't." and a one-sentence `description` saying it is AI collections for Udyam micro and small suppliers: reminders, legal notices and tax-bomb countdowns. THE `metadata` SHALL set no image (no `openGraph.images`, no `twitter.images`).
7. THE Landing_Page SHALL read no database, no environment variable, no cookie and no search parameter, and SHALL make no network call.

### Requirement 2: Sections and copy

**User Story:** As a visitor, I want the story in a fixed order, so that I see the problem, the method, the price and the proof in one scroll.

#### Acceptance Criteria

1. THE Landing_Page SHALL render these nine sections in this order, each as a `<section>` (the footer as a `<footer>`) with an `aria-label`: Hero, Ladder, Tax bomb, Problem size, CA firms, Pricing, Roadmap, Built with Kiro, Footer.
2. THE Hero section SHALL show the `<h1>` "They forgot your invoice. The taxman won't.", one sub-line, and a link "Enter the demo" whose `href` is `/signin`.
3. THE Ladder section SHALL list the five steps in `LADDER_STEPS` order, one line each, named "WhatsApp nudge", "WhatsApp pay link", "Voice call", "Legal notice" and "Samadhaan pack", and SHALL state that the owner approves every step. The "Voice call" line SHALL say it is an AI call over the internet and that phone (PSTN) calls are on the roadmap. The step copy SHALL be keyed by `LadderStep` so a step added to or removed from `LADDER_STEPS` fails type-checking.
4. THE Tax bomb section SHALL show the Sharma Traders example with `formatINR(Sharma_Bomb.deductionAtRiskPaise, "full")` ("₹4,12,000") as the deduction at risk and `Sharma_Bomb.daysLeft` (139) as the days left, labelled with `formatDisplayDate(Example_Date)` ("12 Nov 2026") as the example date.
5. THE Tax bomb section SHALL state that an invoice already past its MSMED s.15 time limit and still unpaid on 31 March costs the buyer that year's deduction, and that the return-filing grace period does not apply, citing `IT-43BH` (Income-tax Act 1961 s.43B(h); Income-tax Act 2025 s.37(2)(g)).
6. THE Tax bomb section SHALL include one line stating that late payment carries compound interest with monthly rests at 3× the RBI bank rate, citing `MSMED-16`, with no interest amount.
7. THE Problem size section SHALL show the Problem_Size figure "about ₹8.1 lakh crore" of delayed MSME payments and name its source on the page: "Economic Survey figure, as reported in Recordent's Indian SME Receivables Report 2026".
8. THE CA firms section SHALL state that CAs already keep their MSME clients' books and that one dashboard runs collections for all their clients.
9. THE Roadmap section SHALL list: phone (PSTN) calls, Tally sync, auto-send WhatsApp after Meta verification, and an AI sales agent on calls.
10. THE Built with Kiro section SHALL state that a Kiro Crew app runs the ladder every morning at 9 and only drafts messages for the owner to approve, and SHALL link to the Crew_Repo_URL as an External_Link.
11. THE Footer SHALL show the Disclaimer and "Built for Kiroween 2026."

### Requirement 3: Pricing

**User Story:** As a supplier or a CA, I want to see planned prices, so that I can judge the product is affordable, without being asked to pay.

#### Acceptance Criteria

1. THE Pricing section SHALL show the heading "Cheaper than one legal notice." and the label "Launch pricing (planned). The demo is free."
2. THE Pricing section SHALL show four plan cards in this order, with these contents:
   - **Free**, `formatINR(0, "full")`: 10 open invoices, interest and 31 March countdowns, WhatsApp nudges.
   - **Banshee**, `formatINR(99900, "full")` per month or `formatINR(69900, "full")` per month billed yearly: 150 open invoices, full ladder, pay links, Hinglish voice calls about 60 min per month, legal notice and Samadhaan pack, daily Kiro Crew run.
   - **CA firms**, `formatINR(49900, "full")` per client per month, minimum 10 clients: all MSME clients in one dashboard.
   - **Custom**, "Talk to us": high volume, more voice minutes, Tally sync, custom terms.
3. THE Custom card SHALL link "Talk to us" to the Talk_To_Us_URL as an External_Link.
4. THE Pricing_File SHALL hold every plan price as an integer number of paise and every plan's name and feature lines, and THE Pricing section SHALL render prices only through `formatINR`.
5. THE Landing_Page SHALL contain no form, no checkout button, no payment link and no link to Razorpay.

### Requirement 4: Look, responsiveness and motion

**User Story:** As a visitor on a phone, I want the page readable and calm, so that the theme helps rather than distracts.

#### Acceptance Criteria

1. THE Landing_Page SHALL follow the layout, colours and type of `design/Landing.dc.html` and `ui-theme.md`, using CSS Modules only.
2. THE Landing_Page SHALL add no new package dependency and SHALL import neither `three` nor `gsap`.
3. WHILE the viewport is 375 px wide, THE Landing_Page SHALL show every section without horizontal scrolling, and the four pricing cards SHALL stack in one column.
4. WHILE `prefers-reduced-motion: reduce` is set, THE Landing_Page SHALL run no CSS animation or transition.
5. THE Landing_Page SHALL use real `<a>` links for every navigation, each with a touch target of at least 44 px, and SHALL keep text contrast at 4.5:1 or more as `ui-theme.md` specifies.

### Requirement 5: Money lint

**User Story:** As the builder, I want the page unable to show a hand-typed legal amount, so that the Sharma figures always match the Engine.

#### Acceptance Criteria

1. THE `apps/web/test/money-lint.test.ts` file SHALL scan every non-test `.ts` and `.tsx` source under the Landing_Dirs for the existing banned tokens (`toFixed`, `parseFloat`, `Number(`) and for the division operator, using the existing `findOffences` and `findDivisions` detectors.
2. THE same scan SHALL fail on any `₹` character in a Landing_Dirs source other than the Pricing_File, and a comment in the test SHALL name the Pricing_File as the one documented exception and say why (product constants and a cited statistic, not legal money).
3. THE scan SHALL assert that it finds `app/(site)/landing/page.tsx` and `lib/landing/pricing.ts`, so it cannot pass with zero files.
4. THE scan SHALL come with a detector test that flags a `₹` in a sample source and passes the same sample when it is the Pricing_File.

### Requirement 6: Tests

**User Story:** As the builder, I want the page pinned by tests, so that a copy or engine change cannot silently break the startup website.

#### Acceptance Criteria

1. A new render test `apps/web/test/landing-page.test.tsx`, in the style of the existing page tests, SHALL check:
   - the nine sections of Requirement 2 criterion 1 appear in that order;
   - the exported `metadata.title` equal to "Dues Banshee — They forgot your invoice. The taxman won't.";
   - the Hero `<h1>` text and the "Enter the demo" `href` `/signin`;
   - the five ladder step names in `LADDER_STEPS` order, and the "Voice call" line's text that it is an AI call over the internet and that phone (PSTN) calls are on the roadmap;
   - the exact Sharma values "₹4,12,000", "139" and "12 Nov 2026" in the Tax bomb section;
   - the rule IDs `IT-43BH` and `MSMED-16` in the Tax bomb section;
   - the Problem_Size figure and its source text;
   - the pricing heading, the label, the four card names in order and the prices "₹0", "₹999", "₹699" and "₹499";
   - the "Talk to us" `href` equal to the Talk_To_Us_URL and the Crew link `href` equal to the Crew_Repo_URL, both with `target="_blank"` and `rel="noopener noreferrer"`;
   - the Disclaimer and "Built for Kiroween 2026." in the footer;
   - no `<form>` element and no `href` containing "razorpay".
2. THE render test SHALL check that Sharma_Bomb, computed in the test from `DEMO_INVOICES` and `DEMO_SUPPLIER`, has `status` "armed", `daysLeft` 139 and `deductionAtRiskPaise` 41200000, so a seed or Engine change fails the test instead of changing the page silently.
3. THE `apps/web/test/signin.test.tsx` file SHALL gain one test that the Signin_Page renders a link "What is Dues Banshee?" with `href` `/landing`.
4. A new Playwright test `apps/web/e2e/landing-smoke.spec.ts` SHALL, with no session, request `/landing`, assert status 200 and the Hero `<h1>`, click "Enter the demo" and assert the URL path is `/signin`.
5. THE `pnpm --filter web test` run SHALL pass with the new tests, and `apps/web/test/proxy.test.ts` SHALL pass without edits.
