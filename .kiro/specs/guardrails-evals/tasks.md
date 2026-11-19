# Implementation Plan: guardrails-evals
## Overview
TypeScript (strict), Vitest + fast-check, zod, `tsx` for the eval CLI. The order keeps every commit green. First come the pure checks and the Draft_Guard with their tests. Then the Draft_Guard is wired into `draftStep` and the prompt, followed by the fixtures and the runner. The call-hours table and the source lint rules come next, and the Kiro hook goes last.
No Engine change, no change to `validateCitations`, `allowedRuleIds`, `inCallWindow` or `startCallRefusal`, and no LLM or network call in any test, eval or hook. Existing tests are extended, never removed or weakened (Req 7.1).
Every test task is required. No task is optional.
Commit rule for every top-level task (git-workflow.md): one Conventional Commit using the message given in the task, files staged by path (`git add <paths>`), `git diff --staged` checked for secrets, no `Co-Authored-By` or other trailers. Before committing, `test`, `typecheck` and `lint` must pass for every package touched by the task.
## Tasks
- [x] 1. Add the Tone_Check, Tense_Check and Draft_Guard
  - Commit: `feat(agent): add tone and tense checks behind guardDraft`
  - [x] 1.1 Add `BLOCK_REASONS` to `packages/agent/src/core/citations.ts`
    - `export const BLOCK_REASONS = [...]` with the existing nine in their current order, then `missing_address`, `threat_phrase`, `begging_phrase`, `overdue_tense`; `type BlockReason = (typeof BLOCK_REASONS)[number]`; `validateCitations` unchanged
    - Extend `packages/agent/test/citations.test.ts`: existing cases unchanged; new case asserting `BLOCK_REASONS.slice(0, 9)` equals the original nine in order
    - _Requirements: 1.1, 2.1, 7.1, 7.3_
  - [x] 1.2 Implement `src/core/match.ts`, `src/core/tone-phrases.ts` and `src/core/tone.ts`
    - `normalise` and `phraseRegex` as in design.md (non-global regexes built once, Unicode boundaries, `iu`)
    - `THREAT_LIST` and `BEGGING_LIST` exactly as the design table; `ADDRESS_REQUIRED` as a `Record<LadderStep, boolean>` (not an array or `Set`)
    - `toneCheck(text, step)`: `missing_address` (offending `null`) only where `ADDRESS_REQUIRED[step]`, then `threat_phrase`, then `begging_phrase`, offending = the list entry; `null` on pass
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8_
  - [x] 1.3 Implement `src/core/tense.ts`
    - `tenseCheck(text, overdue)`: `null` when not Overdue; else the first of patterns H1, H2, E1, E2 on `normalise(text)` gives `overdue_tense` with the matched substring as offending
    - _Requirements: 2.2, 2.3, 2.4, 2.6_
  - [x] 1.4 Implement `src/core/draft-guard.ts`
    - `GuardContext` and `guardDraft(out, ctx)`: `validateCitations` first and returned as is on a block; then `toneCheck(out.text, ctx.step) ?? tenseCheck(out.text, ctx.overdue) ?? citationResult`
    - _Requirements: 3.1, 3.2, 3.7_
  - [x] 1.5 Write `packages/agent/test/tone.test.ts` and `packages/agent/test/tense.test.ts`
    - tone: every list entry inside an addressed text triggers its reason with itself as offending; `{{buyer_name}} ji` required on `whatsapp_nudge`, `whatsapp_paylink`, `legal_notice` and not on `voice_call`, `odr_pack`; `{{buyer_name}} JI` and `{{buyer_name}}\n ji` pass, `{{buyer_name}} jiyo` fails; check order (a text with no address and a threat → `missing_address`); THREAT_LIST ≥ 8 and BEGGING_LIST ≥ 6 entries, each with English and Hinglish entries; no entry equals or contains, as a whole word, any of `please`, `interest`, `msme`, `odr`, `facilitation council`, `samadhaan`, `kripya`, `request`; the polite phrases `dekh lena`, `or else` and `vinti hai` match no entry
    - tense: each of H1, H2, E1, E2 blocks with its matched text; `{{due_date}} ko due tha`, `due ho chuka hai`, `was due on {{due_date}}` and `{{principal}} abhi bhi due hai` pass on an Overdue invoice; every pattern passes when not Overdue
    - _Requirements: 1.2–1.7, 2.2, 2.3, 2.4_
  - [x] 1.6 Write `packages/agent/test/draft-guard.property.test.ts`
    - **Property 1: Citation first**, **Property 2: Normalisation invariance**, **Property 3: Not Overdue never blocks on tense**, 200 runs each, tagged `// Feature: guardrails-evals, Property N: <title>`; Property 1's generator mixes outputs that `validateCitations` blocks and accepts
    - **Validates: Requirements 1.8, 2.3, 3.1, 3.2, 3.7**
