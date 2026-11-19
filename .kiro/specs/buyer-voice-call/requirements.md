# Requirements Document

## Introduction

buyer-voice-call lets the owner start one AI voice call with a buyer about one overdue invoice. The buyer joins from a link in the browser and talks to the banshee persona in Hinglish over the OpenAI Realtime API (WebRTC). The goal of the call is a promise to pay, which lands on the Candle_Timeline and pauses the ladder through the existing Engine promise logic. It is the fourth link of the demo spine: … WhatsApp nudge → **buyer voice call in Hinglish → `promise_to_pay` appears on the timeline** → test payment → the tombstone resurrects.

Scope is the happy path only (roadmap section 5, shrunk 19 Nov). The spec adds no legal or money maths outside `packages/engine`. Every number the agent speaks comes from tool output built from Engine results and formatted with the Engine `formatINR`. The owner's click on "Start call" is the owner confirmation that the global rules require for a call. Starting a call needs no `voice_call` Draft and writes no Approved_Step_Event; the ladder is unchanged apart from the promise pause.

The calls happen over the internet, not the phone network. No raw audio is stored.

Context, not a requirement: the kill rule in `roadmap.md` (reliable on the live site by 24 Nov, else a one-laptop demo; still flaky on 26 Nov, then left out of the video).

Tests are mandatory in this spec. No test task may be marked optional. The manual live check (Requirement 11 criterion 12) is a manual step outside the test suite, and it is not a test task.

Size constraint: design.md stays lean and tasks.md plans at most 10 parent tasks. Target cost: about 250 credits or less.

Non-goals: PSTN calls; a server sideband connection to the Realtime session; `@openai/agents`; owner review of promises; a do-not-call list; a dispute tool that records dispute details; raw audio storage; GPT-Live; owner-facing voice commands; Sarvam (only the interface seam is built); changes to the Engine ladder rules.

## Glossary

