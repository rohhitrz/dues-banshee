import { runCallTool } from "@dues-banshee/voice";
import { z } from "zod";
import { handleVoiceRoute } from "@/lib/voice-route";

export const runtime = "nodejs";

// Non-strict: extra fields (an invoice id, an amount limit) are dropped. Every field is bounded;
// an oversize body gets the same 404 as a call that does not match.
const Body = z.object({
  voiceCallId: z.guid(),
  token: z.string().min(1).max(512),
  callId: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  // Raw JSON string of the function call. May be empty for a tool without arguments.
  arguments: z.string().max(10_000),
});

/** Runs one Call_Tool for the buyer's browser. The Join_Token travels only in the body. */
export async function POST(req: Request): Promise<Response> {
  return handleVoiceRoute(req, Body, "voice tool route", (db, body, now) => runCallTool({ db, now }, body));
}
