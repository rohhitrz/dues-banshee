# Roadmap — Dues Banshee (Kiro steering file)

> Holds every remaining spec's scope, so a spec prompt to Kiro is only 2 lines:
> `Create spec <name> (requirements-first, lean) per .kiro/steering/roadmap.md section <name>. Write only .kiro/specs/<name>/. Stop after requirements.md.`
> Decided 2026-11-13. Where this conflicts with older spec text, this file wins.

## Global rules (every spec)
- Engine output is the single source of truth for legal and money values. The UI never recomputes them.
- Every amount is shown with `formatINR`. Tests use exact values (demo seed at today = 2026-11-12: Sharma Traders, 26 days late, 512794 paise of interest, tax bomb 139 days).
- No outbound action (message, call, notice) without the owner's confirmation.
- Every legal claim cites a rule ID from `legal-rules.md`.
- Copy everywhere: "Reminders a supplier sends to its own buyers. Not legal advice."
- Lean specs. Tests are never optional.

## Demo spine (build this path first, then widen it)
Sharma Traders tombstone → escalation draft approved by the owner → WhatsApp nudge with a Razorpay test link lands on a phone → buyer voice call in Hinglish → `promise_to_pay` appears on the timeline → test payment → the tombstone resurrects.

## Specs in build order

### 1. dashboard-ui — UI tier, Autopilot, 1 review (DONE)
- Owns `/` (signed out → `/signin`). The graveyard home matches the "Main" frame in `/design`.
- Not built here, moved to debtor-ui / polish: tombstone → `/debtors/[id]` link, 5,000-invoice scale (top-N + list view), Playwright smoke test.

### 2. escalation-ladder — risky tier, Supervised, 2 reviews
- The daily step decision comes from the engine's next step (`nextEscalationStep`). A promise-to-pay pauses the ladder until its date. No ladder logic re-written outside the engine.
- **LLM drafts** (Vercel AI SDK: Haiku by default, Sonnet for legal wording, GPT-5.6 Luna fallback; model IDs only in `models.ts`) in Hinglish or English. They must cite rule IDs from `legal-rules.md`, validated against the real rule list; a draft is blocked if one is missing or invalid.
- Money and dates in drafts come from engine output via `formatINR`, never from the LLM. Buyer names and invoice numbers are untrusted text inside prompts.
- Add a `legal-rules.md` rule ID for MSMED s.2(b) before any draft says acceptance = delivery.
- **Owner approval queue:** approve, edit or reject. Every action goes into `escalation_events`, scoped by the session supplierId only. Stale session (missing supplier) is handled like dashboard-ui, never a 500.
- **Steps 4–5** (legal notice, Samadhaan pack) produce downloadable drafts for the owner. Keep them minimal.
- **Tests:** mock the model in CI (no live API calls), plus at least one test through the real AI SDK wrapper; exact `toEqual` on rule IDs, money and dates. One optional manual live check.
- **Non-goals:** actually sending (whatsapp-channel), calling (buyer-voice-call), dashboard changes (it stays read-only).

### 3. debtor-ui — UI tier, Autopilot, 1 review
- **One screen, `/debtors/[id]`:**
  - a candle timeline of invoices, ladder events, promises and payments
  - pending approvals
  - action buttons (approve draft, send pay link, start call), wired up as those specs land
- Make dashboard tombstones link here.
- **Non-goals:** editing invoices, more screens.

### 4. whatsapp-channel — risky tier, Supervised, 1 review
- **Outbound only:** an approved template plus a Razorpay test payment link, sent only after owner approval, only to verified test numbers.
- **Razorpay "payment link paid" webhook** → invoice marked paid → the tombstone resurrects.
- **Inbound replies:** log only, no logic.
- Submit templates at the start of the spec, because Meta approval takes time.

### 5. buyer-voice-call — risky tier, Supervised, 2 reviews
- **Browser WebRTC** with OpenAI `gpt-realtime-2.1-mini`, behind the `VoiceProvider` interface. Sarvam is the fallback only.
- **Persona:** Hinglish, from `voice-persona.md`.
- **Tools mid-call:** `get_invoice_facts`, `record_promise_to_pay {amount, date}`.
- **Call log and transcript.** Calls only between 10am and 7pm. The owner starts each call.
- **Non-goals:** real phone (PSTN) calls; label them as roadmap.

### 6. guardrails-evals — risky-lite tier, Supervised, 1 review
- Rule-ID citation check, tone check, call-hours check, about 15 labelled eval fixtures.
- A Kiro hook re-runs the evals whenever `prompts/**` changes.

### 7. crew-app — separate repo `dues-banshee-crew`, Autopilot, 1 review
- **Thin:**
  - Crew `app.json`
  - a daily 9am cron that calls the deployed API
  - a `tax-bomb` skill
  - a "Graveyard of Dues" dashboard page
- Start as soon as the escalation API exists. **Never cut.**

### 8. landing-3d — UI tier, Autopilot, 1 review
- **Lite (default):**
  - a static spooky hero
  - the 5-step ladder section
  - the tax-bomb section
  - Best Startup content: problem size, the CA-firm channel, a pricing table (prices TBD with Rohit), a roadmap (PSTN, Tally)
  - a CTA to the demo login
- **Full (bonus, only if voice is on track on 26 Nov):** the meridian 3D hero, a pinned ladder and the dot-field. Disclose the meridian code in the README.

## Cut
- `owner-voice-commands` (decided 13 Nov).
- **If late, shrink in this order:** landing Full → Lite, then guardrails down to the citation check only, then debtor-ui actions to the demo path only.
- **Never cut:** dashboard-ui, escalation-ladder, one voice call, crew-app (thin).