- **Engine**, **Decision**, **Engine_History**, **Escalation_Event**, **Approved_Step_Event**, **Tool_Log**, **Disclaimer**, **Session_Supplier**, **Stale_Session**, **Demo_Seed**, **Ladder_Runner**, **Ladder_Run**, **Approval_Queue**: as defined in `.kiro/specs/escalation-ladder/requirements.md`.
- **Debtor_Page**, **Invoice_Panel**, **Today**, **Candle_Timeline**, **Timeline_Entry**, **Entry_Kind**, **Buyer_Id**, **Own_Buyer**, **Placeholder_Buttons**, **Active_Promise_Helper**, **Promise_Until_Helper**, **Promise_Until_Date**: as defined in `.kiro/specs/debtor-ui/requirements.md`.
- **Debtor_Invoice**: as defined in `.kiro/specs/debtor-ui/requirements.md`.
- **WaMe_Link**, **Message_Channel**, **Send_Check**: as defined in `.kiro/specs/whatsapp-channel/requirements.md`.
- **Demo_Override**, **Tombstone_State**, **Graveyard_Page**, **Days_Overdue**, **Bank_Rate**: as defined in `.kiro/specs/dashboard-ui/requirements.md`.
- **Voice_Call**: one row of the new `voice_calls` table, bound to one invoice of the Session_Supplier. It holds `id`, `invoice_id`, `buyer_id`, `call_today` (the Today in effect when the owner started the call), the SHA-256 hash of the Join_Token, `token_expires_at`, `status`, `started_at`, `ended_at`, `duration_seconds`, `outcome` and `created_at`. The existing unused `calls` table stays as it is.
- **Call_Status**: one of `created` (link made, nobody joined), `live` (buyer joined), `ended`, `expired` (link never used before `token_expires_at`, or replaced by a newer link).
- **Call_Outcome**: one of `promise`, `dispute`, `no_promise`, `incomplete`, `consent_declined`.
- **Join_Token**: a random value of at least 128 bits made when the owner starts a call, valid for 10 minutes from creation, accepted for exactly one join, and stored only as a hash. The buyer's link carries it.
- **Call_Page**: the page `/call/[token]` in `apps/web`, open without sign-in, where the buyer taps "Join call".
- **Session_Endpoint**: the `apps/web` route that accepts a join for a Join_Token, atomically sets the Voice_Call `live` and returns the Ephemeral_Key.
- **End_Report**: the Call_Client's request telling the server the call ended, carrying the `voiceCallId` and the Join_Token.
- **Call_Page_URL**: `<origin>/call/<Join_Token>`, where `<origin>` is the origin (scheme, host and port) of the owner's start-call request.
- **Demo_Supplier**: the Demo_Seed supplier, `DEMO_SUPPLIER` in `packages/db/src/seed.ts` (name "Laxmi Precision Components (Demo)", Udyam number `UDYAM-MH-00-0000000`), identified by its Udyam number.
- **Demo_Call_Limit**: 20 Voice_Calls of the Demo_Supplier, counted over all its invoices, whose `started_at` falls on the Call_Day.
- **Demo_Hours_Text**: the text "Demo account: call hours not enforced. Real accounts: 10:00–19:00 IST, Monday to Saturday."
- **Call_Window**: 10:00 to 19:00 Asia/Kolkata time (10:00 inclusive, 19:00 exclusive), Monday to Saturday, read from the current instant (the real clock, not the Demo_Override).
- **Call_Day**: the Asia/Kolkata calendar date of the current instant when a call is started.
- **Call_Cap**: 5 minutes (300 seconds) from the Voice_Call `started_at`.
- **Callable_Invoice**: a Debtor_Invoice that is unpaid on Today, has an Engine due date, is after that due date on Today, and whose Tombstone_State is not `not_covered`.
- **Voice_Provider**: the TypeScript interface in `packages/voice` that every voice backend implements: it builds the session config, mints the Ephemeral_Key and names the connect URL. This spec has exactly one implementation, OpenAI_Realtime.
- **OpenAI_Realtime**: the Voice_Provider implementation for the OpenAI Realtime API.
- **Ephemeral_Key**: the short-lived client secret returned by `POST https://api.openai.com/v1/realtime/client_secrets` with `expires_after` of 60 seconds.
- **Session_Config**: the full Realtime session configuration sent only from the server when minting the Ephemeral_Key: the Realtime_Model, the Persona_Instructions, the Call_Tools, voice `marin`, input audio transcription with the Transcribe_Model, and turn detection `semantic_vad`.
- **Realtime_Model**: `gpt-realtime-2.1-mini` by default, or `gpt-realtime-2.1` when the env var `VOICE_REALTIME_MODEL` equals `gpt-realtime-2.1` exactly.
- **Transcribe_Model**: `gpt-live-transcribe`.
- **Banned_Model_IDs**: `gpt-4o-transcribe`, `whisper-1`, `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`.
- **Call_Client**: the browser code on the Call_Page that opens an `RTCPeerConnection`, adds the microphone track, opens the `oai-events` data channel and posts the SDP offer to the connect URL with the Ephemeral_Key.
- **Call_Tools**: the three server-run functions offered to the model: `get_invoice_facts`, `record_promise_to_pay` and `end_call`.
- **Tool_Endpoint**: the `apps/web` route that runs a Call_Tool for the Call_Client. A request carries the `voiceCallId`, the Join_Token, the Realtime `call_id`, the tool name and the raw arguments.
- **Invoice_Facts**: the `get_invoice_facts` result: buyer name, supplier name, invoice number, principal, interest to `call_today`, Days_Overdue, Total_Due (each amount as a `formatINR` string), the Engine due date, the tax-bomb date and days left, the Engine caveat if any, and the rule IDs `MSMED-15`, `MSMED-16` and `IT-43BH` where the Engine results cite them.
- **Total_Due**: the invoice principal plus the Engine `statutoryInterest` `interestPaise` for `call_today`, in integer paise.
- **Promise_Window**: the dates from `call_today` to the earlier of `call_today` + 30 days and `financialYearEnd(call_today)`, both ends inclusive.
- **Partial_Promise**: a promise whose amount is less than Total_Due.
- **Current_Promise**: a `promises` row of an invoice with `superseded_on` null.
- **Visible_Promise**: a `promises` row whose `recorded_on` is on or before Today.
- **Replaced_Promise**: a Visible_Promise whose `superseded_on` is on or before Today.
- **Agent_Date**: a date written as `<Weekday>, D MMM YYYY` with the English weekday name (for example "Friday, 20 Nov 2026").
- **Date_List**: the list of every Promise_Window date, in ascending order, each written as an Agent_Date, computed on the server with the `packages/engine` date functions.
- **Persona_Instructions**: the instructions text in `packages/voice`, built from the buyer-facing section of `.kiro/steering/voice-persona.md` and Requirement 6.
- **Transcript_Line**: one stored line of a Voice_Call: speaker (`buyer` or `agent`), text, Realtime item id and time, from the Realtime events `conversation.item.input_audio_transcription.completed` (buyer) and `response.output_audio_transcript.done` (agent).
- **Call_Copy**: the text "AI call over the internet. Phone (PSTN) calls are on the roadmap."

## Requirements

### Requirement 1: Start a call from the Debtor_Page

**User Story:** As a supplier, I want to start an AI call with my buyer from the buyer's page, so that I can ask for a payment date without making the call myself.

#### Acceptance Criteria

