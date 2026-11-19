// Session_Endpoint handler on a real in-memory Postgres (PGlite) with the Demo_Seed; OpenAI is a fakeHttp.
// Requirements: 2.4, 2.5, 3.1, 3.2 (body only), 3.3, 3.5, 10.2, 11.1, 11.7
import {
  createVoiceCall,
  findSupplierIdByUdyam,
  DEMO_SUPPLIER,
  invoices,
  seed,
  voiceCalls,
} from "@dues-banshee/db";
import { cloneTestDb, createTestDb, type TestDb } from "@dues-banshee/db/testing";
import { fakeClock, fakeHttp, type FakeHttp, type FakeResponseSpec } from "@dues-banshee/agent/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createOpenAiRealtime, generateJoinToken, handleSession, hashToken } from "../src/index";
import type { SessionResponse } from "../src/index";

const URL_SECRETS = "https://api.openai.com/v1/realtime/client_secrets";
const API_KEY = "sk-test-STANDARD-KEY-do-not-leak-0123456789";
const EPHEMERAL = "ek_test_EPHEMERAL_value_0123456789";
const SHARMA = "LPC/26-27/0412";
// 2026-11-12 10:30 IST.
const NOW = new Date("2026-11-12T05:00:00.000Z");
const TOKEN_TTL_MS = 600_000;
const OK: FakeResponseSpec = { json: { value: EPHEMERAL, expires_at: 1_800_000_060 } };

let template: TestDb;
const open: TestDb[] = [];

beforeAll(async () => {
  template = await createTestDb();
  await seed(template.db);
});
afterAll(async () => {
  await template.close();
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((t) => t.close()));
});

/** The Demo_Seed plus one `created` Voice_Call for Sharma Traders and the matching fake OpenAI. */
async function world(responses: FakeResponseSpec[]) {
  const t = await cloneTestDb(template);
  open.push(t);
  const supplierId = await findSupplierIdByUdyam(t.db, DEMO_SUPPLIER.udyamNumber);
  const sharma = (await t.db.select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber }).from(invoices)).find(
    (i) => i.invoiceNumber === SHARMA,
  );
  if (supplierId === null || sharma === undefined) throw new Error("test setup: demo seed missing");
  const token = generateJoinToken();
  const created = await createVoiceCall(t.db, {
    supplierId,
    invoiceId: sharma.id,
    callToday: "2026-11-12",
    tokenHash: hashToken(token),
    now: NOW,
  });
  if (created === null) throw new Error("test setup: createVoiceCall returned null");
  const clock = fakeClock();
  const http: FakeHttp = fakeHttp([{ method: "POST", url: URL_SECRETS, responses }], { clock });
  const provider = createOpenAiRealtime({
    fetch: http.fetch,
    apiKey: API_KEY,
    model: "gpt-realtime-2.1-mini",
    timeoutSignal: clock.timeoutSignal,
  });
  const join = (at: Date, withToken = token, apiKeyConfigured = true): Promise<SessionResponse> =>
    handleSession({ db: t.db, provider, now: at, apiKeyConfigured }, { token: withToken });
  const row = async () => {
    const r = (await t.db.select().from(voiceCalls)).find((c) => c.id === created.voiceCallId);
    if (r === undefined) throw new Error("test setup: voice call row missing");
    return r;
  };
  return { t, token, voiceCallId: created.voiceCallId, tokenExpiresAt: created.tokenExpiresAt, http, join, row };
}

const text = (response: SessionResponse): string => JSON.stringify(response);

