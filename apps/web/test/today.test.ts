import { describe, expect, it } from "vitest";
import { DEMO_MAX, DEMO_MIN, formatDisplayDate, istDate, isValidTodayOverride, resolveToday, TIME_TRAVEL_PRESETS } from "@/lib/graveyard/today";

// All instants are injected; the real clock is never read.
const BEFORE_IST_MIDNIGHT = Date.UTC(2026, 10, 12, 18, 29, 59); // 23:59:59 IST on 12 Nov 2026
const AT_IST_MIDNIGHT = Date.parse("2026-11-12T18:30:00Z"); // 00:00:00 IST on 13 Nov 2026
const AFTER_IST_MIDNIGHT = Date.parse("2026-11-12T19:00:00Z"); // 00:30:00 IST on 13 Nov 2026

describe("resolveToday, IST date from the injected instant (Requirements 4.1, 4.2)", () => {
  it("uses the IST date one second before IST midnight", () => {
    expect(resolveToday(BEFORE_IST_MIDNIGHT, undefined)).toEqual({ today: "2026-11-12", override: null });
  });

  it("rolls to the next IST date at 18:30:00Z", () => {
    expect(resolveToday(AT_IST_MIDNIGHT, undefined)).toEqual({ today: "2026-11-13", override: null });
  });

  it("stays on the next IST date at 19:00:00Z", () => {
    expect(resolveToday(AFTER_IST_MIDNIGHT, undefined)).toEqual({ today: "2026-11-13", override: null });
  });

  it("istDate matches the same boundaries", () => {
    expect(istDate(BEFORE_IST_MIDNIGHT)).toBe("2026-11-12");
    expect(istDate(AT_IST_MIDNIGHT)).toBe("2026-11-13");
  });
});

describe("resolveToday, accepted ?today= overrides (Requirements 4.3, 4.4)", () => {
  it("exposes the demo range limits", () => {
    expect(DEMO_MIN).toBe("2024-01-01");
    expect(DEMO_MAX).toBe("2027-12-31");
  });

  it.each(["2027-03-10", "2024-01-01", "2027-12-31"])("returns %s unchanged with override set", (value) => {
    expect(resolveToday(BEFORE_IST_MIDNIGHT, value)).toEqual({ today: value, override: value });
  });

  it("takes only the first value of a repeated parameter", () => {
    expect(resolveToday(BEFORE_IST_MIDNIGHT, ["2027-03-10", "2027-04-01"])).toEqual({
      today: "2027-03-10",
      override: "2027-03-10",
    });
  });

  it("does not fall through to a later array value when the first is rejected", () => {
    expect(resolveToday(AFTER_IST_MIDNIGHT, ["2028-01-01", "2027-03-10"])).toEqual({ today: "2026-11-13", override: null });
  });
});

describe("resolveToday, rejected ?today= values fall back to the IST date (Requirements 4.3, 4.5)", () => {
  it.each([
    ["non-padded month and day", "2026-2-3"],
    ["not a real calendar date", "2026-02-30"],
    ["day-first format", "13/11/2026"],
    ["surrounding spaces", " 2027-03-10 "],
    ["day before the minimum", "2023-12-31"],
    ["day after the maximum", "2028-01-01"],
    ["empty string", ""],
  ])("rejects %s (%s)", (_reason, value) => {
    expect(resolveToday(BEFORE_IST_MIDNIGHT, value)).toEqual({ today: "2026-11-12", override: null });
    expect(resolveToday(AFTER_IST_MIDNIGHT, value)).toEqual({ today: "2026-11-13", override: null });
  });

  it("falls back when the parameter is absent", () => {
    expect(resolveToday(BEFORE_IST_MIDNIGHT, undefined)).toEqual({ today: "2026-11-12", override: null });
    expect(resolveToday(AFTER_IST_MIDNIGHT, undefined)).toEqual({ today: "2026-11-13", override: null });
  });
});

describe("formatDisplayDate", () => {
  it.each([
    ["2027-03-10", "10 Mar 2027"],
    ["2026-11-12", "12 Nov 2026"],
    ["2027-04-01", "1 Apr 2027"],
  ])("formats %s as %s", (input, expected) => {
    expect(formatDisplayDate(input)).toBe(expected);
  });
});

describe("TIME_TRAVEL_PRESETS", () => {
  it("lists the three presets with exact labels and dates", () => {
    expect(TIME_TRAVEL_PRESETS).toEqual([
      { label: "Today", today: null },
      { label: "10 Mar 2027 (tax-bomb week)", today: "2027-03-10" },
      { label: "1 Apr 2027 (after 31 March)", today: "2027-04-01" },
    ]);
  });

  it("every dated preset is accepted by resolveToday as an override", () => {
    for (const preset of TIME_TRAVEL_PRESETS) {
      if (preset.today === null) continue;
      expect(resolveToday(BEFORE_IST_MIDNIGHT, preset.today)).toEqual({ today: preset.today, override: preset.today });
    }
  });
});

describe("isValidTodayOverride", () => {
  it.each(["2024-01-01", "2027-03-10", "2027-12-31"])("accepts %j", (value) => {
    expect(isValidTodayOverride(value)).toBe(true);
    expect(resolveToday(0, value).override).toBe(value);
  });
  it.each(["2023-12-31", "2028-01-01", "2027-02-30", "2027-3-10", "", "x", null, undefined, 20270310])(
    "rejects %j, as resolveToday does",
    (value) => {
      expect(isValidTodayOverride(value)).toBe(false);
      expect(resolveToday(0, value as string | undefined).override).toBeNull();
    },
  );
});