1. WHILE an Invoice_Panel shows a Callable_Invoice and `OPENAI_API_KEY` is set and not empty, THE Invoice_Panel SHALL show "Start call" as an enabled `<button>` in place of the disabled "Start call" Placeholder_Button, with the Call_Copy and the Disclaimer inside the same Invoice_Panel.
2. IF the Invoice_Panel's invoice is not a Callable_Invoice, THEN THE Invoice_Panel SHALL show "Start call" with the `disabled` attribute and the text "No call needed for this invoice", linked through `aria-describedby`.
3. IF `OPENAI_API_KEY` is unset or empty, THEN THE Invoice_Panel SHALL show "Start call" with the `disabled` attribute and the text "Voice calls not configured", linked through `aria-describedby`, and THE Debtor_Page SHALL render without HTTP 500.
4. WHEN the owner clicks "Start call" for a Callable_Invoice and no refusal of criterion 13 applies, THE start-call server action SHALL create one Voice_Call with status `created`, `call_today` = Today, a new Join_Token expiring 10 minutes later, and the invoice and Own_Buyer ids, and SHALL set every earlier `created` Voice_Call of that Own_Buyer, for any invoice, to `expired`.
5. IF the Session_Supplier is not the Demo_Supplier and the owner clicks "Start call" outside the Call_Window, THEN THE start-call server action SHALL create no Voice_Call and show "Calls are allowed 10:00–19:00 IST, Monday to Saturday" with `role="alert"`.
6. IF the Session_Supplier is not the Demo_Supplier and the Own_Buyer already has a Voice_Call whose `started_at` falls on the Call_Day in Asia/Kolkata time, THEN THE start-call server action SHALL create no Voice_Call and show "This buyer was already called today" with `role="alert"`.
7. THE start-call server action SHALL read only the invoice id and the optional Demo_Override `today` field from the request, take the supplier id only from `session.supplierId`, and resolve Today as the Debtor_Page does.
8. IF the start-call server action is reached with no session `supplierId` or with a Stale_Session, THEN THE action SHALL create no Voice_Call, SHALL NOT respond with HTTP 500, and SHALL redirect to `/signin` or `/signin?error=SessionExpired` respectively.
9. WHEN a Voice_Call is created, THE response to that click SHALL show in the Invoice_Panel the Call_Page_URL, an "Open call here" link to that URL, and a "Send call link in WhatsApp" control that opens a WaMe_Link URL whose text holds the Call_Page_URL, built through the existing Message_Channel WaMe_Link, with the note "Link works once, for 10 minutes". After a reload THE Invoice_Panel SHALL NOT show the Call_Page_URL, because the Join_Token is stored only as a hash.
10. THE start-call server action SHALL write one Tool_Log row with `tool` `start_voice_call`, the invoice id, the inputs and the result for every request that resolves to an invoice of the Session_Supplier, including refused requests, with no Join_Token value in the row.
11. IF the invoice id is not a uuid, matches no invoice, or belongs to another supplier, THEN THE start-call server action SHALL respond as not found and create no Voice_Call.
12. IF the invoice is not a Callable_Invoice on Today, or `OPENAI_API_KEY` is unset or empty, THEN THE start-call server action SHALL create no Voice_Call and show "No call needed for this invoice" or "Voice calls not configured" respectively, with `role="alert"`.
13. THE start-call server action SHALL apply its refusals in this order and give only the first that applies: not found (criterion 11), not configured (criterion 12), not callable (criterion 12), then, for a Session_Supplier other than the Demo_Supplier, outside the Call_Window (criterion 5) and buyer already called on the Call_Day (criterion 6), or, for the Demo_Supplier, the Demo_Call_Limit (criterion 14).
14. IF the Session_Supplier is the Demo_Supplier and the Demo_Call_Limit is already reached on the Call_Day, THEN THE start-call server action SHALL create no Voice_Call and show "Demo call limit reached for today" with `role="alert"`.
15. WHERE the Session_Supplier is the Demo_Supplier, THE start-call server action SHALL skip the Call_Window check (criterion 5) and the one-call-per-buyer check (criterion 6), and THE Invoice_Panel SHALL show the Demo_Hours_Text next to "Start call".
16. WHILE the Session_Supplier is not the Demo_Supplier, THE Invoice_Panel SHALL omit the Demo_Hours_Text.

### Requirement 2: Buyer join page and single-use token

**User Story:** As a buyer, I want to join the call by tapping a link, so that I don't need an app or an account.

#### Acceptance Criteria

1. WHEN the Call_Page is opened with a Join_Token that matches a Voice_Call with status `created` before its `token_expires_at`, THE Call_Page SHALL show the supplier name, the Call_Copy, the Disclaimer, the line "You will talk to an AI assistant. The call is recorded and transcribed.", and one "Join call" `<button>`.
2. IF the Join_Token matches no Voice_Call, or its Voice_Call is not `created`, or the current instant is at or after `token_expires_at`, THEN THE Call_Page SHALL show "This call link has expired or was already used" with no supplier-specific or buyer-specific data, and the rendered page content SHALL be identical for all these cases.
3. THE Call_Page SHALL show no invoice figure, buyer name or invoice number before the call starts, and SHALL require no sign-in.
4. WHEN the buyer taps "Join call" with a valid Join_Token, THE Session_Endpoint SHALL, in one atomic update that succeeds only while the Voice_Call is `created` and before `token_expires_at`, set the Voice_Call to `live` and set `started_at` to the current instant. IF that update does not succeed, THEN THE Session_Endpoint SHALL mint no Ephemeral_Key and THE Call_Page SHALL show the text of criterion 2.
5. WHEN two or more join requests with the same Join_Token arrive concurrently, THE Session_Endpoint SHALL mint at most one Ephemeral_Key and set `live` at most once.
6. THE Voice_Call SHALL store only the SHA-256 hash of the Join_Token, and THE `apps/web` app SHALL compare tokens by hash.

### Requirement 3: Ephemeral key and session config on the server

**User Story:** As a developer, I want the OpenAI key and every session setting kept on the server, so that a buyer's browser can't change the agent or steal the key.

