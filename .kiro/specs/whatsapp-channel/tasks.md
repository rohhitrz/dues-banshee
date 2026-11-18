# Implementation Plan: whatsapp-channel

## Overview

TypeScript (strict), Next.js App Router, CSS Modules, Drizzle, Vitest + fast-check, PGlite for db tests. Order follows the dependencies and keeps every commit green:
1. the Engine `istCalendarDate` move;
2. the `packages/db` migration `0003_*` and the scoped send and webhook queries;
3. the pure `packages/agent` channel pieces (env, E.164, wa.me, Outbound_Text, Send_Check history, masking) with the `fakeHttp`/`fakeClock` test boundary;
4. the Twilio_Sandbox and Razorpay clients;
5. `sendDraft`;
6. the webhook handlers;
7. the `apps/web` send actions, SendControls and webhook routes;
8. the manual live-check script.

Nothing here computes money or legal values. The amount is `invoices.amount_paise` formatted with the Engine `formatINR(paise, "full")`, the send-time check is the Engine `nextEscalationStep`, and the text is the Draft's stored `body_text` plus the escalation-ladder `buildFinalText`. `packages/engine` stays pure: no I/O, no `Date.now()`.

Every test task is required. No task is optional (Req 9.10). Expected values are exact literals with no tolerances. No test makes a network call to Twilio or Razorpay (Req 9.1).

Commit rule for every top-level task (git-workflow.md): one Conventional Commit using the message given in the task, files staged by path (`git add <paths>`), `git diff --staged` checked for secrets and real phone numbers, no `Co-Authored-By` or other trailers. Before committing, `test`, `typecheck` and `lint` must pass for every package touched by the task.

## Tasks

- [x] 1. Move the IST calendar-date rule into the Engine
  - Commit: `refactor(engine): move istDate into the engine as istCalendarDate`
  - [x] 1.1 Implement `istCalendarDate(nowMs): CalendarDate` in `packages/engine` and export it from `index.ts`
    - Same rule as `apps/web/lib/graveyard/today.ts` `istDate` (Asia/Kolkata, UTC+05:30); takes `nowMs` as input, never reads a clock; `purity.test.ts` must still pass; update the export list in `packages/engine/test/exports.test.ts` if it enumerates exports
    - `apps/web/lib/graveyard/today.ts` re-exports it as `istDate`; callers unchanged
    - _Requirements: 6.3 (Payment_Day for non-demo suppliers)_
  - [x] 1.2 Write `packages/engine/test/ist-calendar-date.test.ts`
    - Exact `toEqual`: `2026-11-11T18:29:59.999Z` → `"2026-11-11"`, `2026-11-11T18:30:00.000Z` → `"2026-11-12"`, `2027-03-31T18:30:00.000Z` → `"2027-04-01"`; existing `apps/web` today tests pass unchanged
    - _Requirements: 6.3, 9.10_

