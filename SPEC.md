# Dues Banshee — Lean Spec (Kiroween 2026)

> An AI collections agent for Indian MSME suppliers. It chases unpaid invoices from buyers and uses Indian payment law as leverage instead of just sending reminders.
> **Category:** Frankenstein · **Bonus targets:** Best Startup Project, Best Kiro Crew App, Best Demo, Blog, Social Blitz
> **Deadline:** Fri 4 Dec 2026, 2:00 PM PT (**Sat 5 Dec, 3:30 AM IST**) · aim to submit Fri 4 Dec evening IST

---

## 1. The problem, in one line
About ₹8.1 lakh crore owed to MSMEs is stuck in delayed payments. Small suppliers chase dues with awkward phone calls and don't push hard because they're afraid of losing the customer.

## 2. The twist (headline feature)
**The "tax bomb" countdown.** If a buyer hasn't paid a micro or small supplier by 31 March, the buyer can't claim that purchase as an expense that year (s.43B(h), now s.37(2)(g) of the Income-tax Act 2025). Every reminder leads with what the *buyer* loses: "₹4.12L of deductions at risk, 139 days left". The message is no longer the supplier asking for a favour; paying is in the buyer's own interest.

## 3. Users
- **Primary:** owner of a small distributor, trader or job-work unit (Tier 2/3 India, Hindi-first, WhatsApp-native).
- **Secondary:** CA firms running collections for many MSME clients (the distribution channel).

## 4. Key decisions (+ why)
| Decision | Why |
|---|---|
| **All TypeScript** (Next.js + Node) | One language solo. meridian UI code is TS. Crew app UI is React/TS. fast-check for property-based tests (PBT) |
| **Monorepo:** `apps/web`, `packages/engine`, `packages/agent`, `packages/voice` | Keeps the legal engine as pure functions, which suits PBT and lets the engine be reused by the Crew app |
| **Crew app in a separate repo** (`dues-banshee-crew`) | Required by the rules for the Best Kiro Crew App bonus (same GitHub account) |
| **Text LLM: Claude Haiku 5.5 by default, Sonnet 5.5 for legal wording, GPT-5.6 Luna as fallback** (all via Vercel AI SDK, direct API keys) | Cheapest capable models; uses Anthropic + OpenAI accounts already billed. No Bedrock/AWS setup |
| **Voice: OpenAI `gpt-realtime-2.1-mini`** (speech-to-speech with tool calls, WebRTC in the browser) | One model instead of three services chained together. Already billed. About ₹2–3 a minute. Older OpenAI TTS models are retired 6 Jan 2027, during judging |
| **`VoiceProvider` interface, Sarvam as fallback** | If the week-1 Hinglish test is weak, swap in Saaras + Bulbul without rewriting |
| **Real calls to Indian numbers are out of scope** | They need an India-registered business, KYC, the debtor's consent and TRAI compliance. Calls are in the browser; PSTN is roadmap |
| **WhatsApp: Meta Cloud API test number**, plus Crew's built-in WhatsApp channel for owner commands | Test number works immediately with a few verified recipients. Enough for the demo |
| **Payments: Razorpay payment links, test mode** | Real UPI flow, no money moves |
| **DB: Postgres (Neon) + Drizzle** | Free tier, serverless, typed |
| **Deploy: Vercel** | App must stay live and free for judges until 29 Jan 2027 |
| **Human approval required** for calls, notices and Samadhaan packs | Safety, legal tone, and a good point for judges |
| **Reuse from meridian:** Stage, SceneCanvas, NOISE_GLSL, motion helpers, DotField, Reveals | Saves time on the cinematic landing page. **Disclose in README** ("adapted from my meridian-cinematic-landing") |
| **UI mockups in `design/`** (made with Claude) | Kiro implements them through specs; noted in the write-up |

## 5. Scope (MVP)
**A. Ledger + legal engine** (`packages/engine`, pure functions)
- Import invoices from CSV, Google Sheet or a Tally CSV export
- Per invoice: legal due date (15 days, or up to 45 if agreed), statutory interest (3× RBI bank rate, compounded monthly), 31 March tax-bomb date and amount
- Bank rate comes from config, not hard-coded

**B. Escalation ladder** (`packages/agent`)
1. WhatsApp nudge → 2. WhatsApp + UPI link + tax reminder → 3. voice call (captures promise-to-pay) → 4. legal notice PDF → 5. MSME Samadhaan draft pack (pre-filled fields + checklist; the supplier files it on the portal)
- Daily scheduler decides each invoice's next step. A promise-to-pay pauses the ladder until that date

**C. Buyer-facing voice call** (`packages/voice`, gpt-realtime-2.1-mini)
- A Hindi/English agent "calls" the buyer in the browser (a friend plays Sharma ji in the demo)
- A tool call `record_promise {amount, date}` writes the promise-to-pay to the timeline

**D. 🎙️ Owner voice commands** (gpt-realtime-2.1-mini with tools)
- Mic button in the app + WhatsApp voice notes through the Crew channel
- Six tools: `summary` ("kitna baaki hai?"), `call_buyer`, `pause_buyer`, `send_pay_link`, `approve_step`, `status_of`
- Spoken + text reply. Outbound or irreversible actions need a spoken or tapped "haan, bhejo" confirmation

