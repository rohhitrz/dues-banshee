# Implementation Plan: buyer-voice-call

## Overview

TypeScript throughout (design language). Risk first: tasks 1–6 build the narrowest path to a real Hinglish call (mint → WebRTC Call_Client → tool round-trip → promise on the timeline → ladder paused) and end with the manual live check. Tasks 7–9 widen and harden it. Every test sub-task is required (Req 11 C13); none is optional.

Commit rule (git-workflow steering): each parent task ends with one Conventional Commit once its tests, typecheck and lint pass for the touched packages, e.g. `feat(voice): …`, `Spec: buyer-voice-call, task N`.

## Tasks

- [x] 1. Voice package foundation and OpenAI key mint
  - [x] 1.1 Add Engine exports and voice model IDs
    - `packages/engine`: `isoWeekday` in `calendar-date.ts`; `index.ts` exports `addDays`, `financialYearEnd`, `isoWeekday`. No rule change.
    - `packages/agent/src/models.ts`: `VOICE_MODEL_IDS`, `realtimeModel(envValue)` (exact `gpt-realtime-2.1` → demo model, anything else → mini).
    - _Requirements: 3.7, 6.9_
  - [x] 1.2 Scaffold `packages/voice` and implement the OpenAI_Realtime provider
    - package.json / tsconfig / vitest config copied from `packages/agent`, including the fetch-guard setup so any unmocked request fails.
    - `provider.ts` (`VoiceProvider`, `VoiceSessionSpec`, `MintResult`), `openai-realtime.ts` (`createOpenAiRealtime`, `sessionConfigBody`): one POST to `client_secrets`, `expires_after` 60 s, 10 s timeout, Zod-parsed response, never throws, key only in `Authorization`; `index.ts` exports.
    - _Requirements: 3.1, 3.5, 3.6, 3.9, 11.1_
     - Notes: No new npm packages. Reuse the exact versions of zod, vitest, fast-check and typescript already in the lockfile; never edit minimumReleaseAgeExclude in pnpm-workspace.yaml. Run pnpm install and commit the lockfile change in this task.
  - [x] 1.3 Write tests for exports, models and the provider
    - `packages/engine/test/{exports,calendar-date}.test.ts` (`isoWeekday`); `packages/agent/test/models.test.ts`: `gpt-realtime-2.1` → `gpt-realtime-2.1`; unset and `gpt-4o-realtime` → `gpt-realtime-2.1-mini`.
    - `packages/voice/test/openai-realtime.test.ts` with `fakeHttp` / `fakeClock`: exact request body (Session_Config, `expires_after` 60, `marin`, `semantic_vad`, `gpt-live-transcribe`, `tool_choice`), non-2xx / network / timeout / bad body → typed failure, key absent from every result.
    - _Requirements: 3.1, 3.5, 3.7, 11.1, 11.7, 11.11_

- [x] 2. Pure call helpers: dates, persona, tool schemas, invoice facts
  - [x] 2.1 Implement `dates.ts`
    - `promiseWindow`, `inPromiseWindow`, `agentDate`, `buildDateList`, `inCallWindow`, `istDayBounds` on Engine date exports.
    - _Requirements: 1.5, 1.6, 5.11, 6.9_
    - Notes: First add `"./models": "./src/models.ts"` to the exports of packages/agent/package.json and change packages/voice/src/openai-realtime.ts to import VOICE_MODEL_IDS from "@dues-banshee/agent/models". All later voice code imports model IDs from there, never from the agent index.

  - [x] 2.2 Write property test for the Promise_Window check
    - **Property 1: Promise_Window check** (`packages/voice/test/promise-window.property.test.ts`, ≥ 100 runs, March always generated)
    - **Validates: Requirements 5.11, 11.4**
  - [x] 2.3 Write property test for the Date_List
    - **Property 2: Date_List** (`date-list.property.test.ts`)
    - **Validates: Requirements 6.9, 6.10, 11.9**
  - [x] 2.4 Write property test for the Call_Window
    - **Property 3: Call_Window** (`call-window.property.test.ts`, `Intl.DateTimeFormat` Asia/Kolkata oracle)
    - **Validates: Requirements 1.5**
  - [x] 2.5 Implement `persona.ts`, `tool-schemas.ts`, `invoice-facts.ts`
    - `PERSONA_RULES` from the buyer section of `voice-persona.md` and Req 6; `buyerAddress`; `buildPersonaInstructions` with the escaped BEGIN/END CALL DATA block (`today`, `date_list`).
    - Zod schemas, `CALL_TOOLS` via `z.toJSONSchema`, `parseToolArgs` (never throws); `buildInvoiceFacts` (Engine `dueDate`, `statutoryInterest`, `taxBomb`, `formatINR(…, "full")`), `checkPromiseAmount`.
    - _Requirements: 5.5, 5.7, 5.8, 5.10, 6.1–6.10_
  - [x] 2.6 Write property tests for persona, tool args and promise amount
    - **Property 5: Promise amount check** (`promise-amount.property.test.ts`) — **Validates: Requirements 5.9, 5.10**
    - **Property 6: Data block round trip** (`persona.property.test.ts`) — **Validates: Requirements 6.8, 6.9**
    - **Property 9: Tool argument parsing never throws** (`tool-args.property.test.ts`) — **Validates: Requirements 5.5**
  - [x] 2.7 Write unit tests for persona contents and Invoice_Facts
    - `persona.test.ts`: at `2026-11-12` `today` = "Thursday, 12 Nov 2026", 31 entries, first "Thursday, 12 Nov 2026", last "Saturday, 12 Dec 2026", contains "Friday, 20 Nov 2026"; rules include AI identity + "yeh call record aur transcribe ho rahi hai", "haan" read-back, Date_List lookup, `end_call` rules, data-only block.
    - `invoice-facts.test.ts`: exact `toEqual` for Sharma Traders `LPC/26-27/0412` at `2026-11-12` with literal values (41200000, 17 Oct 2026, 26 days, 512794, 41712794, 31 Mar 2027, 139 days, `MSMED-15`/`MSMED-16`/`IT-43BH`); `bank_rate_missing` shape.
    - _Requirements: 5.7, 5.8, 6.1–6.10, 11.2, 11.9, 11.11_