- [x] 2. Add the whatsapp-channel schema, migration and db queries
  - Commit: `feat(db): add whatsapp send and webhook schema, migration and queries`
  - [x] 2.1 Update `packages/db/src/schema.ts`, generate and hand-check `drizzle/0003_*.sql`
    - `buyers.whatsapp_number` (nullable) with check `buyers_whatsapp_number_e164` for `^\+[1-9][0-9]{7,14}$`; `drafts.send_claimed_at` (nullable timestamptz); `messages.draft_id` (references `drafts.id` on delete restrict), `provider_message_id`, `error_code`, and partial unique index `messages_one_sent_per_draft` on `draft_id` WHERE `status` IN (`'sent'`, `'handed_off'`); `payment_links.draft_id` (references `drafts.id` on delete restrict), `created_on` (day), unique index `payment_links_draft_id_key`; `escalation_action` gains `sent` via `ALTER TYPE … ADD VALUE` with no use of `'sent'` in the migration; new `webhook_events` table with unique (`provider`, `event_id`)
    - `EscalationDetail` gains `{ channel: "twilio_sandbox" | "wa_me"; messageRowId: string }`
    - `src/reset.ts` `RESET_TABLES` gains `"webhook_events"`
    - `src/ladder.ts`: `LadderRecord.steps` gains `draftId: string | null` from `escalation_events.draft_id` (additive; `engineHistory` still keeps only `approved` steps)
    - `src/seed.ts`: `seed(db, opts?: { demoBuyerWhatsapp?: string })` stores a value that passes the E.164 pattern on Sharma Traders, else leaves every Buyer_Number null and calls `console.warn("DEMO_BUYER_WHATSAPP is unset or not E.164; demo buyer has no WhatsApp number")` without the value; `scripts/seed.ts` and `scripts/reset-demo.ts` pass `process.env.DEMO_BUYER_WHATSAPP`; `resetDemo` forwards the option
    - `apps/web/lib/debtor/candle-timeline.ts` `ACTION_TEXT` gains `sent: "sent"` so its `satisfies Record<EscalationAction, string>` and the `apps/web` typecheck stay green
    - _Requirements: 1.5, 1.6, 3.3, 5.4, 5.5, 5.8, 6.4, 7.5_
  - [x] 2.2 Implement `packages/db/src/send.ts` and export it from `index.ts`
    - `SendContext`, `getSendContext`, `claimSend` (the single conditional `UPDATE … FROM invoices … RETURNING` with the 360-second lease and the `NOT EXISTS` Sent_Message clause, exactly as in design.md "Send claim"), `releaseSend`, `insertPayLink` (`"ok" | "duplicate"`), `recordSent` (one transaction: Message_Row + `sent` Escalation_Event `{ channel, messageRowId }`, `"ok" | "duplicate"`), `insertFailedMessage` (keeps the SID when given), `listSendState`
    - Every read and write filtered by `invoices.supplier_id`; generalise the existing `23505` cause-chain walk in `ladder.ts` to take a constraint name and use it for `payment_links_draft_id_key` and `messages_one_sent_per_draft`
    - _Requirements: 2.1, 2.2, 2.3, 2.8, 3.2, 3.3, 4.1, 4.7, 5.1, 5.2, 5.3, 5.7, 5.8_
  - [x] 2.3 Implement `packages/db/src/webhooks.ts` and export it from `index.ts`
    - `recordWebhookEvent(tx, provider, eventId): Promise<boolean>` as `INSERT … ON CONFLICT DO NOTHING RETURNING id`; `findPayLinkByProviderId` (joined to invoice, buyer and supplier); `markPayLinkPaid`; `setPaidOnIfNull` (`UPDATE … WHERE paid_on IS NULL RETURNING`)
    - _Requirements: 6.3, 6.4, 6.5, 6.6, 7.3, 7.5_
  - [x] 2.4 Write `packages/db/test/whatsapp-migration.test.ts` (PGlite)
    - Existing `buyers` rows keep a null `whatsapp_number`; insert and update with `+91 9000000001`, `919000000001` and `whatsapp:+919000000001` rejected by the check, `+919000000001` accepted; `sent` enum value present with old `escalation_events` rows intact; both unique indexes exist with the exact names; `webhook_events` rejects a repeated (`provider`, `event_id`) pair; `RESET_TABLES` includes `webhook_events` (existing reset test passes)
    - Seed with a valid, an empty and an invalid `demoBuyerWhatsapp`: valid stored on Sharma Traders only; empty and invalid leave every Buyer_Number null, finish without error and warn with the exact text and without the value
    - _Requirements: 1.5, 1.6, 5.4, 5.8, 8.3_
  - [x] 2.5 Write `packages/db/test/send.test.ts` (PGlite)
    - `getSendContext` returns `null` for another supplier's Draft and an unknown id, and the approval day, `hasSentMessage`, stored Pay_Link and Buyer_Number for the demo Draft
    - `claimSend` succeeds once, fails for a second claim, succeeds again after `releaseSend`, succeeds after the lease has passed (claim time set 361 s back), fails for another supplier, and fails once a Sent_Message exists
    - `insertPayLink` twice for one Draft → second `"duplicate"`; `recordSent` twice → second `"duplicate"` with no second Escalation_Event; a `failed` Message_Row does not block a later `sent` one; `recordWebhookEvent` returns `true` then `false`; `listSendState` lists approved WhatsApp Drafts without a Sent_Message and the latest Sent_Message with its `sent` event date
    - _Requirements: 2.2, 2.8, 3.3, 4.7, 5.1, 5.3, 5.8, 6.4_

- [x] 3. Checkpoint: engine and db
  - From the repo root run `pnpm -r --if-present test && pnpm -r --if-present typecheck && pnpm -r --if-present lint` (covers `packages/engine`, `packages/db`, `packages/agent`, `apps/web`); ensure all tests pass, ask the user if questions arise.