- [x] 2. Run the Draft_Guard in draftStep and add the Overdue tense line to the prompt
  - Commit: `feat(agent): run guardDraft in the draft repair path`
  - [x] 2.1 Update `packages/agent/src/prompts/draft-step.ts`
    - `DraftPromptInput.overdue: boolean` (required); when `true`, `buildSystem` adds the `Tense:` section from design.md after the Figures section; when `false`, no such section; data block unchanged
    - Add `overdue` to every existing `draftPrompt` input in `packages/agent/test/prompt.test.ts` and `packages/agent/test/prompt-data.property.test.ts`; no existing assertion removed or weakened
    - New `prompt.test.ts` cases: the Tense section with its Hinglish and English examples present for `overdue: true`, absent for `overdue: false`
    - _Requirements: 2.5, 7.1, 7.2_
  - [x] 2.2 Update `packages/agent/src/draft-step.ts`
    - `const due = dueDate(record.invoice); const overdue = due.applicable && today > due.dueDate;` (CalendarDate string compare; no `compareDates`, no Engine change)
    - Both `validateCitations` calls become `guardDraft(output, { step, allowed, ruleIds: RULE_IDS, bankRateExists: bankRate !== null, overdue })`; `promptBase` gains `overdue`; Tool_Log `citation` field holds the guard result; error kind stays `citation_blocked`
    - _Requirements: 2.6, 3.3, 3.4, 3.5, 3.6, 3.7_
  - [x] 2.3 Extend `packages/agent/test/repair.test.ts` and keep `draft-step.test.ts`, `demo-sharma.test.ts` green
    - New case: fake model returns an addressed `warna` draft, then a clean one ⇒ one Draft, two `draft_step` rows (`initial`, `repair`), the first row's `citation` is `{ ok: false, reason: "threat_phrase", offending: "warna" }`, the repair data block carries `"reason":"threat_phrase"`
    - New case: both outputs hold `{{due_date}} ko due hai` for Sharma at 2026-11-12 ⇒ `failed` with `citation_blocked`, both rows carry `overdue_tense`
    - Existing fake outputs that now fail the Tone_Check (for example no `{{buyer_name}} ji`) get the Address_Form added; no assertion is removed
    - _Requirements: 3.3, 3.4, 3.5, 3.6, 7.1_
    - Notes: All existing draftStep fake outputs already contain `{{buyer_name}} ji` and past-tense due dates (checked 20 Nov). Do not edit existing fake outputs or tests unless a test actually fails; if one fails, add only the Address_Form and keep every assertion.
