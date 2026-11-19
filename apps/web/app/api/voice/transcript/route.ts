import { handleTranscript } from "@dues-banshee/voice";
import { z } from "zod";
import { handleVoiceRoute } from "@/lib/voice-route";

export const runtime = "nodejs";

// Non-strict, bounded. The handler cuts text to 2,000 characters; the body accepts more so a long
// line is cut, not refused, but not without limit.
const Body = z.object({
  voiceCallId: z.guid(),
  token: z.string().min(1).max(512),
  itemId: z.string().min(1).max(128),
  speaker: z.enum(["buyer", "agent"]),
  text: z.string().max(20_000),
});

/** Stores one Transcript_Line of a live call. */
export async function POST(req: Request): Promise<Response> {
  return handleVoiceRoute(req, Body, "voice transcript route", (db, body, now) =>
    handleTranscript({ db, now }, body),
  );
}
