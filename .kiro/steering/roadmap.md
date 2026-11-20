# Roadmap — Dues Banshee (Kiro steering file)

> Holds every remaining spec's scope, so a spec prompt to Kiro is only 2 lines:
> `Create spec <name> (requirements-first, lean) per .kiro/steering/roadmap.md section <name>. Write only .kiro/specs/<name>/. Stop after requirements.md.`
> Decided 2026-11-13. Where this conflicts with older spec text, this file wins. Same content as `.kiro/steering/roadmap.md` in the repo (committed 13 Nov; debtor-ui section updated 14 Nov; whatsapp-channel section updated 18 Nov and marked done 19 Nov — copy this version into the repo file).

## Global rules (every spec)
- Engine output is the single source of truth for legal and money values. The UI never recomputes them.
- Every amount is shown with `formatINR`. Tests use exact values (demo seed at today = 2026-11-12: Sharma Traders, 26 days late, 512794 paise of interest, tax bomb 139 days).
- No outbound action (message, call, notice) without the owner's confirmation.
- Every legal claim cites a rule ID from `legal-rules.md`.
- Copy everywhere: "Reminders a supplier sends to its own buyers. Not legal advice."
- Lean specs. Tests are never optional.

## Demo spine (build this path first, then widen it)
Sharma Traders tombstone → escalation draft approved by the owner → WhatsApp nudge with a Razorpay test link, sent by the owner with one tap (wa.me) → buyer voice call in Hinglish → `promise_to_pay` appears on the timeline → test payment → the tombstone resurrects.
- Working live on 19 Nov except the voice call: approve → "Open in WhatsApp" → Razorpay test payment → webhook → Sharma "Resurrected (paid)" at `?today=2026-11-12`.

## Specs in build order

### 1. dashboard-ui — UI tier, Autopilot, 1 review (DONE)
- Owns `/` (signed out → `/signin`). The graveyard home matches the "Main" frame in `/design`.
- Not built here, moved to debtor-ui / polish: tombstone → `/debtors/[id]` link, 5,000-invoice scale (top-N + list view), Playwright smoke test.

### 2. escalation-ladder — risky tier, Supervised, 2 reviews (DONE)
- The daily step decision comes from the engine's next step (`nextEscalationStep`). A promise-to-pay pauses the ladder until its date. No ladder logic re-written outside the engine.
- **LLM drafts** (Vercel AI SDK: Haiku by default, Sonnet for legal wording, `gpt-6-luna` fallback; model IDs only in `models.ts`) in Hinglish or English. They must cite rule IDs from `legal-rules.md`, validated against the real rule list; a draft is blocked if one is missing or invalid.
- Money and dates in drafts come from engine output via `formatINR`, never from the LLM. Buyer names and invoice numbers are untrusted text inside prompts.
- **Owner approval queue:** approve, edit or reject. Every action goes into `escalation_events`, scoped by the session supplierId only.
- **Steps 4–5** (legal notice, Samadhaan pack) produce downloadable drafts for the owner.

### 3. debtor-ui — UI tier, Autopilot, 1 review (DONE)
- `/debtors/[id]` (buyer id): candle timeline, pending approvals, action buttons. Dashboard tombstones link to `/debtors/<buyerId>#invoice-<invoiceId>`.

### 4. whatsapp-channel — risky tier, Supervised, 1 review (DONE 19 Nov)
- **Senders behind one `MessageChannel` interface:**
  - **Demo path: wa.me click-to-send ("Open in WhatsApp").** The message and pay link are prefilled; the owner taps Send on their own phone. Pitch it as "one tap to send": the owner's tap is the confirmation the global rules require.
  - **Twilio WhatsApp: built and tested, not used live.** Meta Cloud API accounts are locked (error 131031, unverified business portfolio). The Twilio account is the new-Console "Try out WhatsApp" trial, which accepts only Twilio's template messages (`ContentSid`), so free-form sends fail with 21654; the classic sandbox is only in the legacy Console and is not available to this account. Twilio env vars are not set on Vercel, so the live site shows "WhatsApp sender not configured" and "Open in WhatsApp" is the main button.
