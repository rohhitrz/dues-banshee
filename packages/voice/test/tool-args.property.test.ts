// Feature: buyer-voice-call, Property 9: Tool argument parsing never throws
// **Validates: Requirements 5.5**
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CALL_TOOLS, parseToolArgs } from "../src/tool-schemas";

const TOOL_NAMES = ["get_invoice_facts", "record_promise_to_pay", "end_call"];
const OUTCOMES = ["dispute", "no_promise", "consent_declined"];

// Independent oracle: hand-written shape checks, no Zod.
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function oracleValid(name: string, json: unknown): boolean {
  if (!isPlainObject(json)) return false;
  const keys = Object.keys(json).sort();
  switch (name) {
    case "get_invoice_facts":
      return keys.length === 0;
    case "record_promise_to_pay": {
      if (keys.join(",") !== "amount_paise,date_iso,spoken_text") return false;
      const { amount_paise: amount, date_iso: date, spoken_text: spoken } = json;
      return (
        typeof amount === "number" &&
        Number.isSafeInteger(amount) &&
        typeof date === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(date) &&
        typeof spoken === "string" &&
        spoken.length >= 1 &&
        spoken.length <= 2000
      );
    }
    case "end_call":
      return keys.join(",") === "outcome" && typeof json.outcome === "string" && OUTCOMES.includes(json.outcome);
    default:
      return false;
  }
}

function oracle(name: string, raw: string): "unknown_tool" | "invalid_arguments" | "ok" {
  if (!TOOL_NAMES.includes(name)) return "unknown_tool";
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return "invalid_arguments";
  }
  return oracleValid(name, json) ? "ok" : "invalid_arguments";
}

const toolName = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...TOOL_NAMES) },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      "toString",
      "__proto__",
      "constructor",
      "hasOwnProperty",
      "valueOf",
      "isPrototypeOf",
      "__defineGetter__",
      "",
      "GET_INVOICE_FACTS",
      "end_call ",
      "get_invoice_facts\n",
    ),
  },
  { weight: 1, arbitrary: fc.string() },
);

const validPromise = fc.record({
  amount_paise: fc.integer({ min: -1000, max: 1_000_000_000_000 }),
  date_iso: fc.oneof(
    fc.constantFrom("2026-11-12", "2026-13-45", "0000-00-00"),
    fc.tuple(fc.nat(9999), fc.nat(99), fc.nat(99)).map(([y, m, d]) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`),
  ),
  spoken_text: fc.oneof(fc.string({ maxLength: 20 }), fc.constant(""), fc.constant("x".repeat(2000)), fc.constant("x".repeat(2001))),
});

const rawArguments = fc.oneof(
  fc.string(),
  fc.json(),
  fc.jsonValue().map((v) => JSON.stringify(v)),
  fc.constantFrom("", "{}", "[]", "null", "true", "0", '""', '{"__proto__":{}}', '{"__proto__":1}', '{"toString":1}', '{"constructor":{}}', "{", "NaN", "undefined"),
  fc.constantFrom(...OUTCOMES).map((outcome) => JSON.stringify({ outcome })),
  fc.constantFrom(...OUTCOMES).map((outcome) => JSON.stringify({ outcome, extra: 1 })),
  fc.string().map((outcome) => JSON.stringify({ outcome })),
  validPromise.map((v) => JSON.stringify(v)),
  validPromise.chain((v) => fc.constantFrom("amount_paise", "date_iso", "spoken_text").map((k) => JSON.stringify({ ...v, [k]: undefined }))),
  validPromise.map((v) => JSON.stringify({ ...v, extra: true })),
  validPromise.map((v) => JSON.stringify({ ...v, amount_paise: v.amount_paise + 0.5 })),
  fc.dictionary(fc.string({ maxLength: 8 }), fc.jsonValue(), { maxKeys: 3 }).map((o) => JSON.stringify(o)),
);

describe("Property 9: Tool argument parsing never throws", () => {
  it("returns unknown_tool iff the name is not a Call_Tool, else invalid_arguments iff the string is not JSON or fails the schema", () => {
    fc.assert(
      fc.property(toolName, rawArguments, (name, raw) => {
        const result = parseToolArgs(name, raw);
        const expected = oracle(name, raw);
        if (expected === "ok") {
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.name).toBe(name);
            expect(result.args).toEqual(JSON.parse(raw));
          }
        } else {
          expect(result).toEqual({ ok: false, error: expected });
        }
      }),
      { numRuns: 500 },
    );
  });

  it("knows exactly the tools in CALL_TOOLS", () => {
    expect(CALL_TOOLS.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });
});
