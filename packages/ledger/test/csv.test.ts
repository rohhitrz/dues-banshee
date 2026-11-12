import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/csv";
import type { RawRow } from "../src/types";

/** Parses and returns the table, failing the test if parsing was rejected. */
function table(text: string): readonly RawRow[] {
  const result = parseCsv(text);
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.table;
}

describe("parseCsv: cells and row numbers (Requirement 5.1)", () => {
  it("keeps the commas inside a quoted Indian-grouped amount in one cell", () => {
    expect(table('Sharma Traders,"4,12,000",45')).toEqual([
      { rowNumber: 1, cells: ["Sharma Traders", "4,12,000", "45"] },
    ]);
  });

  it('reads "" inside a quoted field as one quote character', () => {
    expect(table('"He said ""pay""",x')).toEqual([
      { rowNumber: 1, cells: ['He said "pay"', "x"] },
    ]);
  });

  it("splits records at CRLF", () => {
    expect(table("a,b\r\nc,d\r\ne,f")).toEqual([
      { rowNumber: 1, cells: ["a", "b"] },
      { rowNumber: 2, cells: ["c", "d"] },
      { rowNumber: 3, cells: ["e", "f"] },
    ]);
  });

  it("splits records at LF", () => {
    expect(table("a,b\nc,d\ne,f")).toEqual([
      { rowNumber: 1, cells: ["a", "b"] },
      { rowNumber: 2, cells: ["c", "d"] },
      { rowNumber: 3, cells: ["e", "f"] },
    ]);
  });

  it("splits records at a lone CR", () => {
    expect(table("a,b\rc,d\re,f")).toEqual([
      { rowNumber: 1, cells: ["a", "b"] },
      { rowNumber: 2, cells: ["c", "d"] },
      { rowNumber: 3, cells: ["e", "f"] },
    ]);
  });

  it("handles a file that mixes CRLF, LF and CR", () => {
    expect(table("a\r\nb\nc\rd")).toEqual([
      { rowNumber: 1, cells: ["a"] },
      { rowNumber: 2, cells: ["b"] },
      { rowNumber: 3, cells: ["c"] },
      { rowNumber: 4, cells: ["d"] },
    ]);
  });

  it("removes a leading byte-order mark from the first cell", () => {
    expect(table("\uFEFFDate,Amount\n2026-09-02,100")).toEqual([
      { rowNumber: 1, cells: ["Date", "Amount"] },
      { rowNumber: 2, cells: ["2026-09-02", "100"] },
    ]);
  });

  it("removes a BOM that precedes a quoted first field", () => {
    expect(table('\uFEFF"Date",Amount')).toEqual([
      { rowNumber: 1, cells: ["Date", "Amount"] },
    ]);
  });

  it("keeps a line break inside quotes and numbers the next record as the next row", () => {
    expect(table('a,"line one\nline two",c\r\nd,e,f\n"x\r\ny",z')).toEqual([
      { rowNumber: 1, cells: ["a", "line one\nline two", "c"] },
      { rowNumber: 2, cells: ["d", "e", "f"] },
      { rowNumber: 3, cells: ["x\r\ny", "z"] },
    ]);
  });

  it("does not add an empty record after a final line break", () => {
    const expected = [
      { rowNumber: 1, cells: ["a", "b"] },
      { rowNumber: 2, cells: ["c", "d"] },
    ];
    expect(table("a,b\nc,d\n")).toEqual(expected);
    expect(table("a,b\r\nc,d\r\n")).toEqual(expected);
    expect(table("a,b\rc,d\r")).toEqual(expected);
  });

  it("reads an empty quoted field as an empty cell", () => {
    expect(table('a,"",b')).toEqual([{ rowNumber: 1, cells: ["a", "", "b"] }]);
    expect(table('"",a\n"",""\n')).toEqual([
      { rowNumber: 1, cells: ["", "a"] },
      { rowNumber: 2, cells: ["", ""] },
    ]);
  });

  it("returns an empty table for empty input", () => {
    expect(table("")).toEqual([]);
  });
});

describe("parseCsv: syntax errors (Requirement 5.1)", () => {
  it("rejects an unterminated quote with csv_syntax", () => {
    const result = parseCsv('a,b\nc,"never closed,d\ne,f');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("csv_syntax");
  });

  it("names the record in which the quote was opened", () => {
    const result = parseCsv('a,b\nc,"never closed,d\ne,f');
    if (result.ok) throw new Error("expected a syntax error");
    expect(result.error.message).toContain("row 2");
  });

  it("names record 1 when the first field is never closed", () => {
    const result = parseCsv('"open');
    if (result.ok) throw new Error("expected a syntax error");
    expect(result.error.code).toBe("csv_syntax");
    expect(result.error.message).toContain("row 1");
  });

  it("counts a record after a multi-line quoted cell when naming the row", () => {
    const result = parseCsv('"a\nb",c\n"open');
    if (result.ok) throw new Error("expected a syntax error");
    expect(result.error.message).toContain("row 2");
  });
});
