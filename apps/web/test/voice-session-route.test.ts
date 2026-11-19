import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Review fix, buyer-voice-call: a join that ends the call as `incomplete` (key mint failed) refreshes the
// Debtor_Page like the other voice routes. The handler is mocked: this test is about the route's revalidation.
const mocks = vi.hoisted(() => ({
  handleSession: undefined as unknown as ReturnType<typeof vi.fn>,
  revalidatePath: undefined as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({ db: { sentinel: "db" }, close: async () => {} }) }));
vi.mock("next/cache", () => {
  mocks.revalidatePath = vi.fn();
  return { revalidatePath: mocks.revalidatePath };
});
vi.mock("@dues-banshee/voice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dues-banshee/voice")>();
  mocks.handleSession = vi.fn();
  return { ...actual, handleSession: mocks.handleSession };
});
import { POST } from "@/app/api/voice/session/route";
const BUYER_ID = "8f14e45f-ceea-467a-9575-1c1a2c3d4e5f";
const post = (): Request =>
  new Request("http://localhost/api/voice/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "join-token" }),
  });
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real");
  mocks.revalidatePath.mockReset();
  mocks.handleSession.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
});
describe("POST /api/voice/session: revalidation", () => {
  it("revalidates / and the debtor page when the mint failure ended the call", async () => {
    mocks.handleSession.mockResolvedValue({
      status: 502,
      body: { error: "start_failed" },
      revalidateBuyerId: BUYER_ID,
    });
    const res = await POST(post());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "start_failed" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.revalidatePath.mock.calls).toEqual([["/"], [`/debtors/${BUYER_ID}`]]);
  });
  it("revalidates nothing when the handler changed nothing", async () => {
    mocks.handleSession.mockResolvedValue({ status: 404, body: { error: "expired" } });
    const res = await POST(post());
    expect(res.status).toBe(404);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
  it("still answers when the cache purge throws", async () => {
    mocks.handleSession.mockResolvedValue({
      status: 502,
      body: { error: "start_failed" },
      revalidateBuyerId: BUYER_ID,
    });
    mocks.revalidatePath.mockImplementation(() => {
      throw new Error("purge failed");
    });
    const res = await POST(post());
    expect(res.status).toBe(502);
  });
});