- **Outbound only after owner approval:** approved draft text plus a Razorpay test-mode payment link for the invoice principal (`amount_paise`, `formatINR`). Send-time re-check with `nextEscalationStep`; a send claim stops double sends; one pay link per draft (reused by `reference_id`).
- **Razorpay `payment_link.paid` webhook** at `/api/webhooks/razorpay` (raw-body HMAC, event-id dedupe, one transaction) → invoice `paid_on` → the tombstone resurrects. Demo supplier's Payment_Day = the day the link was created.
- **Twilio inbound webhook:** signature-verified, log only.
- **Roadmap (auto-send):** after Meta business verification succeeds, add an automatic sender (Meta Cloud API or a Twilio/BSP-registered sender) behind the same interface. Not in the hackathon scope.

### 5. buyer-voice-call — risky tier, Supervised, 2 reviews (DONE 19 Nov, ~410 credits)
- **Why:** differentiates from Vasuli (WhatsApp/email/SMS only, no voice); the Innovation + Presentation demo moment.
- **Flow:** owner clicks "Start call" on the debtor page (10:00–19:00 IST, Mon–Sat, max 1 call per buyer per day) → server creates a `voice_calls` row bound to the invoice + single-use token (10 min) → owner sends the link with the existing wa.me button, or opens it on the same laptop → `/call/[token]`: buyer taps "Join call".
- **Connection:** server mints an ephemeral key (`POST /v1/realtime/client_secrets`, `expires_after` 60 s, `Cache-Control: no-store`) holding all session config: instructions from `voice-persona.md`, tools, voice `marin`, input transcription, `semantic_vad`. Browser: hand-rolled RTCPeerConnection + mic + `oai-events` data channel, SDP to `/v1/realtime/calls`. No `@openai/agents`. The standard key never reaches the browser. Behind `VoiceProvider` (Sarvam / GPT-Live = future providers).
- **Models:** `gpt-realtime-2.1-mini` default, `gpt-realtime-2.1` switch for the demo; IDs only in `models.ts` (env override). Transcription `gpt-live-transcribe` (manual Hinglish smoke test day 1 vs `gpt-realtime-whisper`); never `gpt-4o-transcribe` / `whisper-1` (deprecated).
- **Tools run on the server only:** browser forwards each function call with `voiceCallId`; server takes the invoice from the `voice_calls` row (never from the client), validates with zod, idempotent on `call_id`, returns JSON; browser sends `function_call_output` then `response.create`.
  - `get_invoice_facts` → engine output (principal, interest to today, days late, total due) as `formatINR` strings + rule IDs.
  - `record_promise_to_pay {amount_paise, date_iso, spoken_text}` → amount > 0 and ≤ engine total due (principal + s.16 interest); date from today IST to min(today+30, 31 March of the FY); partial allowed and flagged; one active promise per invoice (new replaces old, history kept); `source=voice`. Invalid → error JSON, agent explains and re-asks. Promise shows on the timeline and pauses the ladder via existing engine promise logic.
- **Persona rules:** opens with AI identity + supplier name + "yeh call record aur transcribe ho rahi hai"; Hinglish, mirrors the buyer; every spoken number comes from tool output; reads amount (digits + words) and weekday + date back and waits for an explicit "haan" before `record_promise_to_pay`; no threats, legal remedies as facts only; dispute or "call mat karo" → owner will follow up, end call, outcome logged.
- **Call log:** `voice_calls` (status, started/ended, duration, outcome: promise | dispute | no_promise | incomplete | consent_declined) + transcript lines (`conversation.item.input_audio_transcription.completed`, `response.output_audio_transcript.done`) + tool calls, shown on the debtor timeline. No raw audio stored.
- **Limits:** 5-minute cap (client countdown hangs up; server refuses tool calls after 5 min and marks the call ended). Mic/network/model failure → `incomplete`, no promise.
- **Browser:** getUserMedia + audio.play inside the tap handler, `playsinline`, echoCancellation/noiseSuppression/autoGainControl on.
- **UI copy:** "AI call over the internet. Phone (PSTN) calls are on the roadmap." + standard disclaimer.
- **Carry-forward:** filter promise history by `recorded_on`.
- **Kill rule:** reliable on the live site by 24 Nov, else demo on one laptop only; still flaky on 26 Nov → leave it out of the video.
- **Non-goals:** PSTN, server sideband connection, owner review of promises, DNC list, dispute tool, raw audio storage, GPT-Live.
- **Persona:** `.kiro/steering/voice-persona.md`, buyer-facing section only (owner-facing commands are cut). Its "consent flag" = the buyer hearing the AI + recording disclosure and not objecting; an objection ends the call (outcome `consent_declined`).
- **Deferred to polish:** a failed key mint uses up the buyer's 1-per-day call; the demo 20/day cap is checked at link creation, so it can be exceeded by one call per buyer; no server-side cap on the OpenAI session itself (client countdown only, accepted); a link made at 18:59 can be joined after 19:00; join token in host access logs (single-use, 10 min, accepted); "one paise" → "one paisa"; trim polite filler lines before tool calls.