- [x] 3. Add the draft eval fixtures and runner
  - Commit: `test(agent): add offline draft eval fixtures and runner`
  - [x] 3.1 Implement `packages/agent/src/evals/fixture.ts` and `src/evals/run.ts`
    - `FIXTURE_SCHEMA` (strict) and `loadFixtures(dir)`: reads every `*.json` in `<repo>/evals/draft-step/` in name order; `FixtureError(file, issues)` on bad JSON, schema failure, duplicate name or an empty folder
    - `runEvals` (calls `guardDraft` with `ruleIds: RULE_IDS`) and `formatReport` (one `PASS|FAIL <name>  expected=<e>  actual=<a>` line per fixture, then `<passed>/<total> passed`)
    - _Requirements: 4.4, 4.5, 4.7_
  - [x] 3.2 Write the 19 fixtures in `evals/draft-step/`
    - One file per row of the design fixture table, named `<name>.json`; `sharma_2026_11_12` fixtures use the allowed rule IDs that `allowedRuleIds` gives for Sharma at that step (checked in 3.4); fixture 16 text contains `17 Oct 2026 ko due hai`; fixture 7 is `synthetic` with `overdue: false`
    - _Requirements: 4.1, 4.2, 4.3_
  - [x] 3.3 Add `packages/agent/scripts/eval.ts` and the `eval` script
    - `package.json` gains `"eval": "tsx scripts/eval.ts"`; the CLI prints `formatReport` and sets `process.exitCode = 1` on any failure or `FixtureError` (message names the file)
    - _Requirements: 4.4, 4.5, 4.7_
  - [x] 3.4 Write `packages/agent/test/evals.test.ts`
    - Every fixture's actual result equals its Expected_Result (one `it` per fixture via `loadFixtures`)
    - Coverage counts of Req 4.2: 15–20 fixtures, ≥ 3 `accept` with both languages, each new reason in both languages, the named near-misses, the roadmap tense pair, and `missing_citation`, `invalid_rule_id`, `uncited_placeholder`
    - Demo-context check: for each `sharma_2026_11_12` fixture, `nextEscalationStep` with earlier steps on `2026-10-18` advances to the fixture's step, `context.allowed` equals `allowedRuleIds` at `2026-11-12` (demo Bank_Rate 575 bps from 2026-10-07, or `null` per `bankRateExists`), and `context.overdue` is `true`
    - `loadFixtures` on a temp dir with a bad file, a duplicate name and no files each throws `FixtureError`; `formatReport` final line on a mixed result is `<p>/<t> passed`
    - _Requirements: 4.1–4.7_
- [x] 4. Pin call hours with labelled cases
  - Commit: `test(web): add labelled call-hours cases for startCallRefusal`
  - [x] 4.1 Extend `apps/web/test/start-call-refusal.property.test.ts`
    - Add the 7-row Call_Hours_Case table from design.md: `inWindow = inCallWindow(Date.parse(utcIso))`, `found`, `configured`, `callable` true, `buyerCallsToday` 0; expected refusal per row; assert each instant's IST weekday and time; existing property tests untouched; no WhatsApp code touched
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 7.1_
- [x] 5. Extend the source lint
  - Commit: `test(agent): lint step sets, step ranking and voice imports`
  - [x] 5.1 Extend `packages/agent/test/source-lint.test.ts`
    - Add `stepSetHits`, `stepRankHits` and `voiceImportHits` (voice imports checked in `packages/agent/src` only); scan of the current source returns `[]` for each
    - Detector tests with the positive samples and near-misses from design.md, in the `source lint detectors` block; existing tests unchanged
    - _Requirements: 7.1, 7.4, 7.5, 7.6, 7.7, 7.8_
- [~] 6. Add the Kiro hook and run the final check
  - Commit: `chore(kiro): add hook to re-run guardrail evals on prompt save`
  - [x] 6.1 Add `.kiro/hooks/guardrails-evals-on-save.json`
    - Exactly the JSON in design.md; `engine-tests-on-save.json` unchanged
    - _Requirements: 6.1, 6.2, 6.3, 6.4_
  - [-] 6.2 Final check
    - Run `pnpm --filter @dues-banshee/agent eval` (prints `19/19 passed`, exit 0), then the hook command once by hand, then `test`, `typecheck` and `lint` for `@dues-banshee/agent`, `@dues-banshee/voice` and `apps/web`; all green, with no network or LLM call
    - _Requirements: 4.4, 4.6, 4.7, 6.3_
## Notes
- Task 2.3 may add the Address_Form to existing fake model outputs in agent tests because the Tone_Check now requires it on steps 1, 2 and 4. That changes inputs, not assertions.
- Property tests use fast-check with 200 runs, tagged `// Feature: guardrails-evals, Property N: <title>`.
- Fixture JSON lives at the repo root (`evals/draft-step/`, per `structure.md`); the loader resolves it from `packages/agent`, so it works from both `eval` and `test`.
## Task Dependency Graph
```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "4.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["1.4", "1.5"] },
    { "id": 3, "tasks": ["1.6", "2.1"] },
    { "id": 4, "tasks": ["2.2", "3.1"] },
    { "id": 5, "tasks": ["2.3", "3.2", "3.3"] },
    { "id": 6, "tasks": ["3.4", "5.1"] },
    { "id": 7, "tasks": ["6.1"] },
    { "id": 8, "tasks": ["6.2"] }
  ]
}
```