describe("handleSession: successful join", () => {
  it("sets live once, mints one key and returns only the five fields", async () => {
    const w = await world([OK]);
    const response = await w.join(NOW);

    expect(response).toEqual({
      status: 200,
      body: {
        ephemeralKey: EPHEMERAL,
        expiresAt: 1_800_000_060,
        voiceCallId: w.voiceCallId,
        connectUrl: "https://api.openai.com/v1/realtime/calls",
        capEndsAt: "2026-11-12T05:05:00.000Z",
      },
    });
    expect(w.http.requests).toHaveLength(1);
    const req = w.http.requests[0]!;
    expect(req.headers["authorization"]).toBe(`Bearer ${API_KEY}`);
    expect((req.body as { expires_after: unknown }).expires_after).toEqual({ anchor: "created_at", seconds: 60 });
    expect((req.body as { session: { instructions: string } }).session.instructions).toContain(
      "Laxmi Precision Components (Demo)",
    );
    const row = await w.row();
    expect(row.status).toBe("live");
    expect(row.startedAt).toEqual(NOW);
    expect(row.endedAt).toBeNull();
  });

  it("puts the ephemeral key only in the ephemeralKey field and never returns the standard key", async () => {
    const w = await world([OK]);
    const response = await w.join(NOW);
    expect(response.status).toBe(200);
    const { ephemeralKey, ...rest } = response.body as { ephemeralKey: string };
    expect(ephemeralKey).toBe(EPHEMERAL);
    expect(JSON.stringify(rest)).not.toContain(EPHEMERAL);
    expect(text(response)).not.toContain(API_KEY);
  });

  it("accepts a join one millisecond before token_expires_at", async () => {
    const w = await world([OK]);
    const response = await w.join(new Date(w.tokenExpiresAt.getTime() - 1));
    expect(response.status).toBe(200);
  });
});

describe("handleSession: concurrent joins", () => {
  it("mints exactly one key and sets live once when two joins race on the same token", async () => {
    const w = await world([OK, OK]);
    const later = new Date(NOW.getTime() + 5_000);
    const responses = await Promise.all([w.join(NOW), w.join(later)]);

    expect(responses.map((r) => r.status).sort()).toEqual([200, 404]);
    expect(w.http.requests).toHaveLength(1);
    const winner = responses.find((r) => r.status === 200)!;
    const loser = responses.find((r) => r.status === 404)!;
    expect(loser.body).toEqual({ error: "expired" });
    expect(text(loser)).not.toContain(EPHEMERAL);

    // started_at was written once, by the winner, and not overwritten by the loser.
    const row = await w.row();
    const winnerStart = new Date((winner.body as { capEndsAt: string }).capEndsAt).getTime() - 300_000;
    expect(row.status).toBe("live");
    expect(row.startedAt?.getTime()).toBe(winnerStart);
  });

  it("mints exactly one key when five joins race", async () => {
    const w = await world([OK, OK, OK, OK, OK]);
    const responses = await Promise.all([0, 1, 2, 3, 4].map((i) => w.join(new Date(NOW.getTime() + i))));
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 404)).toHaveLength(4);
    expect(w.http.requests).toHaveLength(1);
  });
});

describe("handleSession: a token that cannot join", () => {
  it("returns 404 expired and mints nothing for a used token", async () => {
    const w = await world([OK, OK]);
    expect((await w.join(NOW)).status).toBe(200);
    const again = await w.join(new Date(NOW.getTime() + 1_000));
    expect(again).toEqual({ status: 404, body: { error: "expired" } });
    expect(w.http.requests).toHaveLength(1);
  });

  it("returns 404 expired and mints nothing exactly at token_expires_at", async () => {
    const w = await world([OK]);
    const response = await w.join(w.tokenExpiresAt);
    expect(w.tokenExpiresAt.getTime()).toBe(NOW.getTime() + TOKEN_TTL_MS);
    expect(response).toEqual({ status: 404, body: { error: "expired" } });
    expect(w.http.requests).toHaveLength(0);
    const row = await w.row();
    expect(row.status).toBe("created");
    expect(row.startedAt).toBeNull();
  });

  it("returns 404 expired and mints nothing after token_expires_at", async () => {
    const w = await world([OK]);
    const response = await w.join(new Date(w.tokenExpiresAt.getTime() + 60_000));
    expect(response).toEqual({ status: 404, body: { error: "expired" } });
    expect(w.http.requests).toHaveLength(0);
    expect((await w.row()).status).toBe("created");
  });

  it("returns 404 expired and mints nothing for an unknown token", async () => {
    const w = await world([OK]);
    const response = await w.join(NOW, generateJoinToken());
    expect(response).toEqual({ status: 404, body: { error: "expired" } });
    expect(w.http.requests).toHaveLength(0);
    expect((await w.row()).status).toBe("created");
  });

  it("returns 404 expired for an empty token", async () => {
    const w = await world([OK]);
    expect(await w.join(NOW, "")).toEqual({ status: 404, body: { error: "expired" } });
    expect(w.http.requests).toHaveLength(0);
  });

  it("returns 404 expired for a call that a newer link replaced (status expired)", async () => {
    const w = await world([OK]);
    await w.t.pglite.query(`UPDATE voice_calls SET status = 'expired' WHERE id = $1`, [w.voiceCallId]);
    expect(await w.join(NOW)).toEqual({ status: 404, body: { error: "expired" } });
    expect(w.http.requests).toHaveLength(0);
  });

  it("gives the same body for used, expired and unknown tokens", async () => {
    const w = await world([OK]);
    await w.join(NOW);
    const used = await w.join(NOW);
    const unknown = await w.join(NOW, generateJoinToken());
    const expired = await w.join(new Date(w.tokenExpiresAt.getTime() + 1), w.token);
    expect(text(used)).toBe(text(unknown));
    expect(text(used)).toBe(text(expired));
  });
});