- [x] 4. Add the pure channel pieces and the HTTP test boundary
  - Commit: `feat(agent): add channel env, wa.me link, outbound text and test fakes`
  - [x] 4.1 Add the test boundary and the `twilio` dependency
    - `twilio` dependency in `packages/agent/package.json` (used only for `validateRequest` and, in tests, `getExpectedTwilioSignature`)
    - `packages/agent/src/testing/fake-http.ts` exported as subpath `@dues-banshee/agent/testing`: `fakeHttp(routes)` (method + URL-prefix routes for Twilio create, Twilio status poll with an ordered response list, Razorpay lookup and create; records method, URL, headers, parsed body; `unmatched` list; per-response `delayMs`) and `fakeClock()` (`sleep` records `ms` and advances the clock, `sleeps`, `timeoutSignal(ms)` aborting with a `TimeoutError` once the clock passes `ms`, `advance`)
    - Vitest `setupFiles` in `packages/agent` and `apps/web` replace `globalThis.fetch` with a function that throws `UnmockedRequestError`; an `afterEach` fails the test if it was reached or `unmatched` is non-empty
    - _Requirements: 9.1_
        - Notes: If an existing agent or apps/web test breaks because of the fetch guard, fix that test's mock; never loosen the guard.
  - [x] 4.2 Implement `packages/agent/src/channel/env.ts`
    - `ChannelEnv`, `readChannelEnv(env)`: missing or `trim()`-empty → unset; `twilio` non-null only when SID, token and an E.164 `TWILIO_WHATSAPP_FROM` are all set (a `whatsapp:` prefix counts as unset); `razorpay` non-null only when both keys are set and the key id starts with `rzp_test_`; `publicBaseUrl` with trailing `/` stripped; `sandboxJoinCode`; pure, reads only the passed map
    - _Requirements: 3.4, 8.1, 8.4_
  - [x] 4.3 Write property test `packages/agent/test/channel-env.property.test.ts`
    - **Property 8: Channel_Env reader**
    - Values drawn from missing, `""`, whitespace, valid and malformed (`whatsapp:+…`, `rzp_live_…`); `numRuns` ≥ 100
    - **Validates: Requirements 3.4, 8.4**
  - [x] 4.4 Implement `packages/agent/src/channel/message-channel.ts` and `channel/wa-me.ts`
    - `E164`, `parseE164`, `SendRequest`, `ChannelResult`, `ChannelErrorKind`, `PollRecord`, `MessageChannel` exactly as in design.md
    - `waMeUrl(to, text)` (`https://wa.me/<digits>?text=<encodeURIComponent(text)>`, or `https://wa.me/?text=…` for `null`) and `createWaMeLink()` returning `{ kind: "handoff", url }` with no I/O
    - _Requirements: 1.1, 1.4, 4.4_
  - [x] 4.5 Write property test `packages/agent/test/wa-me.property.test.ts`
    - **Property 2: WaMe_Link URL round trip**
    - Texts include `\n`, `₹`, Devanagari, `&`, `?`, `#`, `+`, `%`; numbers include `null`; also assert `createWaMeLink().send` makes no `fetch` call
    - **Validates: Requirements 1.4, 4.4**
  - [x] 4.6 Implement `packages/agent/src/channel/outbound-text.ts`
    - `payLinkLine(amountPaise, url)` = `Pay ${formatINR(amountPaise, "full")} here: ${url}`; `buildOutboundText({ body, ruleIds, url, amountPaise })` splitting on the escalation-ladder `PAY_LINK_TEXT` constant: one marker → URL in its place (split/join, never `String.replace`); no marker → body + `"\n\n"` + `payLinkLine`; two or more → `{ ok: false, reason: "multiple_markers" }`; result passed through `buildFinalText`
    - _Requirements: 3.6, 3.7, 4.1_
  - [x] 4.7 Write property test `packages/agent/test/outbound-text.property.test.ts`
    - **Property 1: Outbound_Text invariant**
    - Bodies with zero, one and two-plus markers, Hinglish, Devanagari, `{`, `$&` and line breaks, never containing the URL; non-empty distinct rule IDs from `RULE_IDS`; `https://` URLs; `numRuns` ≥ 100
    - **Validates: Requirements 3.6, 3.7, 9.5**
  - [x] 4.8 Implement `packages/agent/src/channel/send-check.ts`
    - `sendCheckHistory(record, draftId)` = `engineHistory({ steps: record.steps.filter(s => s.draftId !== draftId), promises: record.promises })`
    - _Requirements: 2.4, 5.5_
  - [x] 4.9 Write property test `packages/agent/test/send-check.property.test.ts`
    - **Property 3: Send_Check sees only other approved steps and promises**
    - Steps mixing every action including `sent`, any draft ids; asserts both `nextEscalationStep` Decisions are unchanged by non-`approved` rows; Engine generators from `packages/engine/test/arbitraries.ts`
    - **Validates: Requirements 2.4, 5.5**
  - [x] 4.10 Implement `packages/agent/src/channel/mask.ts`
    - `maskNumber(n)`: same length, last four digits kept, every other character `*`
    - _Requirements: 5.6, 7.3_

- [x] 5. Add the Twilio_Sandbox and Razorpay clients
  - Commit: `feat(agent): add twilio sandbox channel with status polls and razorpay client`
  - [x] 5.1 Implement `packages/agent/src/channel/twilio-sandbox.ts`
    - `createTwilioSandbox({ fetch, sleep, timeoutSignal, accountSid, authToken, from })` with defaults `setTimeout` sleep and `AbortSignal.timeout`; constants `CREATE_TIMEOUT_MS` 10,000, `POLL_TIMEOUT_MS` 1,000, `POLL_INTERVAL_MS` 2,000, `MAX_POLLS` 3
    - `to === null` → `failed/no_recipient` with no call; one form-encoded POST (`From` `whatsapp:<from>`, `To` `whatsapp:<to>`, `Body` unchanged, Basic auth), no retry; error JSON `code` 63015/63016 → `sandbox_window`, other → `provider_error`; abort/timeout → `timeout`; other throw → `network`; none of these poll
    - Only after a 2xx with a string `sid`: poll 1 at once, `sleep(2000)` before polls 2 and 3, each GET `…/Messages/{sid}.json` with `timeoutSignal(1000)`, Zod-read `status`/`error_code`; `failed`/`undelivered` stops with `failed` and the SID; a poll timeout, network error, non-2xx or schema miss records the poll error and ends with `sent`; every result carries `polls`; never throws
    - _Requirements: 1.2, 1.3, 1.7_
  - [x] 5.2 Write `packages/agent/test/twilio-sandbox.test.ts`
    - With `fakeHttp` and `fakeClock`, exact `toEqual` on every case in the design's testing table: create URL, Basic auth and `From`/`To`/`Body`; 63015, 63016, a 401 with code 20003, a create timeout and a network throw each give the exact `failed` result with zero GETs and `polls: []`; create signal `timeoutSignal(10_000)`, poll signals `timeoutSignal(1_000)`; three `queued` polls → `sent`, 3 GETs, `sleeps` `[2000, 2000]`; poll 1 `failed` 63015 → `failed/sandbox_window` with the SID, 1 GET, `sleeps` `[]`; network error on poll 1 → `sent`, 1 GET; polls `queued`, `queued`, `undelivered` 30008 → `failed/provider_error` code `"30008"`; create `delayMs` 10,000 still polls, 10,001 → `failed/timeout`; poll `delayMs` 1,001 → `timeout` poll record, polling stops, `sent`; the channel never throws
    - _Requirements: 1.2, 1.3, 1.7, 9.1_
  - [x] 5.3 Implement `packages/agent/src/channel/razorpay.ts`
    - `createRazorpayClient({ fetch, keyId, keySecret })` with `findByReference(draftId)` (`GET /v1/payment_links?reference_id=`, first entry with that `reference_id`, `url` = `short_url`, else `null`) and `create(body)` (`POST /v1/payment_links`); Basic auth, 10 s timeout; Zod-read responses; HTTP 400 whose `error.description` matches `/reference[ _]?id/i` and `/already/i` → `already_attempted`; other error, unexpected shape, timeout, network → `provider_error`/`timeout`/`network`; never throws
    - _Requirements: 3.1, 3.5, 3.9_
  - [x] 5.4 Write `packages/agent/test/razorpay-client.test.ts`
    - Exact create request (URL, Basic auth, JSON body with `amount`, `currency` `INR`, `accept_partial` false, `reference_id`, `notes.invoice_id`, `notify { sms: false, email: false }`); lookup parse for a found link, an empty list and a list whose entries have another `reference_id`; 400 "already attempted" → `already_attempted`; another 400, a 500, a bad body, a timeout and a network throw each give the exact error result
    - _Requirements: 3.1, 3.5, 3.9, 9.1_