#### Acceptance Criteria

1. WHEN the Session_Endpoint accepts a join, THE OpenAI_Realtime provider SHALL make one `POST /v1/realtime/client_secrets` call with `expires_after` of 60 seconds and the full Session_Config, and THE Session_Endpoint SHALL return only the Ephemeral_Key value, its expiry, the `voiceCallId`, the connect URL named by the Voice_Provider and the Call_Cap end instant (`started_at` + 300 seconds).
2. THE Session_Endpoint response SHALL carry `Cache-Control: no-store`.
3. THE `OPENAI_API_KEY` value SHALL appear in no HTTP response body, rendered HTML, client-side JavaScript, Tool_Log row, Transcript_Line or error message.
4. THE Call_Client SHALL send no instructions, tools, model, voice or turn-detection settings to OpenAI, and SHALL send no `session.update` event.
5. IF the `client_secrets` call returns a non-2xx status, fails at the network level, or gets no response within 10 seconds, THEN THE Session_Endpoint SHALL return no Ephemeral_Key and set the Voice_Call to `ended` with `ended_at` = the current instant and outcome `incomplete`, and THE Call_Page SHALL show "The call could not start. Please try again later." with `role="alert"`.
6. THE `packages/voice` package SHALL export the Voice_Provider interface, and THE `apps/web` server code SHALL reach the Realtime API only through it.
7. THE Realtime_Model, Transcribe_Model and voice name SHALL be defined only in `packages/agent/src/models.ts`; `VOICE_REALTIME_MODEL` SHALL select `gpt-realtime-2.1` only when it equals that value exactly, and any other value or no value SHALL select `gpt-realtime-2.1-mini`.
8. THE non-test `.ts`, `.tsx`, `.js` and `.mjs` files under `apps/` and `packages/`, excluding `models.ts`, SHALL contain no Realtime_Model or Transcribe_Model ID string and no Banned_Model_ID. Test files and Markdown files are outside this scan.
9. THE Call_Client SHALL use the browser `RTCPeerConnection` API directly with the `oai-events` data channel, posting the SDP offer to the connect URL from the Session_Endpoint response (`https://api.openai.com/v1/realtime/calls` for OpenAI_Realtime), and no `package.json` in the repository SHALL list `@openai/agents`.

### Requirement 4: Browser audio

**User Story:** As a buyer on a phone, I want the call to work after one tap, so that I can hear and speak without setup.

#### Acceptance Criteria

1. WHEN the buyer taps "Join call", THE Call_Client SHALL, synchronously in the tap handler and before awaiting any network request, call `getUserMedia` with `echoCancellation`, `noiseSuppression` and `autoGainControl` set to true and call `play()` on the remote audio element, and SHALL send the join request to the Session_Endpoint only after `getUserMedia` succeeds.
2. THE remote audio element SHALL carry the `playsinline` and `autoplay` attributes.
3. IF the buyer denies the microphone or `getUserMedia` fails, THEN THE Call_Client SHALL send no join request, show "Microphone access is needed for the call" with `role="alert"` and keep "Join call" enabled, and THE Voice_Call SHALL stay `created` so that the Join_Token can be retried until `token_expires_at`. A microphone failure during a `live` call follows Requirement 7 criterion 4.
4. WHILE a call is live, THE Call_Page SHALL show a countdown in `m:ss` to the Call_Cap end instant from the Session_Endpoint response, updated at least once per second, and a "Hang up" `<button>`, each with a target of at least 44 × 44 CSS px.
5. WHEN the buyer taps "Hang up", or the countdown reaches 0:00, THE Call_Client SHALL close the peer connection, stop the microphone track, send the End_Report, and show "The call has ended" in place of the countdown and the "Hang up" button.

### Requirement 5: Server-run Call_Tools

**User Story:** As a supplier, I want the agent's facts and promises handled by my server, so that a buyer can't change the invoice or record a bad promise.

#### Acceptance Criteria