- [x] 3. Database: voice tables, promise columns, history filter
  - [x] 3.1 Add schema and migration `0005_buyer_voice_call`
    - Enums, `voice_calls`, `voice_transcript_lines`, `voice_tool_calls`, new `promises` columns, checks and indexes as in Data Models; hand-edited `superseded_on` backfill before `promises_one_current_per_invoice`; `RESET_TABLES` gains the three tables.
    - _Requirements: 2.6, 5.15, 8.2_
    - Notes: Generate the migration file only. Never run db:migrate against Neon; local dev and Vercel share the Neon production branch. Rohit applies 0005 himself before task 6.5. Tests use PGlite only.
  - [x] 3.2 Implement `packages/db/src/voice.ts`
    - All listed functions, including `claimJoin` (conditional UPDATE), `lockLiveCall` (`FOR UPDATE`), `claimToolCall` (`ON CONFLICT DO NOTHING RETURNING`), `recordVoicePromise` (invoice `FOR UPDATE`, supersede, insert), single-statement `endVoiceCall`, `endStaleCalls`; every time from an injected `now`.
    - _Requirements: 1.4, 2.4, 2.5, 5.6, 5.9, 5.12, 7.1, 7.3, 8.1_
  - [x] 3.3 Add the Engine_History filter
    - `promise-filter.ts` `countedPromise(today)` in `listLadderRecords` and `readRecords`; required `today` on `ladder.ts` / `graveyard.ts`; update `runLadder`, `decide.ts`, `send-check.ts`, `lib/graveyard/load.ts`, `lib/debtor/load.ts`.
    - _Requirements: 9.1, 9.2_
  - [x] 3.4 Write DB tests (PGlite)
    - `voice-migration.test.ts`: existing rows kept, backfill leaves one Current_Promise per invoice, defaults `manual`/false; reset clears new tables.
    - `promise-filter.test.ts`: recorded `2026-11-13` absent at `2026-11-12`; recorded `2026-11-12`, superseded `2026-11-14` present at `2026-11-13`, absent at `2026-11-14`.
    - `packages/agent/test/run-ladder-voice-promise.test.ts`: voice promise `2026-11-12` → `2026-11-20`; run at `2026-11-12` records `promise_active` and no Draft; run at `2026-11-20` records the Engine `nextEscalationStep` Decision, no `promise_active`.
    - _Requirements: 5.15, 9.1, 9.2, 11.5_

