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

### 5. buyer-voice-call — risky tier, Supervised, 2 reviews
- **Browser WebRTC** with OpenAI `gpt-realtime-2.1-mini`, behind the `VoiceProvider` interface. Sarvam is the fallback only.
- **Persona:** Hinglish, from `voice-persona.md`.
- **Tools mid-call:** `get_invoice_facts`, `record_promise_to_pay {amount, date}`.
- **Call log and transcript.** Calls only between 10am and 7pm. The owner starts each call. Switch on the "Start call" placeholder on the debtor page.
- **Carry-forward:** filter promise history by `recorded_on` in the db once promises are recorded for real.
- **Non-goals:** real phone (PSTN) calls; label them as roadmap.

- **Tests:** mock OpenAI Realtime in CI (no live calls); exact `toEqual` on promise amount and date (from engine output, never the model); call-hours check tests; one optional manual live call.

### 6. guardrails-evals — risky-lite tier, Supervised, 1 review
- Rule-ID citation check, tone check, call-hours check, about 15 labelled eval fixtures.
- Include a Hinglish tense fixture: drafts say "17 Oct 2026 ko due hai" for an overdue invoice.
- A Kiro hook re-runs the evals whenever `prompts/**` changes.

### 7. crew-app — separate repo `dues-banshee-crew`, Autopilot, 1 review
- **Thin:** Crew `app.json`, a daily 9am cron that calls the deployed API, a `tax-bomb` skill, a "Graveyard of Dues" dashboard page.
- Start as soon as the escalation API exists. **Never cut.**

### 8. landing-3d — UI tier, Autopilot, 1 review
- **Lite (default):** a static spooky hero, the 5-step ladder section, the tax-bomb section, Best Startup content (problem size, the CA-firm channel, a pricing table with prices TBD with Rohit, a roadmap: PSTN, Tally, auto-send WhatsApp), a CTA to the demo login.
- **Full (bonus, only if voice is on track on 26 Nov):** the meridian 3D hero, a pinned ladder and the dot-field. Disclose the meridian code in the README.

## Cut
- `owner-voice-commands` (decided 13 Nov).
- **If late, shrink in this order:** landing Full → Lite, then guardrails down to the citation check only, then debtor-ui actions to the demo path only.
- **Never cut:** dashboard-ui, escalation-ladder, one voice call, crew-app (thin).