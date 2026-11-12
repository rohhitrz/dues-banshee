import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseAmountLenient } from "../src/index";
import { arbAmountText, arbPaise, EDGE_PAISE } from "./arbitraries";

describe("parseAmountLenient properties", () => {
  // Feature: ledger-import, Property 1: Every accepted amount style parses back to the same paise
  // Validates: Requirements 3.2, 3.4, 3.8
  it("Property 1: Every accepted amount style parses back to the same paise", () => {
    fc.assert(
      fc.property(
        arbPaise.chain((p) => arbAmountText(p).map((text) => ({ p, text }))),
        ({ p, text }) => {
          expect(parseAmountLenient(text)).toBe(p);
        },
      ),
    );
  });

  // Feature: ledger-import, Property 1: Every accepted amount style parses back to the same paise
  // Validates: Requirements 3.2, 3.4, 3.8
  it("Property 1 (edge values): 0, 1, 99, 100, 10^7, 10^9 and MAX_SAFE round-trip in every style", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...EDGE_PAISE).chain((p) => arbAmountText(p).map((text) => ({ p, text }))),
        ({ p, text }) => {
          expect(parseAmountLenient(text)).toBe(p);
        },
      ),
    );
  });
});