describe("handleSession: the key is not configured", () => {
  it("returns 503 not_configured, mints nothing and leaves the row unchanged", async () => {
    const w = await world([OK]);
    const before = await w.row();
    const response = await w.join(NOW, w.token, false);

    expect(response).toEqual({ status: 503, body: { error: "not_configured" } });
    expect(w.http.requests).toHaveLength(0);
    const after = await w.row();
    expect(after).toEqual(before);
    expect(after.status).toBe("created");
    expect(after.startedAt).toBeNull();
  });

  it("lets the same token join once the key is configured", async () => {
    const w = await world([OK]);
    await w.join(NOW, w.token, false);
    expect((await w.join(NOW)).status).toBe(200);
  });
});

describe("handleSession: the mint fails", () => {
  const failures: [string, FakeResponseSpec][] = [
    ["a non-2xx status", { status: 500, json: { error: { message: `boom ${API_KEY} ${EPHEMERAL}` } } }],
    ["a 401 from OpenAI", { status: 401, json: { error: { message: `bad key ${API_KEY}` } } }],
    ["a network error", { throws: "network" }],
    ["a timeout", { throws: "timeout" }],
    ["a body that is not JSON", { text: `<html>${API_KEY}</html>` }],
    ["a body without the key value", { json: { expires_at: 1 } }],
    ["a body with a bad expiry", { json: { value: EPHEMERAL, expires_at: "soon" } }],
  ];

  it.each(failures)("ends the call as incomplete and returns 502 for %s", async (_label, failure) => {
    const w = await world([failure]);
    const response = await w.join(new Date(NOW.getTime() + 2_000));

    expect(response).toEqual({ status: 502, body: { error: "start_failed" } });
    expect(w.http.requests).toHaveLength(1);
    const row = await w.row();
    expect(row.status).toBe("ended");
    expect(row.outcome).toBe("incomplete");
    expect(row.startedAt).toEqual(new Date(NOW.getTime() + 2_000));
    expect(row.endedAt).toEqual(new Date(NOW.getTime() + 2_000));
    expect(row.durationSeconds).toBe(0);
    expect(text(response)).not.toContain(API_KEY);
    expect(text(response)).not.toContain(EPHEMERAL);
  });

  it("returns 502 and ends the call when the mint times out on the fake clock (10 s)", async () => {
    const w = await world([{ delayMs: 10_001, json: { value: EPHEMERAL, expires_at: 1 } }]);
    const response = await w.join(NOW);
    expect(response).toEqual({ status: 502, body: { error: "start_failed" } });
    expect((await w.row()).outcome).toBe("incomplete");
  });

  it("does not let the same token join again after a failed mint", async () => {
    const w = await world([{ status: 500, json: {} }, OK]);
    expect((await w.join(NOW)).status).toBe(502);
    expect(await w.join(NOW)).toEqual({ status: 404, body: { error: "expired" } });
    expect(w.http.requests).toHaveLength(1);
  });
});

describe("handleSession: secrets", () => {
  it("returns no response containing the standard key, in any scenario", async () => {
    const scenarios: FakeResponseSpec[] = [
      OK,
      { status: 500, json: { error: API_KEY } },
      { throws: "network" },
      { text: API_KEY },
    ];
    for (const scenario of scenarios) {
      const w = await world([scenario]);
      const responses = [await w.join(NOW), await w.join(NOW), await w.join(NOW, "nope"), await w.join(NOW, w.token, false)];
      for (const response of responses) expect(text(response)).not.toContain(API_KEY);
    }
  });
});