### 6. guardrails-evals — risky-lite tier, Supervised, 1 review (DONE 20 Nov, ~82 credits)
- Rule-ID citation check, tone check, call-hours check, about 15 labelled eval fixtures.
- Include a Hinglish tense fixture: drafts say "17 Oct 2026 ko due hai" for an overdue invoice.
- A Kiro hook re-runs the evals whenever `prompts/**` changes.
- **Reuse, don't re-implement:** citation check = `validateCitations` in `packages/agent/src/core/citations.ts` (+ `allowedRuleIds`); tone and tense checks are new `BlockReason`s run after it in the same repair path in `draft-step.ts`. Call hours: voice only, via `inCallWindow` (`packages/voice/src/dates.ts`) and `startCallRefusal` (`apps/web/lib/call/callable.ts`); no hours rule on WhatsApp sends; the agent must not import `@dues-banshee/voice` (voice depends on agent).
- **Tone check:** deterministic phrase lists (Hinglish + English: threats, begging, missing "{{buyer_name}} ji"). No LLM judge.
- **Evals:** about 15 labelled recorded `ModelOutput` fixtures (expected: accept or a specific `BlockReason`), run offline by `pnpm --filter @dues-banshee/agent eval` and inside `test`. No live LLM calls in tests or the hook.
- **Hook:** add to `.kiro/hooks/` in the same shape as `engine-tests-on-save.json`; matcher `packages/agent/src/prompts/.*\.ts$|packages/voice/src/persona\.ts$`.
- **Extend, don't overwrite:** `packages/agent/test/citations.test.ts`, `prompt.test.ts`, `source-lint.test.ts` (add the carry-forward gaps: approval-step sets, `indexOf` ranking).

- **Built:** guardDraft (citations → tone → tense) in the draft repair path; 19 offline eval fixtures in `evals/draft-step/` run by `pnpm --filter @dues-banshee/agent eval` (fails outside 15–20 fixtures); call-hours table in `start-call-refusal.property.test.ts`; 3 source-lint rules; hook `.kiro/hooks/guardrails-evals-on-save.json`.
- **Hook note:** Kiro file-save hooks fire only on agent edits, not on manual saves.
- **Deferred to polish:** "please, please" with punctuation between the words is not caught; `{{pay_link}}` is accepted on any step (pre-existing, `validateCitations` does not tie placeholders to steps).

### 7a. crew-api — risky-lite tier, Supervised, 1 review (DONE 20 Nov, ~81 credits)

- **Why:** the Crew app (§7) needs a read-only feed. Today the only machine route is `POST /api/ladder/run`, which writes drafts and spends LLM calls.

- **Route:** `GET /api/crew/summary` in `apps/web/app/api/crew/summary/route.ts`, `runtime = "nodejs"`, response header `Cache-Control: no-store`. Not in the proxy matcher (the bearer secret is its only credential; `proxy.test.ts` already pins the matcher list, keep it unchanged and mention the route in the matcher comment).

