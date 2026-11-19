import { describe, expect, it } from "vitest";
import {
  addDays,
  compareDates,
  dayDifference,
  financialYearEnd,
  fromEpochDay,
  isValidCalendarDate,
  isoWeekday,
  toEpochDay,
} from "../src/calendar-date";

describe("dayDifference", () => {
  it("counts days from the due date to a later date", () => {
    expect(dayDifference("2026-10-17", "2026-11-12")).toBe(26);
  });

  it("counts days from today to the 31 March tax bomb date", () => {
    expect(dayDifference("2026-11-12", "2027-03-31")).toBe(139);
  });

  it("is negative when the second date is earlier and zero for equal dates", () => {
    expect(dayDifference("2026-11-12", "2026-10-17")).toBe(-26);
    expect(dayDifference("2026-11-12", "2026-11-12")).toBe(0);
  });
});

describe("addDays", () => {
  it("adds the 45-day term to the acceptance date", () => {
    expect(addDays("2026-09-02", 45)).toBe("2026-10-17");
  });

  it("crosses month, year and leap-day boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
    expect(addDays("2026-10-17", -45)).toBe("2026-09-02");
  });
});

describe("isValidCalendarDate", () => {
  it.each(["2026-02-30", "2027-02-29", "2026-04-31", "2026-1-5", "2026-00-10", "2026-13-10"])(
    "rejects %s",
    (value) => {
      expect(isValidCalendarDate(value)).toBe(false);
    },
  );

  it("accepts a leap day in a leap year", () => {
    expect(isValidCalendarDate("2028-02-29")).toBe(true);
  });

  it("accepts an ordinary date", () => {
    expect(isValidCalendarDate("2026-09-02")).toBe(true);
  });

  it("rejects day 00, non-strings and years outside 1900..9999", () => {
    expect(isValidCalendarDate("2026-09-00")).toBe(false);
    expect(isValidCalendarDate(20260902)).toBe(false);
    expect(isValidCalendarDate(undefined)).toBe(false);
    expect(isValidCalendarDate("1899-12-31")).toBe(false);
  });
});

describe("financialYearEnd", () => {
  it("returns the next 31 March for a September date", () => {
    expect(financialYearEnd("2026-09-02")).toBe("2027-03-31");
  });

  it("returns the same date when given 31 March", () => {
    expect(financialYearEnd("2027-03-31")).toBe("2027-03-31");
  });

  it("rolls over to the following year on 1 April", () => {
    expect(financialYearEnd("2027-04-01")).toBe("2028-03-31");
  });

  it("stays in the same calendar year for January to March", () => {
    expect(financialYearEnd("2027-01-15")).toBe("2027-03-31");
  });
});

describe("compareDates", () => {
  it("returns -1, 0 and 1", () => {
    expect(compareDates("2026-10-17", "2026-11-12")).toBe(-1);
    expect(compareDates("2026-10-17", "2026-10-17")).toBe(0);
    expect(compareDates("2026-11-12", "2026-10-17")).toBe(1);
  });
});

describe("epoch day conversion", () => {
  it("maps 1970-01-01 to day 0 and back", () => {
    expect(toEpochDay("1970-01-01")).toBe(0);
    expect(fromEpochDay(0)).toBe("1970-01-01");
  });

  it("handles days before the epoch", () => {
    expect(toEpochDay("1969-12-31")).toBe(-1);
    expect(fromEpochDay(-1)).toBe("1969-12-31");
  });
});

describe("isoWeekday", () => {
  it("returns Thursday = 4 for the demo date 2026-11-12", () => {
    expect(isoWeekday("2026-11-12")).toBe(4);
  });
  it("returns Friday = 5 for 2026-11-20", () => {
    expect(isoWeekday("2026-11-20")).toBe(5);
  });
  it("returns Monday = 1 and Sunday = 7", () => {
    expect(isoWeekday("2026-11-16")).toBe(1);
    expect(isoWeekday("2026-11-15")).toBe(7);
  });
  it("returns Thursday = 4 for the epoch day 1970-01-01", () => {
    expect(isoWeekday("1970-01-01")).toBe(4);
  });
  it("handles dates before 1970", () => {
    expect(isoWeekday("1969-12-31")).toBe(3); // Wednesday
    expect(isoWeekday("1969-07-20")).toBe(7); // Sunday
    expect(isoWeekday("1900-01-01")).toBe(1); // Monday
  });
  it("handles the leap day 2028-02-29 (Tuesday) and the day after", () => {
    expect(isoWeekday("2028-02-29")).toBe(2);
    expect(isoWeekday("2028-03-01")).toBe(3);
  });
});