1. WHEN the model emits a function call, THE Call_Client SHALL forward the name, arguments and `call_id` with the `voiceCallId` and Join_Token to the Tool_Endpoint, then send the returned JSON as a `function_call_output` item followed by `response.create`.
2. THE Tool_Endpoint SHALL take the invoice, supplier and `call_today` only from the Voice_Call row, and SHALL ignore any invoice id, supplier id, amount limit or date sent by the client outside the tool arguments.
3. THE Tool_Endpoint SHALL apply its checks in this order and stop at the first that applies: (a) Voice_Call match and `live` status (criterion 4); (b) the Call_Cap (Requirement 7 criterion 2); (c) a repeated `call_id` (criterion 6); (d) the tool name and Zod schema (criterion 5); (e) the checks of criteria 8, 10 and 11.
4. IF the `voiceCallId` and Join_Token hash do not match one Voice_Call, or the Voice_Call is not `live`, THEN THE Tool_Endpoint SHALL respond with HTTP 404, run no tool and write no Tool_Log row.
5. IF the tool name is unknown or the arguments fail the tool's Zod schema, THEN THE Tool_Endpoint SHALL return `{ "ok": false, "error": "unknown_tool" }` or `{ "ok": false, "error": "invalid_arguments" }` respectively, each with a `message`, and change no data. The `record_promise_to_pay` schema SHALL require `amount_paise` as an integer, `date_iso` as a string matching `YYYY-MM-DD`, and `spoken_text` as a string of 1 to 2,000 characters, and SHALL leave sign, range and calendar validity to criteria 10 and 11.
6. WHEN the Tool_Endpoint receives a `call_id` it already answered for the same Voice_Call, THE Tool_Endpoint SHALL return the stored result, including a stored error result, and change no data.
7. WHEN `get_invoice_facts` runs, THE Tool_Endpoint SHALL return `{ "ok": true }` with the Invoice_Facts computed by the Engine for the Voice_Call's invoice and `call_today`, with every amount formatted only by the Engine `formatINR`.
8. IF no Bank_Rate is effective on `call_today`, THEN `get_invoice_facts` SHALL return `{ "ok": false, "error": "bank_rate_missing" }` with every Invoice_Facts field except interest and Total_Due, and `record_promise_to_pay` SHALL return `{ "ok": false, "error": "bank_rate_missing" }` and change no data.
9. WHEN `record_promise_to_pay` runs with `amount_paise` greater than 0 and at most Total_Due and `date_iso` inside the Promise_Window, THE Tool_Endpoint SHALL, in one transaction, set `superseded_on` = `call_today` on the invoice's Current_Promise if one exists, insert one `promises` row with `promised_date` = `date_iso`, `amount_paise`, `recorded_on` = `call_today`, `source` = `voice`, `voice_call_id`, `spoken_text` and `is_partial` = (amount < Total_Due), and return `{ "ok": true }` with the amount as a `formatINR` string, the date as an Agent_Date equal to its Date_List entry, and `is_partial`. The invoice SHALL have exactly one Current_Promise afterwards, also when two such requests overlap.
10. IF `amount_paise` is 0 or less, or above Total_Due, THEN `record_promise_to_pay` SHALL return `{ "ok": false, "error": "amount_out_of_range" }` with Total_Due as a `formatINR` string and change no data.
11. IF `date_iso` is outside the Promise_Window or not a valid calendar date, THEN `record_promise_to_pay` SHALL return `{ "ok": false, "error": "date_out_of_range" }` with the first and last allowed dates and change no data.
12. WHEN `end_call` runs with `outcome` one of `dispute`, `no_promise` or `consent_declined`, THE Tool_Endpoint SHALL store that outcome as the Voice_Call's requested outcome, replacing any earlier requested outcome, and return `{ "ok": true }`.
13. WHEN the Call_Client has sent the `end_call` function output, THE Call_Client SHALL end the call as in Requirement 4 criterion 5 on the next `response.done` event or 10 seconds after sending, whichever comes first.
14. THE Tool_Endpoint SHALL write one Tool_Log row per request that passes criterion 4, with `tool` = the Call_Tool name, the invoice id, the `voiceCallId`, the `call_id`, the arguments and the result, including rejected, repeated and `call_time_up` requests.
15. THE `packages/db` schema SHALL add `source` (`manual` or `voice`, default `manual` for existing rows), `voice_call_id`, `spoken_text`, `is_partial` and `superseded_on` to `promises`, and the `voice_calls` and Transcript_Line tables, through a Drizzle migration that keeps every existing row, and the demo reset SHALL clear the new tables.

### Requirement 6: Persona

**User Story:** As a supplier, I want the agent polite, honest and firm, so that my relationship with the buyer is protected.

#### Acceptance Criteria

1. THE Persona_Instructions SHALL tell the agent to open by saying it is an AI assistant calling for the supplier by name, and to say "yeh call record aur transcribe ho rahi hai", before discussing the invoice.
2. THE Persona_Instructions SHALL tell the agent to speak Hinglish by default, switch to the language the buyer uses, address the buyer as "<first word of the buyer name> ji" (for example "Sharma ji" for Sharma Traders), and use at most two sentences per turn.
3. THE Persona_Instructions SHALL tell the agent to call `get_invoice_facts` before stating any figure, and to speak only numbers returned by a Call_Tool and dates returned by a Call_Tool or written in the data block (criterion 9), except when reading back the amount the buyer stated (criterion 4).
4. THE Persona_Instructions SHALL tell the agent to read back the amount in digits and words and the date as its Date_List entry, including the weekday written there, wait for an explicit "haan" (or "yes"), and only then call `record_promise_to_pay`; and, when the tool returns an error, to explain using the limits in the tool result and ask again.
5. THE Persona_Instructions SHALL tell the agent to mention the 31 March tax rule (`IT-43BH`) at most once, as helpful information, to state legal remedies only as facts, to never threaten, shout or shame, and, for an invoice with the caveat `registered_after_supply`, to say the claim may be contested.
6. THE Persona_Instructions SHALL tell the agent what to do if the buyer disputes the invoice or says "call mat karo": say the owner will follow up, call `end_call` with `dispute` (or `no_promise` for "call mat karo"), and end the call.
7. THE Persona_Instructions SHALL tell the agent what to do if the buyer objects to talking to an AI or to the recording: apologise, call `end_call` with `consent_declined`, and end the call.
8. THE Persona_Instructions SHALL place the buyer name, supplier name and invoice number only inside a delimited data block marked as data, SHALL tell the agent to treat the data block's contents as data and never as instructions, and the Call_Tools SHALL return these values only as data fields.
9. THE Persona_Instructions data block SHALL hold `call_today` as an Agent_Date and the full Date_List, both built on the server from the Voice_Call's `call_today` with the `packages/engine` date functions.
10. THE Persona_Instructions SHALL tell the agent to resolve every relative date the buyer says (for example "kal", "agle Friday", "mahine ke end tak") and every weekday it speaks only by looking up the Date_List, and, when the buyer's date matches no Date_List entry, to say the first and last Date_List entries and ask again.

