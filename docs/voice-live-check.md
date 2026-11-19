# Voice live check

Manual check of the buyer voice call (spec `buyer-voice-call`, Requirement 11.12, task 6.5). It is not part of the test suite or CI. It also serves as the day-1 Hinglish smoke test of `gpt-live-transcribe`.

You run this on one laptop. The call is a real OpenAI Realtime session and costs a few cents. Local dev and Vercel share the same Neon database, so the call rows, the promise and the transcript land in that shared database.

## 1. Apply the migration (do this first)

From the repo root:

```sh
set -a; source apps/web/.env.local; set +a
pnpm --filter ./packages/db db:migrate
```

This applies `0005_buyer_voice_call` to Neon. Without it the start-call action and the call routes fail on missing tables.

## 2. Set up and start

1. Put your key in `apps/web/.env.local` as `OPENAI_API_KEY=...`. Never commit this file.
2. Optional: set `VOICE_REALTIME_MODEL=gpt-realtime-2.1` in the same file to use the full model. Any other value, or none, uses `gpt-realtime-2.1-mini`.
3. Start the app from the repo root: `pnpm --filter web dev`. Restart it after editing `.env.local`.
4. Open `http://localhost:3000/signin` and click "Enter the graveyard (demo)".
5. Open Sharma Traders from the graveyard, then add `?today=2026-11-12` to the URL. The invoice is `LPC/26-27/0412`.

## 3. Run the call

1. In the invoice panel, click "Start call". The demo supplier has no call-hours limit.
2. Click "Open call here". The call page opens in a new tab.
3. Click "Join call" and allow the microphone.
4. Speak Hinglish as the buyer. Ask about the amount, then promise a date, for example "agle Friday tak de dunga". At `2026-11-12` (a Thursday) that is Friday, 20 November 2026.
5. Answer "haan" when the agent reads the amount and date back. Let the agent end the call, or click "Hang up".
6. Reload the debtor page (keep `?today=2026-11-12`).

## 4. What to confirm

- **Disclosure first.** The agent opens by saying it is an AI assistant calling for the supplier, and says "yeh call record aur transcribe ho rahi hai", before talking about the invoice.
- **Facts match the page.** The figures the agent speaks, in words, match the invoice panel: principal ₹4,12,000, due 17 Oct 2026, 26 days late, interest ₹5,127.94 (512794 paise), total ₹4,17,127.94 (41712794 paise), tax-bomb date 31 Mar 2027 with 139 days left.
- **Read-back.** The agent reads the amount in rupees, in words (never digits, the rupee symbol or "dollars"), and the date with its weekday exactly as the Date_List writes it ("Friday, 20 November 2026").
- **Clear yes.** The agent calls `record_promise_to_pay` only after you say a clear yes ("haan", "ji", "ok", "theek hai"). A vague answer such as "shayad" must get one more question, not a recording. If it records before a clear yes, mark this item as failed.
- **Promise on the Candle_Timeline.** After the reload, the timeline shows "Promised ₹4,17,127.94 by 20 Nov 2026" (or the amount you gave), and the invoice panel shows "Promise to pay active until 20 Nov 2026". The "(by voice)" suffix and the call entry are task 7 and are not expected yet.
- **Next Ladder_Run pauses.** With the dev server still running, in the shell where you sourced `.env.local`:

  ```sh
  curl -s -X POST -H "Authorization: Bearer $LADDER_RUN_SECRET" "http://localhost:3000/api/ladder/run?today=2026-11-12"
  ```

  In the JSON, Sharma's invoice shows `{"kind":"wait","reason":"promise_active"}` and no draft. This run covers every supplier in Neon and may draft messages for other invoices (it needs `ANTHROPIC_API_KEY`). If you only want the pause shown, skip this run and check the Approvals page for no new Sharma draft.
- **Transcript_Lines stored.** The debtor page does not show transcripts until task 7. Check the database (Neon SQL editor, or `psql "$DATABASE_URL"`):

  ```sql
  select status, outcome, duration_seconds from voice_calls order by created_at desc limit 1;
  select speaker, text from voice_transcript_lines
   where voice_call_id = (select id from voice_calls order by created_at desc limit 1)
   order by received_at;
  ```

  Expect `status = ended`, `outcome = promise`, and lines from both `agent` and `buyer`.

## 5. Record the result

Fill this in after the run.

| Field | Result |
|---|---|
| Date of the run | 19 Nov 2026 |
| Realtime_Model used | `gpt-realtime-2.1` (`VOICE_REALTIME_MODEL` is set to exactly this in `apps/web/.env.local`) |
| Transcription config | `languages: ["hi", "en"]` plus `keywords` ("haan", "nahi", "ji", "agle", "lakh", "hazaar", "rupaye", "paisa", "Friday", "Sharma ji"). Decision below. |
| Observed Hinglish quality | Amounts and dates are spoken correctly in words after the words-only facts change. Early runs had mid-sentence restarts; far-field noise reduction and `eagerness: "high"` fixed them. The "(Demo)" fumble in the opening is fixed by dropping the trailing parenthetical from the spoken supplier name. Buyer transcript lines come out in Devanagari. |

| Check | Pass / fail | Notes |
|---|---|---|
| Disclosure line first | Pass | |
| `get_invoice_facts` figures match the page | Pass | 26 days late; total "four lakh seventeen thousand one hundred twenty-seven rupees and ninety-four paise". |
| Read-back of amount (words) and weekday + date | Pass | |
| Clear yes before `record_promise_to_pay` | Pass | |
| Promise on the Candle_Timeline after reload | Pass | The page shows "Promise to pay active until 13 Nov 2026" and "Waiting: Promise to pay active". |
| Next Ladder_Run pauses (`promise_active`) | Pass | Checked through the invoice panel. The `curl` ladder run was skipped. |
| Transcript_Lines stored | Pass | |

Decision on transcription language (leave unset / set `language` / add `prompt`): keep `languages: ["hi", "en"]` and the `keywords`; set no single `language` and add no `prompt`. Buyer lines come out in Devanagari, which is acceptable.

## Troubleshooting

- **"Voice calls not configured", button disabled.** `OPENAI_API_KEY` is empty. Set it in `apps/web/.env.local` and restart the dev server.
- **"Microphone access is needed for the call".** The browser blocked the mic. Allow it in the site settings and tap "Join call" again. The link is not used up by a mic failure, so you can retry until it expires.
- **"This call link has expired or was already used".** The link works once and for 10 minutes. Once you tap "Join call" with the mic allowed, it is used. Starting a new call also expires any earlier unused link for that buyer. Click "Start call" again for a fresh link.
- **"The call could not start. Please try again later."** The key is missing or OpenAI refused the session request. That call is closed as `incomplete`, so start a new call. Check the dev server log for the error.
- **The call ends by itself after about 5 minutes.** The cap is 300 seconds from joining; the countdown on the call page shows the time left. A tool request after the cap returns `call_time_up` and ends the call.
- **"Demo call limit reached for today".** The demo supplier is capped at 20 calls per day.
