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