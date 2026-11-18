# Kiro log

Two lines per spec: what Kiro did, which Kiro features, credits, one screenshot.

## legal-engine
Spec (requirements-first) + tasks on Sonnet 5.5; pure TS engine for MSMED s.15/16 interest, 43B(h) tax bomb, ladder steps; 290 tests incl. fast-check properties. Kiro features: spec, steering (git-workflow.md), task runner. Credits: in cumulative below. Screenshot: —

## ledger-import
Spec (requirements-first) + tasks on Sonnet 5.5; CSV/XLSX/Tally import, paise-only BigInt parsing, dedupe, zip-bomb cap; 245 tests. Kiro features: spec, steering, task runner. Credits: in cumulative below. Screenshot: —

## dashboard-ui
Spec (requirements-first) + 14 tasks on Sonnet 5.5; 9 fast-check properties; 2 Claude Code reviews → 11 fixes (zip-bomb hole, Auth.js re-setting a cleared cookie). Kiro features: spec, steering (ui-theme.md), task runner. Credits: ~875 cumulative (all specs so far). Screenshot: graveyard-1440.png

## escalation-ladder
Spec (requirements-first, Opus 5.5) + 23 tasks on Sonnet 5.5, Supervised; AI-SDK v7 drafts (Haiku 5.5 / Sonnet 5.5 legal / GPT-6 Luna fallback) with rule-ID citation validator, engine-only money and dates, owner approval queue, bearer-protected ladder run, PDF legal notice + ODR pack (Noto Sans for ₹); live check passed on both providers; 2 Claude Code reviews → 7 fixes (blank-draft crash, demo-only Today override, Vercel font tracing, double-submit guard). Kiro features: spec, steering (roadmap.md, git-workflow.md), task Notes lines, hook (engine tests on save). Credits: ~348 this spec; 1,224 cumulative. Screenshot: approvals-queue.png

## debtor-ui
Spec (requirements-first, Opus 5.5) + 11 tasks on Sonnet 5.5, Autopilot; `/debtors/[id]` séance page: invoice panels from the same graveyard builder, candle timeline (invoices, due dates, ladder events, promises, payments), the buyer's pending drafts approved in place via an allowlisted `returnTo`, disabled pay-link/call placeholders; engine `hasActivePromise`/`activePromiseUntil` shared with the graveyard wisp; separate `(debtor)` route group so 404/307 are real status codes; 10 fast-check properties; first Playwright smoke test (demo path). 1 Claude Code review → 3 fixes (demo-only `?today` on tombstone links, retry-link validation, lowercase returnTo). Kiro features: spec, steering (roadmap.md, git-workflow.md), task Notes lines, hook (engine tests on save). Credits: ~197 this spec; 1,421 cumulative. Screenshot: debtor-page.png

## whatsapp-channel
Spec (requirements-first, Opus 5.5, 3 doc-checked revisions) + 14 tasks on Sonnet 5.5, Supervised; MessageChannel with wa.me one-tap send (demo path) and a tested Twilio sender (create + status polls), Razorpay test pay links reused by reference_id, send claim against double sends, raw-body HMAC payment_link.paid webhook with event-id dedupe → tombstone resurrects (verified live on Vercel); migrations 0003–0004. Meta locked (131031) and Twilio trial template-only (21654), so auto-send moved to the roadmap. 1 Claude Code review → 7 fixes (retry double-send guard, pay-link amount check, signature before db lookup, unique provider_link_id). Kiro features: spec, steering (roadmap.md, git-workflow.md), task Notes lines, sub-agent checkpoints. Credits: ~381 this spec; 1,802 cumulative. Screenshot: resurrected-paid.png