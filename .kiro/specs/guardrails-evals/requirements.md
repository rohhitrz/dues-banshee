# Requirements Document
## Introduction
guardrails-evals adds deterministic tone and tense checks to the escalation draft path, pins the existing citation and call-hours checks with labelled eval fixtures, and re-runs those evals from a Kiro hook whenever a prompt changes (roadmap section 6). Every check is plain code. There is no LLM judge and no live LLM call in any test, eval or hook.
The spec reuses what exists and re-implements nothing:
- Citation check: `validateCitations` in `packages/agent/src/core/citations.ts` with `allowedRuleIds` from `packages/agent/src/core/allowed-rule-ids.ts`, unchanged.
- Tone and tense checks: new `BlockReason` values, run after `validateCitations` inside the existing block-and-repair path of `packages/agent/src/draft-step.ts` (one Repair_Call, no fallback, then `citation_blocked`).
- Call hours: voice calls only, through `inCallWindow` (`packages/voice/src/dates.ts`) and `startCallRefusal` (`apps/web/lib/call/callable.ts`). WhatsApp sends get no hours rule. `packages/agent` never imports `@dues-banshee/voice`, because the voice package depends on the agent package.
The checks read the Model_Output template (the text with Placeholders, before `fillPlaceholders`), so they never see buyer names, invoice numbers or money values.
Fixture location: `evals/draft-step/` at the repo root, as `structure.md` places labelled fixtures in `evals/`. The runner is a script of `packages/agent`.
Tests are mandatory in this spec. No test task may be marked optional.
Size constraint: design.md stays lean and tasks.md plans at most 6 parent tasks.
Non-goals: an LLM tone judge; live-model evals; checks on the voice agent's spoken output; an hours rule for WhatsApp; changes to the Engine, to `validateCitations` or to the call window; new UI; the deferred voice polish items in `roadmap.md` section 5.
## Glossary
- **Engine**, **Draft**, **Draft_Attempt**, **Repair_Call**, **Final_Text**, **Tool_Log**, **Ladder_Step**, **Demo_Seed**, **Today**: as defined in `.kiro/specs/escalation-ladder/requirements.md`.
- **Bank_Rate**: as defined in `.kiro/specs/dashboard-ui/requirements.md`.
- **Call_Window**, **Demo_Supplier**, **Demo_Call_Limit**: as defined in `.kiro/specs/buyer-voice-call/requirements.md`.
- **Model_Output**: the `{ text, ruleIds }` object returned by the model (`packages/agent/src/core/model-output.ts`).
- **Placeholder**: one of the `{{name}}` tokens in `PLACEHOLDERS` (`packages/agent/src/core/citations.ts`).
- **Citation_Check**: `validateCitations`, unchanged.
- **Tone_Check**: the new pure function that blocks a Model_Output for a missing address, a threat phrase or a begging phrase.
- **Tense_Check**: the new pure function that blocks a Model_Output that speaks of a passed due date as if it were still ahead.
- **Draft_Guard**: the new pure function that runs Citation_Check, then Tone_Check, then Tense_Check, and returns the first block or the Citation_Check acceptance. Its result has the existing `CitationResult` shape.
- **Address_Form**: the exact text `{{buyer_name}} ji`, matched with `ji` as a whole word in any letter case.
- **Threat_List**, **Begging_List**: two lists of phrases, each with Hinglish (Roman script) and English entries, kept in one file in `packages/agent/src/core/`. Matching is case-insensitive, on whole words, after collapsing runs of whitespace to one space.
- **Future_Tense_Patterns**: phrases that place `{{due_date}}` in the present or future, in Hinglish and English (for example `{{due_date}} ko due hai`, `{{due_date}} ko due hoga`, `{{due_date}} ko due hogi`, `is due on {{due_date}}`, `will be due on {{due_date}}`), matched case-insensitively after collapsing runs of whitespace to one space.
- **Overdue**: Today is after the Engine `dueDate` of the invoice. An invoice with no Engine due date is not Overdue.
- **Eval_Fixture**: one JSON file in `evals/draft-step/` holding a name, a Draft_Context, a recorded Model_Output and an Expected_Result.
- **Draft_Context**: the Draft_Guard inputs other than the Model_Output: Ladder_Step, language, allowed rule IDs, whether a Bank_Rate exists, and Overdue.
- **Expected_Result**: `accept`, or one exact `BlockReason`.
- **Eval_Runner**: the `packages/agent` script run by `pnpm --filter @dues-banshee/agent eval`.
- **Call_Hours_Case**: one labelled case of an instant, a supplier kind (demo or not) and the refusal `startCallRefusal` must return for it.
## Requirements
### Requirement 1: Tone_Check
**User Story:** As a supplier, I want every draft to address my buyer respectfully and to never threaten or beg, so that I keep the relationship while I collect.
#### Acceptance Criteria
1. THE `BlockReason` union SHALL gain `missing_address`, `threat_phrase` and `begging_phrase`; the existing nine values SHALL stay unchanged.
2. WHEN the Model_Output text does not contain the Address_Form, THE Tone_Check SHALL block it with `missing_address` and offending `null`.
3. WHEN the text contains a Threat_List phrase, THE Tone_Check SHALL block it with `threat_phrase` and the matched phrase as offending.
4. WHEN the text contains a Begging_List phrase, THE Tone_Check SHALL block it with `begging_phrase` and the matched phrase as offending.
5. THE Tone_Check SHALL run its checks in the order of criteria 2, 3 and 4, and the first failure SHALL win.
6. THE Threat_List SHALL hold at least 8 entries and the Begging_List at least 6, each with both Hinglish and English entries. Words that a respectful draft uses for facts or courtesy (for example "please", "kripya", "request", "interest", "MSME", "ODR", "Facilitation Council", "Samadhaan") SHALL not be list entries, so a legal remedy stated as information is never a threat; the existing accepted drafts in `packages/agent/test` (for example the "Kripya {{pay_link}} se bhugtan kar dein." line in `demo-sharma.test.ts`) SHALL still pass.
7. THE missing_address check (criterion 2) SHALL apply to the `whatsapp_nudge`, `whatsapp_paylink` and `legal_notice` steps only, because `voice_call` is a brief for the owner and `odr_pack` is a statement for the portal; criteria 3 and 4 SHALL apply to every Ladder_Step and both languages.
8. THE Tone_Check SHALL be pure and SHALL take only the Model_Output text and the Ladder_Step, so buyer names and invoice numbers cannot change its result.
### Requirement 2: Tense_Check
**User Story:** As a supplier, I want a reminder for an overdue invoice to say the due date has passed, so that the buyer is not told the payment is due later.
#### Acceptance Criteria
1. THE `BlockReason` union SHALL gain `overdue_tense`.
2. WHEN the invoice is Overdue and the text matches a Future_Tense_Pattern, THE Tense_Check SHALL block it with `overdue_tense` and the matched phrase as offending.
3. WHEN the invoice is not Overdue, THE Tense_Check SHALL accept the text.
4. THE Tense_Check SHALL accept past forms such as `{{due_date}} ko due tha`, `due ho chuka hai` and `was due on {{due_date}}`, and SHALL accept a present-tense amount such as `{{principal}} abhi bhi due hai`, because every Future_Tense_Pattern is anchored on `{{due_date}}`.
5. THE draft prompt (`packages/agent/src/prompts/draft-step.ts`) SHALL, when the invoice is Overdue, tell the model the due date has passed and to write of it in the past tense, giving one Hinglish and one English example; WHEN the invoice is not Overdue, the prompt SHALL not carry that line.
6. THE Overdue value SHALL come from the Engine `dueDate` and Today; the Tense_Check SHALL compute no date itself.
### Requirement 3: Draft_Guard in the repair path
**User Story:** As a supplier, I want a draft that breaks a tone or tense rule to be repaired or blocked like a citation error, so that nothing off-tone reaches my approval queue.
#### Acceptance Criteria
1. THE Draft_Guard SHALL run Citation_Check first; WHEN Citation_Check blocks, THE Draft_Guard SHALL return that block without running Tone_Check or Tense_Check.
2. WHEN Citation_Check accepts, THE Draft_Guard SHALL run Tone_Check, then Tense_Check, and return the first block, or the Citation_Check acceptance with its `ruleIds` unchanged.
3. THE `draftStep` function SHALL call the Draft_Guard everywhere it calls `validateCitations` today, for the initial output and for the repaired output.
4. WHEN the Draft_Guard blocks the initial output, THE `draftStep` function SHALL make the existing single Repair_Call with the new reason and offending value in the repair note, in the same way as a citation block.
5. WHEN the Draft_Guard blocks the repaired output, THE Draft_Attempt SHALL fail with the existing `citation_blocked` error kind.
6. THE `draft_step` Tool_Log row SHALL record the Draft_Guard result in its existing `citation` field.
7. THE Draft_Guard SHALL not change the accepted Draft's body text, Final_Text, rule IDs or document.
### Requirement 4: Draft eval fixtures and runner
**User Story:** As the builder, I want labelled recorded outputs that run offline, so that I see at once when a guard change lets a bad draft through or blocks a good one.
#### Acceptance Criteria
1. THE `evals/draft-step/` folder SHALL hold between 15 and 20 Eval_Fixtures, each with a unique name.
2. THE fixtures SHALL include:
   - at least 3 `accept` fixtures, with at least one Hinglish and one English;
   - for each of `missing_address`, `threat_phrase`, `begging_phrase` and `overdue_tense`, at least one Hinglish and one English fixture;
   - at least one `accept` near-miss for the Tone_Check (polite text using "please" or a factual mention of interest), one for the Tense_Check (a past-tense due date on an Overdue invoice), one for `{{principal}} abhi bhi due hai` on an Overdue invoice, and one English `legal_notice` that states the Facilitation Council remedy as information; near-miss fixtures count toward the `accept` fixtures;
   - the Hinglish tense pair from the roadmap: `17 Oct 2026 ko due hai` expecting `literal_figure` (Citation_Check runs first), and `{{due_date}} ko due hai` on an Overdue invoice expecting `overdue_tense`;
   - at least one fixture each for `missing_citation`, `invalid_rule_id` and `uncited_placeholder`.