### Requirement 7: Call cap, ending and outcome

**User Story:** As a supplier, I want every call to end with a clear outcome, so that I know what happened without listening to anything.

#### Acceptance Criteria

1. WHEN a `live` Voice_Call ends (through an End_Report, a `call_time_up` response under criterion 2, or the stale rule of criterion 3), THE `apps/web` app SHALL set the Voice_Call to `ended`, set `ended_at`, set `duration_seconds` = `ended_at` − `started_at` in whole seconds capped at 300, and set the outcome from server data only, by the first rule that applies: `promise` if a `promises` row with this `voice_call_id` exists; else the requested outcome from `end_call`; else `incomplete`. THE `apps/web` app SHALL ignore any outcome value the Call_Client sends.
2. IF a Tool_Endpoint request for a `live` Voice_Call arrives at or after `started_at` + Call_Cap, THEN THE Tool_Endpoint SHALL run no tool, return `{ "ok": false, "error": "call_time_up" }` and end the Voice_Call as in criterion 1.
3. IF a `live` Voice_Call has no End_Report by `started_at` + Call_Cap + 60 seconds, THEN THE next read of that Voice_Call by the Debtor_Page or Tool_Endpoint SHALL end the Voice_Call as in criterion 1 with `ended_at` = `started_at` + Call_Cap.
4. IF the peer connection reaches `failed`, or the peer connection or data channel closes without the Call_Client closing it, or a Realtime `error` event ends the session, THEN THE Call_Client SHALL send the End_Report, THE Voice_Call outcome SHALL be set as in criterion 1, and the failure SHALL create no promise.
5. IF an End_Report does not match a Voice_Call by `voiceCallId` and Join_Token hash, THEN THE `apps/web` app SHALL respond with HTTP 404 and change nothing.
6. WHEN an End_Report arrives for an `ended` Voice_Call, THE `apps/web` app SHALL change nothing.

### Requirement 8: Call log and transcript

**User Story:** As a supplier, I want to read what was said and what the agent did, so that I can follow up and trust the agent.

#### Acceptance Criteria

1. WHEN the Call_Client receives `conversation.item.input_audio_transcription.completed` or `response.output_audio_transcript.done` with non-empty text, THE Call_Client SHALL send the text and the Realtime item id to the server, and THE `apps/web` app SHALL store one Transcript_Line with speaker `buyer` or `agent` for a `live` Voice_Call, with its time = the instant the server received it, deduplicated by the Realtime item id.
2. THE `apps/web` app SHALL store no audio of any call.
3. IF a transcript request does not match a `live` Voice_Call by `voiceCallId` and Join_Token hash, THEN THE `apps/web` app SHALL respond with HTTP 404 and store nothing.
4. THE Transcript_Line text SHALL be stored and shown as untrusted text: escaped on render, cut to its first 2,000 characters when longer, and never passed to an LLM as instructions.

### Requirement 9: Promise on the timeline and the ladder

**User Story:** As a supplier, I want the buyer's promise on the timeline and the reminders paused, so that I don't chase a buyer who agreed to pay.

#### Acceptance Criteria