- [x] 6. Checkpoint: channel pieces
  - From the repo root run `pnpm -r --if-present test && pnpm -r --if-present typecheck && pnpm -r --if-present lint` (covers `packages/engine`, `packages/db`, `packages/agent`, `apps/web`); ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement sendDraft
  - Commit: `feat(agent): add sendDraft with send claim, pay link and tool logs`
  - [x] 7.1 Implement `packages/agent/src/channel/send-draft.ts` and export the channel API from `packages/agent/src/index.ts`
    - `SendDeps`, `SendInput`, `SendOutcome`, `sendDraft` running the design's send-flow steps 1–12 in order, first failure ends the request: uuid + `getSendContext` → `not_found`; status/step/Sent_Message → `cannot_send`; `today !== approvalDay` → `approved_on` (no Send_Check); Send_Check with default `LadderConfig` and one `next_escalation_step` Tool_Log row → `send_check_failed`; `razorpay === null` → `payments_not_configured`; Twilio only: `no_buyer_number`, `sender_not_configured`; `claimSend` → `cannot_send`; Pay_Link: stored row, else lookup, else create, lookup again on `already_attempted`, `insertPayLink` (`duplicate` → `cannot_send`) → `pay_link_failed`; `buildOutboundText` (`multiple_markers` → `cannot_send`); Twilio only: `text.length <= 1600` → `too_long`; `channel.send` + one `send_whatsapp` Tool_Log row with `polls`; failure → `insertFailedMessage` → `channel_failed`; `recordSent` (`duplicate` → `cannot_send`, error → `record_failed`)
    - `releaseSend` on every failure from step 8 on, except a Twilio `sent` followed by a failed `recordSent` (claim kept)
    - One Tool_Log row per lookup (`find_payment_link`), create (`create_payment_link`) and channel call (`send_whatsapp`), none for a stored Pay_Link; payloads hold invoice id, Draft id, channel, Outbound_Text, `maskNumber(buyerNumber)`, provider ids or error kinds, and never the number, the WaMe_Link URL (handoff logs `{ kind: "handoff" }`), headers or any Channel_Env value; the payload builders are exported pure helpers for Property 5
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.8, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.8, 3.9, 3.10, 4.2, 5.1, 5.2, 5.3, 5.6, 5.7, 5.8, 8.2_
  - [x] 7.2 Write `packages/agent/test/send-draft.demo.test.ts`
    - Demo_Seed at Today `2026-11-12`, approved Sharma Traders `LPC/26-27/0412` `whatsapp_nudge` Draft from the fixed mock Model_Output citing `["MSMED-15", "MSMED-16"]`, fictional Buyer_Number, Twilio status route answering `queued` three times with `fakeClock`; exact `toEqual` on: the Decision `{ action: "advance", applicable: true, step: "whatsapp_nudge", rank: 1, requiresApproval: false, ruleIds: ["MSMED-15"] }`; the Razorpay body with `amount` 41200000; the full Outbound_Text with `Pay ` + `formatINR(41200000, "full")` + ` here: <mock URL>`, the Basis_Line `Basis: MSMED-15 (MSMED Act 2006, s.15); MSMED-16 (MSMED Act 2006, s.16)` and the Disclaimer last; the Twilio `From`/`To`/`Body`; the Message_Row and `sent` Escalation_Event with every field of Req 5.1; the `next_escalation_step`, `find_payment_link`, `create_payment_link` and `send_whatsapp` rows with the number masked to its last four digits and no Channel_Env value in any row
    - _Requirements: 3.1, 3.3, 3.6, 5.1, 5.6, 9.2_
  - [x] 7.3 Write `packages/agent/test/send-draft.paylink.test.ts`
    - Sharma `whatsapp_paylink` Draft at `2026-11-12` with the marker: exact Outbound_Text whose body line reads "Kripya <mock URL> se bhugtan kar dein." and no Pay_Link_Line; lookup finds a link before any create → stored, zero creates, sent with that URL; create answered with 400 "already attempted", then a lookup that finds a link → stored, one create, sent with that URL; lookup error, create 500 and 400 followed by an empty lookup each → `pay_link_failed`, no `payment_links` row, zero Twilio calls, claim released; a stored Pay_Link writes no `find_payment_link` or `create_payment_link` row
    - _Requirements: 3.2, 3.5, 3.6, 3.9, 3.10, 5.6, 9.13, 9.14_
        - Notes: A whatsapp_paylink send at 2026-11-12 passes the Send_Check only if the invoice already has an approved whatsapp_nudge step event on or before 2026-11-05 (7-day gap). Seed that event (with its own Draft) in this test; do not change the Engine or skip the Send_Check.
  - [x] 7.4 Write `packages/agent/test/send-draft.refusals.test.ts`
    - Each with zero Razorpay and zero Twilio calls and no Message_Row, Pay_Link or Escalation_Event: a `promises` row recorded on 2026-11-12 for 2026-11-20 after approval → `send_check_failed` with Decision `wait`/`promise_active` and its `next_escalation_step` row; another supplier's Draft and a non-uuid id → `not_found`; a pending Draft, a `voice_call` Draft and an already-sent Draft → `cannot_send`; Today `2026-11-13` for a Draft approved on 2026-11-12 → `approved_on` with no Send_Check row; `rzp_live_` key id → `payments_not_configured`; null Buyer_Number and Twilio unset (Twilio channel) → `no_buyer_number` / `sender_not_configured`; a two-marker body → `cannot_send`
    - Length: an Outbound_Text of 1,601 characters → `too_long`, zero Twilio calls, Pay_Link kept, and the same Draft then succeeds through `wa_me`; exactly 1,600 characters → one Twilio create call
    - _Requirements: 2.2, 2.3, 2.5, 2.6, 3.4, 3.8, 9.3, 9.4, 9.12_
  - [x] 7.5 Write `packages/agent/test/send-draft.concurrency.test.ts`
    - Two `sendDraft` calls under `Promise.all` with a fake Twilio that resolves only after both started: exactly one Twilio create call, one Pay_Link, one Sent_Message; the other → `cannot_send`; the same with a pre-stored Pay_Link; one Twilio and one `wa_me` racing → one Sent_Message in total; with the claim bypassed, `insertPayLink` twice and `recordSent` twice → each second insert rejected by its index → `cannot_send`
    - _Requirements: 2.8, 3.3, 5.8, 9.11_
  - [x] 7.6 Write `packages/agent/test/send-draft.failures.test.ts`
    - 63015 on create: one `failed` Message_Row with `error_code` `"63015"` and SID null, no Escalation_Event, claim released, Draft still sendable, retry reuses the Pay_Link with zero Razorpay creates
    - With `fakeClock`: 63015 on poll 1 → `channel_failed/sandbox_window`, `failed` row with the SID, one create, one GET; a non-sandbox code on poll 3 → `channel_failed/provider_error`, `failed` row, no event; three `queued` polls → `sent`, 3 GETs; a poll network error → `sent`; each case writes exactly one `send_whatsapp` row whose `polls` equal the expected records, masked number, no Channel_Env value
    - `recordSent` forced to fail after Twilio `sent` → `record_failed`, no Message_Row or event persisted, `send_whatsapp` row with the SID kept, claim kept; the same after a `wa_me` handoff → `record_failed`, claim released
    - _Requirements: 1.3, 1.7, 3.2, 5.3, 5.6, 5.7, 9.11_

