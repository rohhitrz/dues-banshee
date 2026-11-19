import { describe, expect, it } from "vitest";
import { POST as end } from "@/app/api/voice/end/route";
import { POST as tool } from "@/app/api/voice/tool/route";
import { POST as transcript } from "@/app/api/voice/transcript/route";

const ID = "8f14e45f-ceea-467a-9575-1c1a2c3d4e5f";

function post(body: unknown): Request {
  return new Request("http://localhost/api/voice/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// Envelope failures never reach the database, so these run without DATABASE_URL.
describe("voice routes: envelope failures", () => {
  const cases: [string, (r: Request) => Promise<Response>, unknown][] = [
    ["tool: not JSON", tool, "not json"],
    ["tool: missing fields", tool, {}],
    ["tool: oversize arguments", tool, { voiceCallId: ID, token: "t", callId: "c", name: "n", arguments: "x".repeat(10_001) }],
    ["tool: oversize callId", tool, { voiceCallId: ID, token: "t", callId: "c".repeat(65), name: "n", arguments: "{}" }],
    ["transcript: bad speaker", transcript, { voiceCallId: ID, token: "t", itemId: "i", speaker: "owner", text: "hi" }],
    ["transcript: oversize itemId", transcript, { voiceCallId: ID, token: "t", itemId: "i".repeat(129), speaker: "buyer", text: "hi" }],
    ["transcript: oversize text", transcript, { voiceCallId: ID, token: "t", itemId: "i", speaker: "buyer", text: "x".repeat(20_001) }],
    ["end: id is not a uuid", end, { voiceCallId: "nope", token: "t" }],
    ["end: oversize token", end, { voiceCallId: ID, token: "t".repeat(513) }],
  ];

  it.each(cases)("%s → 404 not_found, no-store", async (_name, route, body) => {
    const res = await route(post(body));
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
