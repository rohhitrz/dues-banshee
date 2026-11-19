import { LADDER_STEPS } from "@dues-banshee/engine";
import type { LadderStep } from "@dues-banshee/engine";
import { describe, expect, it } from "vitest";
import { normalise, phraseRegex } from "../src/core/match";
import { ADDRESS_REQUIRED, toneCheck } from "../src/core/tone";
import { BEGGING_LIST, THREAT_LIST } from "../src/core/tone-phrases";

const ADDRESS = "{{buyer_name}} ji";
const addressed = (body: string): string => `Namaste ${ADDRESS}, ${body} dhanyavaad.`;
const blocked = (reason: string, offending: string | null) => ({
  ok: false,
  reason,
  offending,
});

// The language split is explicit, so a new entry must be classified here on purpose.
const HINGLISH_THREATS: ReadonlySet<string> = new Set([
  "warna",
  "dekh lenge",
  "anjaam",
  "bhugatna padega",
  "case kar denge",
  "court mein ghaseet",
  "sabak sikha",
  "chhodenge nahi",
  "aakhri chetavani",
]);
const HINGLISH_BEGGING: ReadonlySet<string> = new Set([
  "haath jodkar",
  "minnat",
  "daya karo",
  "reham",
  "bahut majboor",
  "aapke pair",
]);

const english = (list: readonly string[], hinglish: ReadonlySet<string>) =>
  list.filter((e) => !hinglish.has(e));

describe("toneCheck list entries", () => {
  it.each(THREAT_LIST)("threat entry %j blocks with itself as offending", (entry) => {
    expect(toneCheck(addressed(entry), "whatsapp_nudge")).toEqual(
      blocked("threat_phrase", entry),
    );
  });

  it.each(BEGGING_LIST)("begging entry %j blocks with itself as offending", (entry) => {
    expect(toneCheck(addressed(entry), "whatsapp_nudge")).toEqual(
      blocked("begging_phrase", entry),
    );
  });

  it("matches in any letter case and across whitespace runs", () => {
    expect(toneCheck(addressed("FINAL   Warning"), "whatsapp_paylink")).toEqual(
      blocked("threat_phrase", "final warning"),
    );
    expect(toneCheck(addressed("Haath\n jodkar"), "legal_notice")).toEqual(
      blocked("begging_phrase", "haath jodkar"),
    );
  });

  it("matches whole words only", () => {
    expect(toneCheck(addressed("policy ke hisaab se"), "whatsapp_nudge")).toBeNull();
    expect(toneCheck(addressed("warnaa"), "whatsapp_nudge")).toBeNull();
  });

  it.each(LADDER_STEPS)("threat and begging phrases apply on %s", (step) => {
    expect(toneCheck(addressed("warna"), step)).toEqual(blocked("threat_phrase", "warna"));
    expect(toneCheck(addressed("minnat"), step)).toEqual(blocked("begging_phrase", "minnat"));
  });
});

describe("toneCheck address rule", () => {
  const required: readonly LadderStep[] = ["whatsapp_nudge", "whatsapp_paylink", "legal_notice"];
  const notRequired: readonly LadderStep[] = ["voice_call", "odr_pack"];

  it("ADDRESS_REQUIRED covers every step", () => {
    expect(Object.keys(ADDRESS_REQUIRED).sort()).toEqual([...LADDER_STEPS].sort());
  });

  it.each(required)("%s needs the address", (step) => {
    expect(ADDRESS_REQUIRED[step]).toBe(true);
    expect(toneCheck("Namaste {{buyer_name}}, payment baaki hai.", step)).toEqual(
      blocked("missing_address", null),
    );
    expect(toneCheck(addressed("payment baaki hai."), step)).toBeNull();
  });

  it.each(notRequired)("%s does not need the address", (step) => {
    expect(ADDRESS_REQUIRED[step]).toBe(false);
    expect(toneCheck("Payment baaki hai.", step)).toBeNull();
  });

  it("accepts the address in any letter case and across a line break", () => {
    expect(toneCheck("Namaste {{buyer_name}} JI, payment baaki hai.", "whatsapp_nudge")).toBeNull();
    expect(toneCheck("Namaste {{buyer_name}}\n ji, payment baaki hai.", "whatsapp_nudge")).toBeNull();
  });

  it("rejects `ji` that is only a prefix of a longer word", () => {
    expect(toneCheck("Namaste {{buyer_name}} jiyo, payment baaki hai.", "whatsapp_nudge")).toEqual(
      blocked("missing_address", null),
    );
  });

  it("runs the address check before the threat check", () => {
    expect(toneCheck("Namaste {{buyer_name}}, warna dekh lenge.", "whatsapp_nudge")).toEqual(
      blocked("missing_address", null),
    );
  });

  it("runs the threat check before the begging check", () => {
    expect(toneCheck(addressed("minnat hai, warna"), "whatsapp_nudge")).toEqual(
      blocked("threat_phrase", "warna"),
    );
  });

  it("reports the first threat entry in list order when several match", () => {
    const text = addressed("anjaam bura hoga, warna");
    expect(toneCheck(text, "whatsapp_nudge")).toEqual(blocked("threat_phrase", "warna"));
  });
});