- [x] 8. Add the Razorpay and Twilio webhook handlers
  - Commit: `feat(agent): add razorpay paid webhook and twilio inbound log handlers`
  - [x] 8.1 Implement `packages/agent/src/webhooks/razorpay-signature.ts`
    - `razorpaySignatureValid(rawBody, signature, secret)`: `node:crypto` HMAC-SHA256 hex over the raw text, length check then `timingSafeEqual`; `null` → false
    - _Requirements: 6.2, 6.11_
  - [x] 8.2 Write property test `packages/agent/test/razorpay-signature.property.test.ts`
    - **Property 6: Razorpay signature check**
    - Any Unicode body, non-empty secrets; mutations of one body character, one hex digit, signature length and secret; `numRuns` ≥ 100
    - **Validates: Requirements 6.2, 6.11**
  - [x] 8.3 Implement `packages/agent/src/webhooks/razorpay-event.ts`
    - Zod schema for `payment_link.paid` (`payload.payment_link.entity.id`, `amount_paid`; `payload.payment.entity.created_at`); `classifyRazorpayEvent` returning exactly one of `paid | already_paid | ignored_event_type | unknown_link | amount_mismatch | invalid_payload` in the design's order; `paymentDay(isDemo, linkCreatedOn, createdAtSec)` using the Engine `istCalendarDate`
    - _Requirements: 6.3, 6.5, 6.6, 6.8_
  - [x] 8.4 Write property test `packages/agent/test/razorpay-event.property.test.ts`
    - **Property 7: Webhook outcome and Payment_Day**
    - **Validates: Requirements 6.3, 6.5, 6.6**
  - [x] 8.5 Implement `packages/agent/src/webhooks/razorpay.ts` and export it from `packages/agent/src/index.ts`
    - `handleRazorpayWebhook({ db, env, isDemoSupplier }, { rawBody, signature, eventId })` → `WebhookResponse`: no secret → 503, nothing written; bad or missing signature → 401, nothing written; invalid JSON or no event id → 400 with no `webhook_events` row; one transaction: `recordWebhookEvent` (no row → `duplicate`), Pay_Link lookup, classify, `markPayLinkPaid` for `paid`/`already_paid`, `setPaidOnIfNull(Payment_Day)` for `paid`, one `razorpay_webhook` Tool_Log row last (event id, type, Pay_Link id or null, `amount_paid`, outcome); 200 with `revalidateBuyerId` set when `paid_on` changed; tx error → full rollback, 500 `{"error":"internal"}`; no stack, SQL or secret in any body
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10_
  - [x] 8.6 Write `packages/agent/test/razorpay-webhook.test.ts` (PGlite)
    - Fixture based on Razorpay's sample `payment_link.paid` payload, signed over the exact raw text sent: 503 and no db change with the secret unset; 401 and no db change for a missing and a wrong signature; a valid event for the Sharma Pay_Link → 200, link `paid`, `paid_on` `2026-11-12`, `revalidateBuyerId` = Sharma's buyer id, and `buildGraveyard` Tombstone_State `resurrected` at Today `2026-11-12`; the same event id again, sequentially and under `Promise.all` → 200 each, one `webhook_events` row, one change; amount mismatch, unknown link and a non-`payment_link.paid` type → 200, event recorded, one `razorpay_webhook` row with the matching outcome, no link or invoice change; an already-paid invoice keeps its `paid_on` and the link becomes `paid`; invalid JSON and a missing event id → 400 with no event row; a forced tx error → 500 `{"error":"internal"}` with no event row, and a retry of that event id is processed as new
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.8, 6.9, 6.10, 9.6_
  - [x] 8.7 Implement `packages/agent/src/webhooks/twilio.ts` and export it from `packages/agent/src/index.ts`
    - `handleTwilioInbound({ db, env }, { params, signature })`: no `twilioAuthToken` or `publicBaseUrl` → 503; missing header or `twilio.validateRequest(token, header, publicBaseUrl + "/api/webhooks/twilio", params)` false → 401; empty or missing `MessageSid` → 400; one transaction: `recordWebhookEvent("twilio", MessageSid)` and, when new, one `whatsapp_inbound` Tool_Log row `{ messageSid, from: maskNumber(From without "whatsapp:"), untrusted: { body: Body.slice(0, 1600) } }` with `invoiceId: null`; 200 `text/xml` `<?xml version="1.0" encoding="UTF-8"?><Response/>` for new and duplicate; tx error → 500 `{"error":"internal"}`; no reply, no LLM call, no other table written; the inbound payload builder is an exported pure helper for Property 5
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_
  - [x] 8.8 Write `packages/agent/test/twilio-webhook.test.ts` (PGlite)
    - 503 and no Tool_Log row with `TWILIO_AUTH_TOKEN` unset and with `PUBLIC_BASE_URL` unset; 401 for a missing and a wrong signature; a signature from `getExpectedTwilioSignature` for the Req 7.2 URL, with `PUBLIC_BASE_URL` with and without a trailing `/` → 200, the exact empty TwiML and one `whatsapp_inbound` row with the sender masked to its last four digits; a repeated `MessageSid` (sequential and `Promise.all`) → 200 and no second row; empty `MessageSid` → 400; a forced tx error → 500 with no row and no token or unmasked number in the body; no invoice, Draft, promise or Escalation_Event change; zero `fetch` calls and zero LLM calls
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 9.7_
  - [x] 8.9 Write property test `packages/agent/test/mask.property.test.ts`
    - **Property 5: Phone numbers are masked in every log payload**
    - Covers `maskNumber` and the serialized `send_whatsapp` payloads (`sent`, `handoff`, `failed`, any `polls`) and `whatsapp_inbound` payloads (with a `whatsapp:` prefixed sender and any `Body`); `numRuns` ≥ 100
    - **Validates: Requirements 5.6, 7.3**