1. THE Engine_History used by the Ladder_Runner, the Approval_Queue, the Send_Check, the Graveyard_Page and the Debtor_Page SHALL include a `promises` row only if its `recorded_on` is on or before Today and its `superseded_on` is null or after Today, so that a promise replaced on or before Today and a promise recorded after Today neither pause the ladder nor show a wisp.
2. THE Active_Promise_Helper and the Promise_Until_Helper SHALL receive only histories built as in criterion 1 (carry-forward: promise history filtered by `recorded_on`).
3. THE Candle_Timeline SHALL show one `promise` entry per Visible_Promise of a Debtor_Invoice, including Replaced_Promises. A voice promise SHALL have the text "Promised <formatINR amount> by <D MMM YYYY> (by voice)", or "Promised <formatINR amount> by <D MMM YYYY> (by voice, partial)" for a Partial_Promise. Every Replaced_Promise entry SHALL have " (replaced)" appended to its text.
4. THE Candle_Timeline SHALL add the Entry_Kind `call`: one entry per ended Voice_Call with a `started_at`, dated on its `call_today`, with the row id = the Voice_Call id and the text "Voice call: <outcome text>, <m:ss>", where `m:ss` comes from `duration_seconds` and the outcome text is `promise` → "promise to pay", `dispute` → "disputed", `no_promise` → "no promise", `incomplete` → "incomplete", `consent_declined` → "declined the AI call", typed as `Record<CallOutcome, string>`. For entries on the same date, THE Candle_Timeline SHALL order Entry_Kinds as `invoice`, `due`, `ladder`, `call`, `promise`, `payment`, and SHALL exclude `call` entries dated after Today.
5. THE Debtor_Page SHALL show, under each `call` entry, its Transcript_Lines in time order and its Call_Tool requests with arguments and results, inside a `<details>` element closed by default.
6. WHEN a voice promise is recorded or a Voice_Call ends, THE `apps/web` app SHALL revalidate `/` and `/debtors/<Buyer_Id>`.
7. THE Debtor_Page SHALL read Voice_Calls, Transcript_Lines and voice Tool_Log rows only through `packages/db` functions filtered by `session.supplierId` through `invoices.supplier_id`.
8. WHILE a Debtor_Invoice is unpaid on Today and its Promise_Until_Date is after Today, THE Invoice_Panel SHALL show "Promise to pay active until <D MMM YYYY>" with the Promise_Until_Date, matching the Engine `nextEscalationStep`, which returns `promise_active` only while a promise's `promisedDate` is after Today. This replaces the on-or-after rule of debtor-ui Requirement 6 criterion 4 for the Invoice_Panel text only; the Engine, the Active_Promise_Helper, the Promise_Until_Helper and the wisp are unchanged.
9. WHILE a Debtor_Invoice is unpaid on Today and its Promise_Until_Date equals Today, THE Invoice_Panel SHALL show "Promise due today" in place of the active-promise text, and THE Ladder_Runner SHALL use the Engine Decision for that invoice unchanged.

### Requirement 10: Secrets and configuration

**User Story:** As a developer, I want the voice feature safe when keys are missing, so that the demo never breaks with a 500.

#### Acceptance Criteria

1. THE `apps/web` app SHALL read `OPENAI_API_KEY` and `VOICE_REALTIME_MODEL` only from server-side environment variables, and `apps/web/.env.example` SHALL list `VOICE_REALTIME_MODEL` with an empty value.
2. IF `OPENAI_API_KEY` is unset or empty, THEN THE Session_Endpoint SHALL respond with HTTP 503 and no Ephemeral_Key, leaving the Voice_Call status and `started_at` unchanged, and THE Call_Page SHALL show "The call could not start. Please try again later." with `role="alert"`.
3. THE Call_Page, Session_Endpoint, Tool_Endpoint, transcript route and End_Report route SHALL be reachable without sign-in, and the `config.matcher` of `apps/web/proxy.ts` SHALL keep them outside the Auth.js proxy, while every other route keeps its current protection.
4. THE Session_Endpoint, Tool_Endpoint, transcript route and End_Report route SHALL run on the Node.js runtime and include no stack trace, SQL text, `OPENAI_API_KEY` value or other secret in any response, except the Ephemeral_Key in a successful Session_Endpoint response.

### Requirement 11: Tests (mandatory)

**User Story:** As a developer, I want exact tests with no live calls, so that the call can't drift or cost money in CI.

#### Acceptance Criteria

1. THE test suite SHALL make no network call to OpenAI, SHALL mock the `client_secrets` call at the HTTP client boundary, and SHALL fail any test that issues an unmocked HTTP request.
2. THE test suite SHALL assert with exact `toEqual` on the whole result, on the Demo_Seed with `call_today` `2026-11-12`, the `get_invoice_facts` result for Sharma Traders `LPC/26-27/0412`, with paise values, dates, day counts, names and rule IDs written as literals in the test:
   - `ok` true, buyer name "Sharma Traders", supplier name "Laxmi Precision Components (Demo)", invoice number `LPC/26-27/0412`, no caveat;
   - principal `formatINR(41200000)`;
   - due date `17 Oct 2026` with `MSMED-15`, 26 Days_Overdue;
   - interest `formatINR(512794)` with `MSMED-16`;
   - Total_Due `formatINR(41712794)`;
   - tax-bomb date `31 Mar 2027` with 139 days left and `IT-43BH`.
3. THE test suite SHALL assert `record_promise_to_pay` for Sharma Traders at `call_today` `2026-11-12`, each case starting from the Demo_Seed:
   - 41712794 paise for `2026-11-20` is accepted with `is_partial` false and the date read as "Friday, 20 Nov 2026";
   - 20000000 paise for `2026-11-20` is accepted with `is_partial` true;
   - 0, −1 and 41712795 paise return `amount_out_of_range`;
   - `2026-11-11`, `2026-12-13` and `2026-02-30` return `date_out_of_range`;
   - `2026-11-12` and `2026-12-12` are accepted;
   - two accepted promises in a row set `superseded_on` on the first and leave exactly one Current_Promise.