**E. Guardrails + evals**
- Every legal claim must cite a rule ID from `legal-rules.md` (blocked if missing)
- Tone check (no threats or abuse), call-hours check (10am–7pm), consent flag
- Eval fixtures: ~30 labelled messages/transcripts, run by a hook whenever prompts change (Haiku 5.5 as judge)

**F. UI** (from `design/`)
- Graveyard dashboard (Main), debtor séance screen (Debtor), cinematic landing page (Landing: 3D graveyard hero, pinned 5-step ladder, tax-bomb section, dot-field footer)

**G. Kiro Crew app** (separate repo)
- `app.json` providing: collector agent, `legal-notice` + `tax-bomb` skills, MCP servers (invoices, WhatsApp, Razorpay, PDF), daily 9 am cron, "Graveyard of Dues" dashboard page, WhatsApp voice-note commands

## 6. Non-goals
- ❌ Real calls to Indian phone numbers (roadmap: 140-series number, consent-gated)
- ❌ Live Tally integration (CSV export only)
- ❌ Filing on Samadhaan automatically (no API)
- ❌ Legal advice. Copy everywhere: "Reminders a supplier sends to its own buyers. Not legal advice."
- ❌ Multi-tenant billing (pricing shown on the landing page only)
- ❌ UK/EU jurisdiction packs beyond stub files (shown as roadmap)

## 7. Constraints
- Solo, ~3.5 weeks, 4,000 Kiro credits (expire 31 Dec) · Kiro: Opus 5.5 for specs, Sonnet 5.5 for tasks, Haiku 5.5 for hooks
- Runtime API budget: under $5 total (voice ≈ ₹2–3/min, text < $1)
- **New code only**, built after 30 Oct. Disclose any pre-existing code
- Public GitHub repo with an **OSI license** shown in the About section, **`/.kiro` at the root, never gitignored**
- Video < 3 min on YouTube; no copyrighted music
- App URL must stay free and working until 29 Jan 2027; judges' login goes in the Devpost form. Set API spend limits on both provider dashboards

## 8. Kiro usage plan (this is the "Technological Implementation" score)
- **Steering:** `product.md`, `tech.md`, `structure.md`, `legal-rules.md`, `voice-persona.md`, `ui-theme.md`
- **Specs (target 8–10):** legal-engine · ledger-import · escalation-ladder · whatsapp-channel · buyer-voice-call · owner-voice-commands · guardrails-evals · dashboard-ui · debtor-ui · landing-3d · crew-app
- **Hooks:** run PBT on `packages/engine/**` save · re-run evals when `prompts/**` change · lint + typecheck on save · regenerate rule-ID types when `legal-rules.md` changes
- **Custom agents:** `legal-reviewer` (checks claims against steering), `voice-tester`
- **MCP:** Context7 (library docs), Playwright (UI checks), plus your own invoices/Razorpay MCP servers
- **PBT (fast-check):** interest is never negative and always increases with time · deadline is never later than 45 days · the tax-bomb date is always the 31 March of the financial year · the escalation step never goes backwards and never advances while a promise is active · re-importing the same CSV doesn't create duplicates
- **Kiro surfaces used:** IDE (build), CLI (scripted runs), Crew (cron + app). Write down the differences for the write-up

## 9. Milestones
| Dates (IST) | Deliverable |
|---|---|
| **Nov 12–14** | Repo + license + `.kiro` steering · legal-engine spec + PBT green · **Hinglish voice test with gpt-realtime-2.1-mini** |
| **Nov 15–19** | Import + ledger + escalation ladder + WhatsApp test number + Razorpay test links |
| **Nov 20–23** | Buyer voice call + owner voice commands + guardrails/evals |
| **Nov 24–27** | Dashboard + séance screen (from `design/`) + deploy on Vercel |
| **Nov 28–30** | Crew app repo + landing page (3D hero, ported from meridian) + landing domain |
| **Dec 1–3** | Record video · Kiro write-up · README · blog post + #KiroweenHackathon26 posts (written by you) |
| **Dec 4 (evening IST)** | Submit. Buffer until 3:30 AM Dec 5 |

**Kiro credit budget:** ~10% specs/steering (Opus) · ~55% implementation (Sonnet) · ~15% Crew app + hooks (Haiku) · ~20% reserve for the last week.

## 10. Demo video (≤ 3 min)
1. 0:00–0:20 Problem + the 31 March rule (fog, graveyard hero)
2. 0:20–1:10 Owner sends a WhatsApp voice note: "Sharma ji ko call karo" → agent calls → Sharma ji promises Friday → promise appears on the timeline
3. 1:10–1:50 Razorpay test payment lands → tombstone "resurrects"
4. 1:50–2:30 Kiro: specs, hooks, PBT run, Crew cron dashboard
5. 2:30–2:55 Market + CA-firm channel + "Wake the banshee"

## 11. Open items
- [ ] Get the 4,000 Kiro hackathon credits applied (account still shows Free 0/50)
- [ ] Brand name final? (working: Dues Banshee) + landing domain
- [ ] Friend to play "Sharma ji" on camera
- [ ] Set monthly spend limits on Anthropic + OpenAI dashboards