3. THE Draft_Context of each fixture SHALL use the Demo_Seed invoice for Sharma Traders at Today = 2026-11-12 (Overdue, 26 days late) unless the fixture tests a not-Overdue case; a test SHALL check that each such fixture's allowed rule IDs equal `allowedRuleIds` for that invoice and Today.
4. THE Eval_Runner SHALL run the Draft_Guard on every fixture, print one line per fixture with its name, expected and actual result, and a final line `<passed>/<total> passed`.
5. WHEN any fixture's actual result differs from its Expected_Result, or a fixture file fails schema validation, THE Eval_Runner SHALL exit with a non-zero code.
6. THE `packages/agent` Vitest suite SHALL run the same fixtures through the same loader, so `pnpm --filter @dues-banshee/agent test` fails on any mismatch.
7. THE Eval_Runner and the eval tests SHALL make no network call and no LLM call.
### Requirement 5: Call-hours eval cases
**User Story:** As a supplier, I want the call-hours rule pinned by labelled cases, so that a change cannot start calls to my buyers at night or on Sunday.
#### Acceptance Criteria
1. THE existing `apps/web/test/start-call-refusal.property.test.ts` SHALL be extended with a table of Call_Hours_Cases run through `inCallWindow` and `startCallRefusal`, with no new hours logic.
2. THE cases SHALL include, for a non-demo supplier: Monday 09:59 IST `outside_window`; Monday 10:00 IST allowed; Saturday 18:59 IST allowed; Saturday 19:00 IST `outside_window`; Sunday 12:00 IST `outside_window`.
3. THE cases SHALL include a Demo_Supplier at Sunday 22:00 IST that is allowed below the Demo_Call_Limit and refused with `demo_limit` at it.
4. THE WhatsApp send path SHALL stay without an hours rule.
### Requirement 6: Kiro hook
**User Story:** As the builder, I want the evals to re-run when I save a prompt, so that a prompt edit that breaks a rule shows up at once.
#### Acceptance Criteria
1. THE `.kiro/hooks/` folder SHALL gain a hook in the same shape as the entries in `engine-tests-on-save.json`: `PostFileSave` trigger, `command` action, enabled.
2. THE hook matcher SHALL be `packages/agent/src/prompts/.*\.ts$|packages/voice/src/persona\.ts$`.
3. THE hook command SHALL run `pnpm --filter @dues-banshee/agent eval` and the `packages/voice` persona tests, and SHALL make no network or LLM call.
4. THE existing hooks SHALL stay unchanged.
### Requirement 7: Extended existing tests and source lint
**User Story:** As the builder, I want the existing guard tests extended rather than replaced, so that earlier guarantees stay covered.
#### Acceptance Criteria
1. THE files `packages/agent/test/citations.test.ts`, `prompt.test.ts`, `source-lint.test.ts` and `apps/web/test/start-call-refusal.property.test.ts` SHALL be extended; no existing test in them SHALL be removed or weakened.
2. THE `prompt.test.ts` file SHALL cover the Overdue tense line of Requirement 2 criterion 5, present and absent.
3. THE `citations.test.ts` file SHALL show that `validateCitations` results are unchanged for its existing cases.
4. THE source lint SHALL flag, in `packages/agent/src` and `apps/web` (tests and build output skipped), any array or `Set` literal naming two or more distinct Ladder_Step strings, so no copy of the Engine's approval-step set exists outside the Engine.
5. THE source lint SHALL flag any `indexOf` or `findIndex` call on `LADDER_STEPS` or on an array of Ladder_Step strings, so no step ranking exists outside the Engine `stepRank`.
6. THE source lint SHALL flag any import of `@dues-banshee/voice` in `packages/agent/src`.
7. EACH new lint rule SHALL have a detector test that flags a positive sample and passes a near-miss sample, in the style of the existing `source lint detectors` block.
8. THE current source SHALL pass every new lint rule.