describe("tone lists", () => {
  it("THREAT_LIST has at least 8 entries, English and Hinglish", () => {
    expect(THREAT_LIST.length).toBeGreaterThanOrEqual(8);
    expect(english(THREAT_LIST, HINGLISH_THREATS).length).toBeGreaterThan(0);
    expect(THREAT_LIST.filter((e) => HINGLISH_THREATS.has(e)).length).toBeGreaterThan(0);
  });

  it("BEGGING_LIST has at least 6 entries, English and Hinglish", () => {
    expect(BEGGING_LIST.length).toBeGreaterThanOrEqual(6);
    expect(english(BEGGING_LIST, HINGLISH_BEGGING).length).toBeGreaterThan(0);
    expect(BEGGING_LIST.filter((e) => HINGLISH_BEGGING.has(e)).length).toBeGreaterThan(0);
  });

  it("the explicit Hinglish sets name only real entries", () => {
    for (const e of HINGLISH_THREATS) expect(THREAT_LIST).toContain(e);
    for (const e of HINGLISH_BEGGING) expect(BEGGING_LIST).toContain(e);
  });

  it("holds lowercase, unique, trimmed entries", () => {
    for (const list of [THREAT_LIST, BEGGING_LIST]) {
      expect(new Set(list).size).toBe(list.length);
      for (const e of list) expect(e).toBe(normalise(e).trim());
    }
    const all = [...THREAT_LIST, ...BEGGING_LIST];
    expect(new Set(all).size).toBe(all.length);
  });

  const COURTESY_AND_FACT_WORDS = [
    "please",
    "interest",
    "msme",
    "odr",
    "facilitation council",
    "samadhaan",
    "kripya",
    "request",
  ];

  // design.md lists "please please" (a repeated plea) on purpose, and it contains the word
  // "please". It is the only allowed exception; a single "please" must still pass (below).
  const ALLOWED_CONTAINING: ReadonlySet<string> = new Set(["please please"]);

  it.each(COURTESY_AND_FACT_WORDS)("no entry equals or contains %j as a whole word", (word) => {
    const wordRegex = phraseRegex(word);
    for (const entry of [...THREAT_LIST, ...BEGGING_LIST]) {
      if (word === "please" && ALLOWED_CONTAINING.has(entry)) continue;
      expect(wordRegex.test(normalise(entry)), `entry ${entry}`).toBe(false);
    }
  });

  it.each(["dekh lena", "or else", "vinti hai"])("polite phrase %j matches no entry", (polite) => {
    const flat = normalise(polite);
    for (const entry of [...THREAT_LIST, ...BEGGING_LIST]) {
      expect(phraseRegex(entry).test(flat), `entry ${entry}`).toBe(false);
    }
    expect(toneCheck(addressed(polite), "whatsapp_nudge")).toBeNull();
  });

  it("a single 'please' passes while the repeated plea blocks", () => {
    expect(toneCheck(addressed("please pay today."), "whatsapp_nudge")).toBeNull();
    expect(toneCheck(addressed("please, please pay."), "whatsapp_nudge")).toBeNull();
    expect(toneCheck(addressed("please please pay."), "whatsapp_nudge")).toEqual(
      blocked("begging_phrase", "please please"),
    );
  });

  it("passes the accepted courtesy and fact lines", () => {
    const lines = [
      "Kripya {{pay_link}} se bhugtan kar dein.",
      "Please pay {{principal}} using {{pay_link}}.",
      "Statutory interest of {{interest}} accrues on the late payment.",
      "You may approach the MSME Facilitation Council or file on Samadhaan and the ODR portal.",
      "This is a request to settle the dues.",
    ];
    for (const line of lines) {
      expect(toneCheck(addressed(line), "legal_notice"), line).toBeNull();
    }
  });
});
