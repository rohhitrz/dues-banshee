// Feature: whatsapp-channel, Property 8: Channel_Env reader
// Validates: Requirements 3.4, 8.4
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readChannelEnv } from "../src/channel/env";

/** One env variable as generated: what is stored, and the trimmed value if it is a usable one. */
interface Gen {
  raw: string | undefined;
  /** Set and well-formed (trimmed). `undefined` for missing, blank and malformed values. */
  usable: string | undefined;
  /** Not missing and not blank, whether or not it is well-formed. */
  set: boolean;
}

const arbBlank = fc.constantFrom("", " ", "   ", "\t", "\n", " \t\n ");
const arbPad = fc.constantFrom("", " ", "\t", "\n  ");

/** Missing, blank, valid, valid with padding, and (when given) malformed values. */
function arbVar(valid: fc.Arbitrary<string>, malformed?: fc.Arbitrary<string>): fc.Arbitrary<Gen> {
  const choices: fc.Arbitrary<Gen>[] = [
    fc.constant<Gen>({ raw: undefined, usable: undefined, set: false }),
    arbBlank.map<Gen>((raw) => ({ raw, usable: undefined, set: false })),
    valid.map<Gen>((v) => ({ raw: v, usable: v, set: true })),
    fc.tuple(arbPad, valid, arbPad).map<Gen>(([a, v, b]) => ({ raw: `${a}${v}${b}`, usable: v, set: true })),
  ];
  if (malformed) choices.push(malformed.map<Gen>((raw) => ({ raw, usable: undefined, set: true })));
  return fc.oneof(...choices);
}

const word = fc.stringMatching(/^[A-Za-z0-9_]{1,24}$/);
const arbE164 = fc
  .tuple(fc.integer({ min: 1, max: 9 }), fc.stringMatching(/^[0-9]{7,14}$/))
  .map(([first, rest]) => `+${first}${rest}`);
const arbBadFrom = fc.oneof(
  arbE164.map((n) => `whatsapp:${n}`),
  arbE164.map((n) => n.slice(1)),
  arbE164.map((n) => `${n.slice(0, 3)} ${n.slice(3)}`),
  fc.constantFrom("+0123456789", "+12345", "+1234567890123456", "abc"),
);
const arbTestKeyId = word.map((w) => `rzp_test_${w}`);
const arbBadKeyId = fc.oneof(word.map((w) => `rzp_live_${w}`), word.filter((w) => !w.startsWith("rzp_test_")));
const arbBaseUrl = fc
  .tuple(fc.stringMatching(/^[a-z]{1,10}$/), fc.constantFrom("", "/", "//", "/app"))
  .map(([host, tail]) => `https://${host}.example${tail}`);

const arbScenario = fc.record({
  sid: arbVar(word.map((w) => `AC${w}`)),
  token: arbVar(word),
  from: arbVar(arbE164, arbBadFrom),
  keyId: arbVar(arbTestKeyId, arbBadKeyId),
  keySecret: arbVar(word),
  webhookSecret: arbVar(word),
  baseUrl: arbVar(arbBaseUrl),
  joinCode: arbVar(word),
});

type Scenario = typeof arbScenario extends fc.Arbitrary<infer T> ? T : never;

function envOf(s: Scenario): Record<string, string | undefined> {
  const entries: [string, string | undefined][] = [
    ["TWILIO_ACCOUNT_SID", s.sid.raw],
    ["TWILIO_AUTH_TOKEN", s.token.raw],
    ["TWILIO_WHATSAPP_FROM", s.from.raw],
    ["RAZORPAY_KEY_ID", s.keyId.raw],
    ["RAZORPAY_KEY_SECRET", s.keySecret.raw],
    ["RAZORPAY_WEBHOOK_SECRET", s.webhookSecret.raw],
    ["PUBLIC_BASE_URL", s.baseUrl.raw],
    ["TWILIO_SANDBOX_JOIN_CODE", s.joinCode.raw],
  ];
  // A missing variable is absent from the map, as in process.env.
  return Object.fromEntries(entries.filter(([, v]) => v !== undefined));
}

describe("Property 8: Channel_Env reader", () => {
  it("switches each group on only for complete, well-formed values and treats the rest as unset", () => {
    fc.assert(
      fc.property(arbScenario, (s) => {
        const env = readChannelEnv(envOf(s));

        const twilioOn = s.sid.usable !== undefined && s.token.usable !== undefined && s.from.usable !== undefined;
        expect(env.twilio).toEqual(
          twilioOn ? { accountSid: s.sid.usable, authToken: s.token.usable, from: s.from.usable } : null,
        );

        const razorpayOn = s.keyId.usable !== undefined && s.keySecret.usable !== undefined;
        expect(env.razorpay).toEqual(razorpayOn ? { keyId: s.keyId.usable, keySecret: s.keySecret.usable } : null);

        // Every other field is unset iff its value is missing or blank.
        expect(env.twilioAuthToken).toEqual(s.token.usable);
        expect(env.razorpayWebhookSecret).toEqual(s.webhookSecret.usable);
        expect(env.sandboxJoinCode).toEqual(s.joinCode.usable);
        expect(env.publicBaseUrl).toEqual(s.baseUrl.usable?.replace(/\/+$/, ""));
        if (env.publicBaseUrl !== undefined) expect(env.publicBaseUrl.endsWith("/")).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it("reads only the map it is given and does not change it", () => {
    fc.assert(
      fc.property(arbScenario, (s) => {
        const map = envOf(s);
        const before = { ...map };
        expect(readChannelEnv(map)).toEqual(readChannelEnv({ ...map }));
        expect(map).toEqual(before);
      }),
      { numRuns: 100 },
    );
  });
});

describe("readChannelEnv examples", () => {
  it("is all unset for an empty map", () => {
    expect(readChannelEnv({})).toEqual({
      twilio: null,
      twilioAuthToken: undefined,
      razorpay: null,
      razorpayWebhookSecret: undefined,
      publicBaseUrl: undefined,
      sandboxJoinCode: undefined,
    });
  });

  it("treats a whatsapp:-prefixed sender and a live key id as unset", () => {
    const env = readChannelEnv({
      TWILIO_ACCOUNT_SID: "ACtest",
      TWILIO_AUTH_TOKEN: "token",
      TWILIO_WHATSAPP_FROM: "whatsapp:+14155550100",
      RAZORPAY_KEY_ID: "rzp_live_abc",
      RAZORPAY_KEY_SECRET: "secret",
    });
    expect(env.twilio).toBeNull();
    expect(env.razorpay).toBeNull();
    expect(env.twilioAuthToken).toBe("token");
  });

  it("strips a trailing slash from PUBLIC_BASE_URL", () => {
    expect(readChannelEnv({ PUBLIC_BASE_URL: "https://dues.example/" }).publicBaseUrl).toBe("https://dues.example");
  });
});
