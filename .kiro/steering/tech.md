---
inclusion: always
---
# Tech

- **Language:** TypeScript everywhere (strict). Node 20+.
- **Web:** Next.js (latest stable) App Router, React 19, CSS Modules. three.js + GSAP only on the landing page (lazy-loaded, poster fallback, respects prefers-reduced-motion).
- **Data:** Postgres (Neon) + Drizzle ORM. Money as integer paise, never floats.
- **LLM (text):** Vercel AI SDK with direct provider keys, no Bedrock.
  - Default: Claude Haiku 5.5 (`@ai-sdk/anthropic`): escalation decisions, intent routing, guardrail checks.
  - Careful writing: Claude Sonnet 5.5: legal notices, WhatsApp message drafts.
  - Fallback: OpenAI GPT-5.6 Luna (`@ai-sdk/openai`) when Claude errors or rate-limits.
  - Structured outputs with Zod. Model IDs live in one `models.ts` config, never inline.
- **Voice:** OpenAI Realtime API, `gpt-realtime-2.1-mini` (speech-to-speech, tool calling), over WebRTC from the browser with an ephemeral session token minted server-side.
  - Behind a `VoiceProvider` interface so Sarvam (Saaras STT + Bulbul TTS) can be swapped in if Hinglish quality is poor.
  - Do NOT use tts-1, tts-1-hd or gpt-4o-mini-tts: scheduled for removal 6 Jan 2027 (during judging).
- **Messaging:** WhatsApp Cloud API (test number). **Payments:** Razorpay payment links (test mode). **PDF:** @react-pdf/renderer.
- **Tests:** Vitest for unit tests; **fast-check** for property-based tests on `packages/engine`. Eval fixtures in `evals/` run with a small script.
- **Deploy:** Vercel. Secrets only in env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …); never commit `.env`.

## Rules
- `packages/engine` is pure: no I/O, no Date.now() (inject `today`).
- All dates in IST; the financial year runs 1 Apr – 31 Mar.
- Indian number formatting (₹4,12,000; ₹4.12L) through one `formatINR` helper.
- Every agent tool call is logged with inputs and outputs, for the timeline and for evals.
- The voice model calls the same backend tools as the text agent; it never sends WhatsApp, calls or notices without the owner's confirmation.