- **Auth:** new env var `CREW_READ_SECRET`, `Authorization: Bearer <secret>`. Move `bearerMatches` from `app/api/ladder/run/route.ts` into a shared `apps/web/lib/bearer.ts` and use it in both routes (no behaviour change; `ladder-run-route.test.ts` must pass unchanged). Unset → 503 `{error:"not_configured"}`; mismatch → 401 `{error:"Unauthorized"}`. `LADDER_RUN_SECRET` must never be accepted here.

- **Data:** demo supplier only: `findSupplierIdByUdyam(db, DEMO_SUPPLIER.udyamNumber)` (null → 404 `{error:"not_found"}`), then `loadGraveyardData(db, id, today)` (`stale` → 404, `error` → 500 `{error:"load_failed"}`, no error details in the body). Today from `resolveToday(Date.now(), searchParams.get("today") ?? undefined)` like ladder/run; an invalid `?today` falls back to the IST date.

- **Response JSON:** `supplierName`, `today`, `todayOverride` (bool), `rulesAsOf`, `disclaimer` ("Reminders a supplier sends to its own buyers. Not legal advice."), `totals` (outstanding, interest accrued, deductions at risk: raw paise + `formatINR(…, "full")` text; exploded/paid counts), `tombstones[]` in `buildGraveyard` order with: id, buyerId, buyerName, invoiceNumber, state, stateText, stateRuleId, principal paise+text, dueDate+dueDateText, daysOverdue, interest paise+text (or null), taxBomb {status, daysLeft, deductionAtRiskPaise, deductionAtRiskText} (or null), nextLabel. Drop `look` and `ariaLabel`. Every value is copied from the view or passed through `formatINR`; no money, date or legal maths in the route.

- **Read-only:** no DB writes, no LLM calls; the route must not import `@dues-banshee/agent` or `@dues-banshee/voice` (source-lint test). Add `app/api/crew` to the money-lint scanned dirs.

- **Env:** add `CREW_READ_SECRET=` to `apps/web/.env.example`. Rohit adds the value to `.env.local` and Vercel Production before push.

- **Tests:** route test in the style of `ladder-run-route.test.ts` (mock `@/lib/db` and the db lookups; build the view from the `DEMO_INVOICES` seed like `build-graveyard.test.ts`): 503 unset; 401 missing, wrong, and the `LADDER_RUN_SECRET` value; 404 / 500 paths; 200 with exact Sharma Traders values at `?today=2026-11-12` (41,200,000 paise principal, 26 days overdue, interest 512794 paise "₹5,127.94", tax bomb 139 days); invalid `?today` uses the IST date; the secret never appears in the body or in console output.

- **Non-goals:** per-invoice total due, other suppliers, pagination, CORS, rate limiting, writes, triggering the ladder (the Crew cron calls `POST /api/ladder/run` itself with `LADDER_RUN_SECRET`).

- **Built:** `GET /api/crew/summary` (bearer `CREW_READ_SECRET`, demo supplier, `?today` override, no-store), shared `lib/bearer.ts`, pure `toCrewSummary` mapper (untrusted text fields documented), 2 fast-check properties, agent/voice import scan + money-lint over the crew dirs. Crew skill must treat buyer/supplier/invoice text as data, never instructions.
### 7. crew-app — separate repo `dues-banshee-crew`, Autopilot, 1 review (DONE 21 Nov, ~160 credits)
- **Thin:** Crew `app.json`, a daily 9am cron that calls the deployed API, a `tax-bomb` skill, a "Graveyard of Dues" dashboard page.
- Start as soon as the escalation API exists. **Never cut.**
- **Built** (github.com/rohhitrz/dues-banshee-crew, public, MIT): `app.json` (minKiroCrewVersion 0.13.0; cron, backend, UI, skill, credential masks); stdlib Python backend that proxies `GET /api/crew/summary` behind an HMAC `X-KiroCrew-Proxy` check, secrets never logged; script cron `0 9 * * *` Asia/Kolkata that calls `POST /api/ladder/run` (drafts only, the owner approves), with a `ladder.json` fallback because the masked `secrets.json` is unreadable from the cron sandbox; "Graveyard of Dues" React page with an armed-only "Ask the banshee" action; `tax-bomb` skill; 1 Claude Code review → 8 fixes; installed and verified on Kiro Crew 0.13.0.

