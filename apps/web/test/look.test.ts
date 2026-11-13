import type { EscalationHistory } from "@dues-banshee/engine";
import { describe, expect, it } from "vitest";
import { heightsByRank, mossLevel, tombstoneLook, type TombstoneLook } from "@/lib/graveyard/look";

const TODAY = "2026-11-12";

const promise = (promisedDate: string) =>
  ({ kind: "promise", promisedDate, amountPaise: 100000, recordedOn: "2026-11-01" }) as const;

const look = (over: {
  daysOverdue?: number;
  paid?: boolean;
  history?: EscalationHistory;
}): TombstoneLook =>
  tombstoneLook({
    heightPx: 130,
    daysOverdue: 0,
    paid: false,
    history: [],
    today: TODAY,
    ...over,
  });

describe("mossLevel", () => {
  it.each<[number, 0 | 1 | 2 | 3 | 4]>([
    [0, 0],
    [1, 1],
    [15, 1],
    [16, 2],
    [45, 2],
    [46, 3],
    [90, 3],
    [91, 4],
  ])("%i days overdue is moss level %i", (days, expected) => {
    expect(mossLevel(days)).toBe(expected);
  });
});

describe("tombstoneLook cracks and ember", () => {
  it("is not cracked at 60 days and cracked at 61", () => {
    expect(look({ daysOverdue: 60 }).cracked).toBe(false);
    expect(look({ daysOverdue: 61 }).cracked).toBe(true);
  });

  it("has no ember at 45 days and an ember at 46", () => {
    expect(look({ daysOverdue: 45 }).ember).toBe(false);
    expect(look({ daysOverdue: 46 }).ember).toBe(true);
  });

  it("combines moss, cracks and ember at the exact boundaries", () => {
    expect(look({ daysOverdue: 61 })).toEqual({
      heightPx: 130,
      moss: 3,
      cracked: true,
      ember: true,
      wisp: false,
    });
    expect(look({ daysOverdue: 0 })).toEqual({
      heightPx: 130,
      moss: 0,
      cracked: false,
      ember: false,
      wisp: false,
    });
  });

  it("passes heightPx through unchanged", () => {
    expect(look({}).heightPx).toBe(130);
    expect(tombstoneLook({ heightPx: 215, daysOverdue: 0, paid: false, history: [], today: TODAY }).heightPx).toBe(
      215,
    );
  });
});

describe("tombstoneLook wisp", () => {
  it("is true with a promise dated on Today", () => {
    expect(look({ history: [promise(TODAY)] }).wisp).toBe(true);
  });

  it("is true with a promise dated after Today", () => {
    expect(look({ history: [promise("2026-11-13")] }).wisp).toBe(true);
  });

  it("is false with a promise dated before Today", () => {
    expect(look({ history: [promise("2026-11-11")] }).wisp).toBe(false);
  });

  it("is false on a paid invoice even with a future promise", () => {
    expect(look({ paid: true, history: [promise("2026-12-01")] }).wisp).toBe(false);
  });

  it("is false with no promise", () => {
    expect(look({ history: [] }).wisp).toBe(false);
  });

  it("is false when the history holds only steps", () => {
    expect(look({ history: [{ kind: "step", step: "whatsapp_nudge", on: "2026-11-10" }] }).wisp).toBe(false);
  });
});

describe("heightsByRank", () => {
  it("returns an empty list for no principals", () => {
    expect(heightsByRank([])).toEqual([]);
  });

  it("gives a single distinct value the minimum height", () => {
    expect(heightsByRank([512794])).toEqual([130]);
  });

  it("gives equal principals equal heights", () => {
    expect(heightsByRank([500, 500, 500])).toEqual([130, 130, 130]);
    expect(heightsByRank([500, 900, 500])).toEqual([130, 300, 130]);
  });

  it("maps two distinct values to 130 and 300", () => {
    expect(heightsByRank([100, 200])).toEqual([130, 300]);
  });

  it("maps three distinct values to 130, 215 and 300", () => {
    expect(heightsByRank([100, 200, 300])).toEqual([130, 215, 300]);
  });

  it("preserves input order", () => {
    expect(heightsByRank([300, 100, 200])).toEqual([300, 130, 215]);
  });

  it("never makes a larger principal shorter than a smaller one", () => {
    const principals = [1026125, 512794, 3167411, 1530351, 18500000, 512794];
    const heights = heightsByRank(principals);
    expect(heights).toEqual([172, 130, 257, 215, 300, 130]);
    for (let i = 0; i < principals.length; i += 1) {
      for (let j = 0; j < principals.length; j += 1) {
        if (principals[i]! > principals[j]!) {
          expect(heights[i]!).toBeGreaterThan(heights[j]!);
        }
      }
    }
  });
});