4. THE test suite SHALL include a fast-check property, run with at least 100 cases, with `call_today` generated from `2024-04-01` to `2035-03-31` (the generator always including March dates, where `financialYearEnd` is closer than 30 days) and candidate dates generated from `call_today` − 60 days to `call_today` + 60 days, asserting that the Promise_Window check accepts a date if and only if it is on or after `call_today` and on or before the earlier of `call_today` + 30 days and `financialYearEnd(call_today)`.
5. THE test suite SHALL assert that after a voice promise recorded on `2026-11-12` for `2026-11-20`, a Ladder_Run at `2026-11-12` records `promise_active` and creates no Draft, the Debtor_Page shows "Promise to pay active until 20 Nov 2026", and the Candle_Timeline holds "Promised <formatINR(41712794)> by 20 Nov 2026 (by voice)"; that a promise recorded on `2026-11-13` is not in the Engine_History at Today `2026-11-12`; and that a promise recorded on `2026-11-12` and superseded on `2026-11-14` is in the Engine_History at Today `2026-11-13` and not at Today `2026-11-14`; and that at Today `2026-11-20`, with the same voice promise for `2026-11-20`, the Invoice_Panel shows "Promise due today" and not "Promise to pay active until 20 Nov 2026", and a Ladder_Run at `2026-11-20` records no `promise_active` and records the Engine `nextEscalationStep` Decision for that history and date.
6. THE test suite SHALL assert the Tool_Endpoint:
   - a repeated `call_id` returns the stored result and leaves one `promises` row;
   - a wrong Join_Token or a non-`live` Voice_Call gets HTTP 404 and no Tool_Log row;
   - an invoice id in the request body is ignored;
   - a request at `started_at` + 300 seconds returns `call_time_up` and ends the call;
   - one Tool_Log row is written per request that passes Requirement 5 criterion 4.
7. THE test suite SHALL assert the start and join paths, with the current instant injected:
   - for a supplier other than the Demo_Supplier, a start at 09:59 IST and at 19:00 IST on Thursday `2026-11-12`, and at 12:00 IST on Sunday `2026-11-15`, is refused with the Call_Window text;
   - for a supplier other than the Demo_Supplier, a start at 10:00 IST and at 18:59 IST on `2026-11-12` is accepted, a second call for the same buyer on the same Call_Day is refused with "This buyer was already called today", and the Invoice_Panel holds no Demo_Hours_Text;
   - the Call_Page_URL shown after a start begins with the origin of the start-call request;
   - another supplier's invoice is not found;
   - a used, expired or unknown Join_Token shows the expired text with no supplier or buyer data;
   - two concurrent joins mint exactly one Ephemeral_Key;
   - a microphone denial leaves the Voice_Call `created`;
   - the Session_Endpoint response carries `Cache-Control: no-store`, the mocked request body holds the Session_Config with `expires_after` 60 seconds, voice `marin`, `semantic_vad` and the Transcribe_Model, and no response, Tool_Log row or HTML contains the `OPENAI_API_KEY` value.
8. THE test suite SHALL assert the Demo_Supplier exemption of Requirement 1 criteria 14 and 15, with the current instant injected:
   - a start at 20:00 IST on Thursday `2026-11-12` and at 12:00 IST on Sunday `2026-11-15` is accepted;
   - a second call for the same buyer on the same Call_Day is accepted;
   - with 20 Voice_Calls of the Demo_Supplier started on the Call_Day, the next start is refused with "Demo call limit reached for today" and creates no Voice_Call;
   - the Invoice_Panel shows the Demo_Hours_Text.
9. THE test suite SHALL assert that for `call_today` `2026-11-12` the Persona_Instructions data block holds `call_today` as "Thursday, 12 Nov 2026" and a Date_List of exactly 31 entries whose first entry is "Thursday, 12 Nov 2026", whose last entry is "Saturday, 12 Dec 2026", and which contains "Friday, 20 Nov 2026".
10. THE test suite SHALL assert that, with the `apps/web/proxy.ts` matcher and handler of this spec, a signed-out request to `/` and to `/debtors/<id>` redirects to `/signin`, and a signed-out request to `/call/<token>`, the Session_Endpoint, the Tool_Endpoint, the transcript route and the End_Report route is not redirected.
11. THE test suite SHALL assert: the outcome rules of Requirement 7 criterion 1 for each Call_Outcome; the `call` Timeline_Entry texts; that `models.ts` selects `gpt-realtime-2.1` for `VOICE_REALTIME_MODEL` equal to `gpt-realtime-2.1` exactly, and `gpt-realtime-2.1-mini` for an unset value and for `gpt-4o-realtime`; that the files in the scope of Requirement 3 criterion 8 (non-test TS and JS files, with test files and Markdown excluded) hold no Realtime_Model or Transcribe_Model ID outside `models.ts` and no Banned_Model_ID; that no `package.json` lists `@openai/agents`; and that the Persona_Instructions contain the AI-identity and recording-disclosure line, the "haan" read-back rule, the Date_List lookup rule, the `end_call` rules and the data block of Requirement 6.
12. WHERE a developer sets `OPENAI_API_KEY` locally, THE repository SHALL provide one manual live check, outside the test suite and CI, that runs a Hinglish call with Sharma Traders at `?today=2026-11-12` on one laptop and confirms the disclosure, a read-back, a recorded promise on the timeline and the transcript.
13. THE tests, typecheck and lint of `packages/engine`, `packages/db`, `packages/agent`, `packages/voice` and `apps/web` SHALL pass with zero failures and zero errors, and every test task in this spec SHALL be required, with none marked optional.