- [x] 4. Join: Session_Endpoint, Call_Page and the WebRTC Call_Client
  - [x] 4.1 Implement `token.ts` and `handleSession`
    - 32-byte base64url token, SHA-256 hex hash; `handleSession(db, provider, now)`: no key → 503 with row unchanged; `claimJoin` → `getCallContext` → `buildPersonaInstructions` → `mintKey`; failure → `endVoiceCall` `incomplete`, 502; success body `{ ephemeralKey, expiresAt, voiceCallId, connectUrl, capEndsAt }`.
    - _Requirements: 2.4, 2.5, 2.6, 3.1, 3.3, 3.5, 10.2_
  - [x] 4.2 Add the session route and the Call_Page
    - `app/api/voice/session/route.ts` (nodejs, non-strict Zod body, `Cache-Control: no-store`, fixed error bodies, token only in the body); `app/(call)/layout.tsx`, `call/[token]/page.tsx` (`force-dynamic`, `robots` noindex, one expired markup for every invalid case, no invoice data); `next.config` `Referrer-Policy: no-referrer` for `/call/:path*`.
    - _Requirements: 2.1, 2.2, 2.3, 3.2, 10.3, 10.4_
  - [x] 4.3 Implement `call-session.ts` connect, countdown and end, plus `call-client.tsx`
    - Injected deps; tap handler calls `getUserMedia` (echoCancellation/noiseSuppression/autoGainControl) and `audio.play()` synchronously before any await; mic failure → alert, no request, button stays enabled; session POST; `RTCPeerConnection` + mic track + `oai-events` channel, SDP POST to `connectUrl`; on open send one bare `response.create`; `m:ss` countdown to `capEndsAt`; one guarded end (hang-up, 0:00, `failed`, unexpected close) with `keepalive` End_Report; never `session.update`. `<audio autoPlay playsInline>`, 44 × 44 px targets.
    - _Requirements: 3.4, 3.9, 4.1–4.5, 7.4_
    - Notes: call-client.tsx and apps/web/lib/call/* run in the browser: they must not import @dues-banshee/voice, @dues-banshee/db, @dues-banshee/agent or any server-only module. Only types may be imported (import type).
  - [x] 4.4 Write session and Call_Page tests
    - `packages/voice/test/session.test.ts`: two concurrent joins mint one key and set `live` once; used / expired / unknown token → 404, no mint; mint failure → `ended`/`incomplete`; no key → 503, row unchanged; key value absent from every response.
    - `apps/web/test/call-page.test.tsx`: valid token shows supplier name, Call_Copy, Disclaimer, AI/recording line, one "Join call"; used, expired and unknown tokens render identical expired markup with no supplier or buyer data; no invoice figures.
    - `apps/web/test/call-session.test.ts` (connect part): mic denial → no join request, Voice_Call stays `created`; `getUserMedia` and `play()` called before the first await; SDP posted with Bearer ephemeral key; no `session.update`; hang-up and countdown end send one End_Report.
    - _Requirements: 2.1–2.5, 3.2–3.5, 4.1–4.5, 10.2, 11.7_

- [x] 5. Tool round-trip, transcript and call end
  - [x] 5.1 Implement `runCallTool`, `handleTranscript`, `handleEnd`
    - One transaction per tool request in the order of Req 5 C3: `lockLiveCall` (404, no log) → Call_Cap (`call_time_up`, end with the 60 s stale rule) → `claimToolCall` (repeat → stored result) → `parseToolArgs` → `get_invoice_facts` / `record_promise_to_pay` (bank rate → amount → window → `recordVoicePromise`) / `end_call` (`setRequestedOutcome`) → `storeToolResult` + `logToolCall`. Transcript: stale-end first, skip empty, cut to 2,000 chars, dedupe by item id. End: `live` → `endVoiceCall`, else no change; client outcome ignored. Handlers return `revalidateBuyerId`.
    - _Requirements: 5.2–5.14, 7.1, 7.2, 7.3, 7.5, 7.6, 8.1, 8.3, 8.4_
    - Notes: In runCallTool, if the raw arguments string is empty or only whitespace, treat it as "{}" before parseToolArgs (no-argument tools like get_invoice_facts). Do not change parseToolArgs.
  - [x] 5.2 Add tool, transcript and end routes; wire the client tool loop
    - `app/api/voice/{tool,transcript,end}/route.ts` (nodejs, no-store, fixed errors, `revalidatePath` when a buyer id is returned); `lib/call/realtime-events.ts` `routeRealtimeEvent`; `call-session.ts` forwards function calls, sends `function_call_output` + `response.create`, posts transcripts, arms the `end_call` end (next `response.done` or 10 s), ends on 404 / `call_time_up` / `error`.
    - _Requirements: 5.1, 5.13, 7.4, 8.1, 9.6, 10.4_
  - [x] 5.3 Write tool, end and transcript tests
    - `packages/voice/test/tools.test.ts` (Demo_Seed, `call_today` `2026-11-12`): 41712794 for `2026-11-20` accepted, not partial, "Friday, 20 Nov 2026"; 20000000 partial; 0, −1, 41712795 → `amount_out_of_range`; `2026-11-11`, `2026-12-13`, `2026-02-30` → `date_out_of_range`; `2026-11-12`, `2026-12-12` accepted; two promises → first superseded, one Current_Promise; repeated `call_id` → stored result, one row; wrong token / non-`live` → 404, no Tool_Log; body invoice id ignored; request at `started_at` + 300 s → `call_time_up` and call ended; one Tool_Log per request past the 404 check; `bank_rate_missing`.
    - `end-and-transcript.test.ts`: each Call_Outcome rule (promise beats requested outcome, requested outcome, `incomplete`); duration capped at 300; client outcome ignored; repeat End_Report no change; mismatched End_Report / transcript → 404; transcript dedupe, 2,000-char cut, empty skipped; stale end at `started_at` + 300 s.
    - `apps/web/test/call-session.test.ts` (tool loop): output item then `response.create`; `end_call` ends on `response.done` or after 10 s; `error` and `call_time_up` end the call.
    - _Requirements: 5.1–5.14, 7.1–7.6, 8.1, 8.3, 8.4, 11.3, 11.6, 11.11_

- [x] 6. Start call from the Debtor_Page, then the live check
  - [x] 6.1 Implement `callable.ts` and the `startCall` action
    - `isCallableInvoice`, `isDemoSupplier` (Udyam number), pure `startCallRefusal` in the order of Req 1 C13; `call-actions.ts` via `withSupplier` / `STALE_URL`: reads only `invoiceId` and `today`, `createVoiceCall` (expires the buyer's older `created` rows), `callUrl` from the request origin, `waMeUrl` through the WaMe_Link channel, `start_voice_call` Tool_Log without the token, refusals with `role: "alert"`.
    - _Requirements: 1.4–1.8, 1.10–1.15_
  - [x] 6.2 Add `StartCallControls` and config
    - Replace `PlaceholderActions` (delete the file); enabled / disabled states with `aria-describedby`; Call_Copy, Disclaimer, Demo_Hours_Text only for the Demo_Supplier; after a start show the URL, "Open call here" (`target="_blank" rel="noopener noreferrer"`), "Send call link in WhatsApp", "Link works once, for 10 minutes". `apps/web/.env.example` gains `VOICE_REALTIME_MODEL=`.
    - _Requirements: 1.1, 1.2, 1.3, 1.9, 1.15, 1.16, 10.1_
  - [x] 6.3 Write start-call tests
    - **Property 4: Start-call refusal order** (`apps/web/test/start-call-refusal.property.test.ts`) — **Validates: Requirements 1.5, 1.6, 1.12, 1.13, 1.14, 1.15**
    - `call-actions.test.ts` (injected instant): non-demo 09:59 and 19:00 IST Thu `2026-11-12` and 12:00 IST Sun `2026-11-15` refused; 10:00 and 18:59 accepted, second same-day call refused; demo 20:00 Thu and 12:00 Sun accepted, second same-day call accepted, 21st call refused with "Demo call limit reached for today"; URL starts with the request origin; foreign / bad invoice not found; no session / Stale_Session redirects; Tool_Log has no token.
    - `start-call-controls.test.tsx`: enabled, not callable, not configured states; Demo_Hours_Text shown for demo and absent otherwise.
    - _Requirements: 1.1–1.16, 11.7, 11.8_
  - [x] 6.4 Checkpoint: ensure all tests pass
    - Ensure all tests pass in `packages/{engine,db,agent,voice}` and `apps/web`, ask the user if questions arise.
  - [x] 6.5 Write `docs/voice-live-check.md` and have the owner run it (manual, not a test task)
    - Steps: set `OPENAI_API_KEY` locally, sign in as the demo supplier, open Sharma Traders at `?today=2026-11-12`, Start call → "Open call here" → Join call on the same laptop, speak Hinglish, promise a date such as "agle Friday".
    - Confirm: disclosure line first; `get_invoice_facts` figures; read-back of amount (digits + words) and weekday + date from the Date_List; "haan" before `record_promise_to_pay`; the promise on the Candle_Timeline after reload; the next Ladder_Run pauses; Transcript_Lines stored.
    - Record: Realtime_Model used, transcription language left unset (open item 2), observed Hinglish quality, date of the run. The owner runs it and fills in the result.
    - _Requirements: 11.12_
    - Notes: The doc's first step is: Rohit runs `set -a; source apps/web/.env.local; set +a` then `pnpm --filter ./packages/db db:migrate` from the repo root. Do not push.

- [ ] 7. Debtor_Page polish
  - [ ] 7.1 Add call entries, voice promise text and the call details
    - `EntryKind` `call`, `KIND_RANK`, `CALL_OUTCOME_TEXT satisfies Record<CallOutcome, string>`, `m:ss`, calls after Today excluded; promise text "(by voice)", "(by voice, partial)", " (replaced)" over Visible_Promises; `listBuyerVoiceCalls` (stale-end first, scoped via `invoices.supplier_id`) in `lib/debtor/load.ts`; closed `<details>` with escaped transcript lines and tool calls. Graveyard wisp unchanged (open item 1).
    - _Requirements: 7.3, 8.4, 9.3, 9.4, 9.5, 9.7_
  - [ ] 7.2 Add "Promise due today" and confirm revalidation
    - `build-debtor-view.ts`: "Promise to pay active until <D MMM YYYY>" only when `activePromiseUntil > today`, "Promise due today" when equal; update `apps/web/test/debtor-view.test.ts` for the new rule; confirm the tool and end routes revalidate `/` and `/debtors/<Buyer_Id>`.
    - _Requirements: 9.6, 9.8, 9.9_
  - [ ] 7.3 Write property tests for the timeline and the promise text
    - **Property 7: Timeline promise and call entries** (`apps/web/test/candle-timeline.property.test.ts`) — **Validates: Requirements 9.3, 9.4**
    - **Property 8: Promise text on the Invoice_Panel** (`apps/web/test/debtor-view.property.test.ts`) — **Validates: Requirements 9.8, 9.9**
  - [ ] 7.4 Write Debtor_Page tests
    - `debtor-page.test.tsx`: after a voice promise `2026-11-12` → `2026-11-20`, "Promise to pay active until 20 Nov 2026" and "Promised <formatINR(41712794)> by 20 Nov 2026 (by voice)"; at Today `2026-11-20` "Promise due today" and not the active text; each `call` entry text; details closed by default; transcript text escaped; another supplier's calls absent.
    - _Requirements: 8.4, 9.3–9.9, 11.5, 11.11_

- [ ] 8. Voice lint and proxy test
  - [ ] 8.1 Write `apps/web/test/voice-lint.test.ts`
    - Scan non-test `.ts/.tsx/.js/.mjs` under `apps/` and `packages/` (excluding `models.ts`, tests, Markdown, build output) for Realtime_Model / Transcribe_Model IDs and Banned_Model_IDs; no `package.json` lists `@openai/agents`; `OPENAI_API_KEY` read only in server files.
    - _Requirements: 3.3, 3.6, 3.8, 3.9, 10.1, 11.11_
  - [ ] 8.2 Write `apps/web/test/proxy.test.ts`
    - Signed out: `/` and `/debtors/<id>` redirect to `/signin`; `/call/<token>` and `/api/voice/{session,tool,transcript,end}` not redirected; matcher unchanged.
    - _Requirements: 10.3, 11.10_

- [ ] 9. Final checkpoint: ensure all tests pass
  - Run test, typecheck and lint in `packages/engine`, `packages/db`, `packages/agent`, `packages/voice` and `apps/web` with zero failures and zero errors; ask the user if questions arise.
  - _Requirements: 11.13_

## Notes

- No task is optional. Property tests use fast-check with `numRuns >= 100` and the tag `// Feature: buyer-voice-call, Property N: <title>`.
- Tasks 1–6 are the demo path; after 6.5 the call works locally end to end. Kill rule (roadmap): reliable live by 24 Nov, else one-laptop demo.
- Shared files across waves: `call-session.ts` (4.3, 5.2), `apps/web/test/call-session.test.ts` (4.4, 5.3), `lib/debtor/load.ts` (3.3, 7.1), `packages/voice/src/index.ts` (1.2, 2.1, 2.5, 4.1). The waves below keep these apart.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3", "2.1", "3.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "2.4", "2.5", "3.2"] },
    { "id": 4, "tasks": ["2.6", "2.7", "3.3"] },
    { "id": 5, "tasks": ["3.4", "4.1"] },
    { "id": 6, "tasks": ["4.2", "4.3"] },
    { "id": 7, "tasks": ["4.4", "5.1"] },
    { "id": 8, "tasks": ["5.2", "6.1"] },
    { "id": 9, "tasks": ["5.3", "6.2"] },
    { "id": 10, "tasks": ["6.3"] },
    { "id": 11, "tasks": ["6.4"] },
    { "id": 12, "tasks": ["6.5"] },
    { "id": 13, "tasks": ["7.1", "8.1", "8.2"] },
    { "id": 14, "tasks": ["7.2"] },
    { "id": 15, "tasks": ["7.3", "7.4"] },
    { "id": 16, "tasks": ["9"] }
  ]
}
```