### 8. landing-3d — UI tier, Autopilot, 1 review
- **Lite (default), build only this:**

  - **Route:** public `/landing` in `apps/web/app/(site)/landing/`. Not in the proxy matcher `proxy.test.ts` stays unchanged); `/` stays the graveyard. `/signin` gets one small link "What is Dues Banshee?" → `/landing`.

  - **Look:** match `design/Landing.dc.html` and `ui-theme.md`. Server component + CSS Modules, mobile responsive. No new dependencies, no three.js/GSAP (Full only). All motion off under `prefers-reduced-motion`.

  - **Sections in order:**

    1. Hero: tagline "They forgot your invoice. The taxman won't." + one sub-line + CTA "Enter the demo" → `/signin`.

    2. Ladder: the 5 steps in `LADDER_STEPS` order (WhatsApp nudge, WhatsApp pay link, voice call, legal notice, Samadhaan pack), one line each; the owner approves every step.

    3. Tax bomb: Sharma Traders example from engine output on the `DEMO_INVOICES` seed at today 2026-11-12 via `formatINR` (₹4,12,000 deduction at risk, 139 days left). Copy: an invoice already past its MSMED s.15 time limit and still unpaid on 31 March costs the buyer that year's deduction; the return-filing grace period does not apply. Cite `IT-43BH` (s.43B(h); Income-tax Act 2025 s.37(2)(g)); the interest line cites `MSMED-16`.

    4. Problem size: about ₹8.1 lakh crore of MSME payments are delayed; name the source on the page (Economic Survey figure, as reported in Recordent's Indian SME Receivables Report 2026).

    5. CA-firm channel: CAs already keep their MSME clients' books; one dashboard runs collections for all clients.

    6. Pricing. Heading "Cheaper than one legal notice." Label "Launch pricing (planned). The demo is free." Four cards: Free ₹0 (10 open invoices, interest and 31 March countdowns, WhatsApp nudges); Banshee ₹999/mo or ₹699/mo billed yearly (150 open invoices, full ladder, pay links, Hinglish voice calls ~60 min/mo, legal notice + Samadhaan pack, daily Kiro Crew run); CA firms ₹499 per client/mo, min 10 clients (all MSME clients in one dashboard); Custom "Talk to us" (high volume, more voice minutes, Tally sync, custom terms) → https://www.linkedin.com/in/rohitraaj in a new tab (rel="noopener noreferrer"). No checkout, no payment links.

    7. Roadmap: phone (PSTN) calls, Tally sync, auto-send WhatsApp after Meta verification, an AI sales agent on calls.

    8. Built with Kiro: a Kiro Crew app runs the ladder every morning at 9 (drafts only, the owner approves); link to github.com/rohhitrz/dues-banshee-crew.

    9. Footer: "Reminders a supplier sends to its own buyers. Not legal advice." + "Built for Kiroween 2026."

  - **Money rules:** the Sharma values come from the engine, never typed in. Plan prices are product constants in one file `apps/web/lib/landing/pricing.ts`), not legal money. Add `app/(site)/landing` and `lib/landing` to the money-lint scanned dirs, with the pricing file as the one documented exception.

  - **Tests:** a render test (every section present in order, exact Sharma values, both rule IDs, the disclaimer, CTA href `/signin`, Talk-to-us href); money-lint over the landing dirs; a Playwright test: signed-out `/landing` returns 200 and the CTA reaches `/signin`.

  - **Non-goals:** billing/checkout, signup, analytics, a contact form, 3D, any change to `/` or the proxy.
- **Full (bonus, only if voice is on track on 26 Nov):** the meridian 3D hero, a pinned ladder and the dot-field. Disclose the meridian code in the README.
- **Best Startup:** landing-3d is the startup website for the Best Startup category (its URL goes in the Devpost website field).

## Cut
- `owner-voice-commands` (decided 13 Nov).
- **If late, shrink in this order:** landing Full → Lite, then guardrails down to the citation check only, then debtor-ui actions to the demo path only.
- **Never cut:** dashboard-ui, escalation-ladder, one voice call (on one laptop if the phone link is flaky), crew-app (thin)