- [x] 9. Checkpoint: agent
  - From the repo root run `pnpm -r --if-present test && pnpm -r --if-present typecheck && pnpm -r --if-present lint` (covers `packages/engine`, `packages/db`, `packages/agent`, `apps/web`); ensure all tests pass, ask the user if questions arise.

- [x] 10. Add the send actions and SendControls to the Debtor_Page
  - Commit: `feat(web): add send pay link and open in whatsapp to the debtor page`
  - [x] 10.1 Implement `apps/web/lib/send/messages.ts` and `apps/web/lib/send/control-state.ts`
    - `outcomeMessage(outcome, sandboxJoinCode)` → `{ text, role }` with the exact texts of design.md "Error Handling" and Req 4.6: "Queued with Twilio. Delivery is not tracked." / "Opened in WhatsApp. Tap Send on your phone." (`status`); "This draft can't be sent", "This draft was approved on <D MMM YYYY>. Approve a fresh draft to send today.", "Not sent: <WAIT_TEXT[reason] | STEP_TEXT[step]>", "Payments are not configured", the payment-link failure text, "Message too long for WhatsApp (max 1,600 characters)", the Req 1.3 sandbox text with `join <code>` or "send the join code from the Twilio sandbox page", the Req 1.7 not-sent text, the record-failed text (`alert`)
    - `pickSendableDraft` (max by `approvalDay`, `createdAt`, `id`) and `sendControlState` with precedence `no_draft` > `no_number` > `sender_not_configured` > `ready`
    - _Requirements: 1.3, 1.7, 2.3, 2.5, 2.6, 3.4, 3.5, 3.8, 4.1, 4.3, 4.4, 4.5, 4.6_
  - [x] 10.2 Write property test `apps/web/test/send-control-state.property.test.ts`
    - **Property 4: Send control state and draft choice**
    - **Validates: Requirements 4.1, 4.3, 4.4, 4.5**
  - [x] 10.3 Implement `apps/web/app/(debtor)/debtors/[id]/send-actions.ts`
    - `"use server"` `sendPayLink` and `openInWhatsApp` (`useActionState` signature, return `SendView`); read only `draftId` and `today`; supplier id only from `auth()`; no `supplierId` → `redirect("/signin")`; `SupplierNotFoundError` → `redirect("/signin?error=SessionExpired")` outside any `try` (the `withSupplier`/`STALE_URL` pattern of `approvals/actions.ts`); Today via `resolveSupplierToday`; deps per request from `readChannelEnv(process.env)`, `globalThis.fetch` and the Twilio_Sandbox defaults; unexpected error → `record_failed` with `console.error` only; `revalidatePath("/debtors/<buyerId>")` after any outcome that wrote a row; `approvals/actions.ts` unchanged
    - _Requirements: 2.1, 2.7, 2.9, 2.10, 4.2, 4.6, 8.1, 8.2_
  - [x] 10.4 Write `apps/web/test/send-actions.test.ts`
    - Mocks `@/auth`, `next/navigation`, `next/cache`, `fetch` via `vi.stubGlobal` with `fakeHttp`: no session → `/signin`, no call, no row; stale → one redirect to `/signin?error=SessionExpired`, never a 500; forged `supplierId`, amount, text and phone number fields ignored; the Demo_Override applies only to the demo supplier; each outcome gives its exact text and role; sandbox text with `TWILIO_SANDBOX_JOIN_CODE` set and unset; `openInWhatsApp` returns the WaMe_Link URL and `sendPayLink` never does; no Channel_Env secret in any returned `SendView`
    - _Requirements: 1.3, 2.1, 2.7, 2.10, 4.6, 8.2, 9.4, 9.11_
  - [x] 10.5 Implement `components/debtor/send-controls.tsx` (+ `.module.css`) and wire it into the Debtor_Page
    - Client component: Outbound_Text preview `<pre>` built with `buildOutboundText` and `"<link created on send>"`; "Send pay link" `<button>` enabled only in `ready`, else `disabled` with `aria-describedby` to "Approve a WhatsApp draft first" / "No WhatsApp number for this buyer" / "WhatsApp sender not configured"; "Open in WhatsApp" absent for `no_draft`, enabled otherwise; each in a `<form>` with `useActionState`, hidden `draftId` and (with an override) `today`; both disabled while either is pending; one `<p role>` result; synchronous `window.open("about:blank", "_blank")` with `opener = null`, then `location.href = url` or close, with a plain-link fallback when blocked; "Sent on <D MMM YYYY> via <Twilio sandbox | your WhatsApp>"; 44 × 44 targets, disabled text `#A9A497` without opacity
    - `components/debtor/placeholder-actions.tsx` keeps only "Start call" / "Arrives with voice call"; `lib/debtor/load.ts` adds `listSendState` and the `twilioReady` boolean (only booleans reach the client); `invoice-panel.tsx` and `page.tsx` render SendControls per Invoice_Panel; the Graveyard_Page is unchanged
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 8.5_
        - Notes: SendControls is a client component: it must import nothing from @dues-banshee/agent, @dues-banshee/db or twilio. Build the preview string on the server in lib/debtor/load.ts with buildOutboundText and pass it as a prop. Add a lint test asserting send-controls.tsx has no such imports.
  - [x] 10.6 Write `apps/web/test/send-controls.test.tsx` and extend `candle-timeline.test.ts` and `debtor-page.test.tsx`
    - SendControls: each "Send pay link" state with exact text and `aria-describedby`; the exact preview with "<link created on send>" (marker and no-marker bodies); "Open in WhatsApp" absent for `no_draft`; both disabled while pending; exact WaMe_Link URL for a fixed fictional number and Outbound_Text and exact `https://wa.me/?text=<encoded>` for null; "Sent on 12 Nov 2026 via Twilio sandbox" and "via your WhatsApp"; "Start call" still disabled with "Arrives with voice call"
    - A `wa_me` handoff through `openInWhatsApp` on PGlite writes one `wa_me` `handed_off` Message_Row and one `sent` Escalation_Event; `candle-timeline.test.ts` gains a `sent` event giving "WhatsApp nudge sent"
    - `debtor-page.test.tsx`: with every Channel_Env value unset, the Demo_Seed page renders without error and "Send pay link" is in a disabled state of Req 4.3–4.5
    - _Requirements: 4.1, 4.3, 4.4, 4.5, 4.7, 4.8, 4.9, 5.2, 5.4, 8.5, 9.8_

