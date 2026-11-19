import { handleEnd } from "@dues-banshee/voice";
import { z } from "zod";
import { handleVoiceRoute } from "@/lib/voice-route";

export const runtime = "nodejs";

// Non-strict: a client-sent outcome (or anything else) is dropped; the server computes the outcome.
const Body = z.object({
  voiceCallId: z.guid(),
  token: z.string().min(1).max(512),
});

/** The End_Report: the buyer's browser says the call is over. */
export async function POST(req: Request): Promise<Response> {
  return handleVoiceRoute(req, Body, "voice end route", (db, body, now) => handleEnd({ db, now }, body));
}