- [x] 11. Add the webhook routes and Channel_Env configuration
  - Commit: `feat(web): add razorpay and twilio webhook routes and channel env`
  - [x] 11.1 Implement `apps/web/app/api/webhooks/razorpay/route.ts` and `apps/web/app/api/webhooks/twilio/route.ts`
    - Both `export const runtime = "nodejs"`; Razorpay: `await req.text()` first, then `X-Razorpay-Signature` and `x-razorpay-event-id`, call `handleRazorpayWebhook` with `readChannelEnv(process.env)` and the demo-supplier check, `revalidatePath("/")` and `revalidatePath("/debtors/<id>")` before responding when `revalidateBuyerId` is set; Twilio: `await req.formData()` into string-only params plus `X-Twilio-Signature`, call `handleTwilioInbound`; responses use the handler's status, body and content type only
    - `proxy.ts` unchanged
    - _Requirements: 6.7, 6.11, 7.2, 8.4, 8.6, 8.7_
  - [x] 11.2 Write `apps/web/test/webhook-routes.test.ts` and extend `apps/web/test/proxy.test.ts`
    - Both routes export `runtime = "nodejs"`; the Razorpay route passes the `req.text()` string unchanged to the handler; a paid result revalidates `/` and `/debtors/<id>` before the response; unset secrets give 503, never 500
    - `config.matcher` of `apps/web/proxy.ts` matches neither `/api/webhooks/razorpay` nor `/api/webhooks/twilio`
    - _Requirements: 6.7, 6.11, 8.4, 8.6, 8.7, 9.15_
  - [x] 11.3 Update `apps/web/.env.example` and extend `apps/web/test/lint.test.ts`
    - `.env.example` lists `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, `TWILIO_SANDBOX_JOIN_CODE`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `PUBLIC_BASE_URL`, `DEMO_BUYER_WHATSAPP`, each as `NAME=` alone on its line
    - Lint test: no `api.twilio.com`, `wa.me` or `api.razorpay.com` string in `apps/web` outside tests; `.env.example` has every Channel_Env name with an empty value; no `AC[0-9a-f]{32}`, `rzp_(test|live)_[A-Za-z0-9]{14}` or `+91` 10-digit number outside the fictional fixture list in git-tracked files; every local env file except `apps/web/.env.example` is git-ignored
    - _Requirements: 1.1, 8.1, 8.2, 8.3_

- [x] 12. Checkpoint: web
  - From the repo root run `pnpm -r --if-present test && pnpm -r --if-present typecheck && pnpm -r --if-present lint` (covers `packages/engine`, `packages/db`, `packages/agent`, `apps/web`); ensure all tests pass, ask the user if questions arise.
    - Notes: Also run the Playwright smoke: start `pnpm --filter web dev`, then `pnpm --filter web e2e` (the debtor page changed).

- [x] 13. Add the manual live-check script
  - Commit: `chore(agent): add manual whatsapp live-check script`
  - [x] 13.1 Write `packages/agent/scripts/whatsapp-live-check.ts`
    - Reads Channel_Env, `DATABASE_URL` and `DEMO_BUYER_WHATSAPP`; exits with a message naming any missing variable (never its value) and refuses a key id without `rzp_test_`; builds the Sharma Traders Outbound_Text with `buildOutboundText`; runs `findByReference` first and creates a link only when none exists (test mode allows 30 links); sends through `createTwilioSandbox` with the real `sleep` and `AbortSignal.timeout`; prints the Twilio message SID, the link URL and the final polled status (last `polls` entry); writes nothing to the database
    - Excluded from Vitest globs, the `test` script and CI; typecheck and lint still cover it
    - _Requirements: 9.9, 8.3_

- [x] 14. Final checkpoint
  - From the repo root run `pnpm -r --if-present test && pnpm -r --if-present typecheck && pnpm -r --if-present lint` with zero failures and zero errors in `packages/engine`, `packages/db`, `packages/agent` and `apps/web`; ensure all tests pass, ask the user if questions arise (Req 9.10).

    - Notes: Also run `pnpm --filter web build` (catches twilio bundling and client/server import errors before Vercel auto-deploys on push).
    
  - Ask the user to run the manual live check themselves (not a test task, not in CI) with test-mode keys and a sandbox-joined number: `pnpm --filter @dues-banshee/agent exec tsx scripts/whatsapp-live-check.ts`, and to confirm the message lands with the link, and the printed SID, link URL and final status (Req 9.9). Also confirm the real Razorpay "already attempted" wording once (design Open Decision 3).

## Notes

- No task is optional; every unit, integration and property test is required (Req 9.10).
- Property tests use fast-check, `{ numRuns: 100 }` minimum, one test per property, tagged `// Feature: whatsapp-channel, Property N: <title>`. Properties 1–8 map to tasks 4.7, 4.5, 4.9, 10.2, 8.9, 8.2, 8.4 and 4.3.
- Phone numbers in tests and fixtures are fictional placeholders such as `+919000000001` (Req 8.3).
- Task 2.1 adds `sent` to `ACTION_TEXT` in the same commit as the enum, so `apps/web` typecheck stays green at every commit.
- Sub-tasks inside one top-level task may not pass on their own; the commit happens once per top-level task, after all its sub-tasks pass.
- `packages/agent/src/index.ts` is edited by 7.1, 8.5 and 8.7, which sit in different waves.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "4.1"] },
    { "id": 1, "tasks": ["1.2", "2.2", "4.2", "4.4", "4.10"] },
    { "id": 2, "tasks": ["2.3", "2.4", "4.3", "4.5", "4.6", "4.8", "5.3"] },
    { "id": 3, "tasks": ["2.5", "4.7", "4.9", "5.1", "5.4", "8.1", "8.3"] },
    { "id": 4, "tasks": ["5.2", "7.1", "8.2", "8.4"] },
    { "id": 5, "tasks": ["7.2", "7.3", "7.4", "7.5", "7.6", "8.5"] },
    { "id": 6, "tasks": ["8.6", "8.7", "10.1"] },
    { "id": 7, "tasks": ["8.8", "8.9", "10.2", "10.3", "11.1"] },
    { "id": 8, "tasks": ["10.4", "10.5", "11.2", "11.3"] },
    { "id": 9, "tasks": ["10.6", "13.1"] }
  ]
}
```
