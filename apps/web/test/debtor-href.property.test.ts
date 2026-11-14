import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fromEpochDay } from "@dues-banshee/engine";
import { debtorHref } from "@/lib/debtor/href";

// Feature: debtor-ui, Property 8: Tombstone link shape
// **Validates: Requirements 3.1, 3.2, 3.3**

const arbOverride = fc.integer({ min: 0, max: 20_000 }).map(fromEpochDay);

describe("Property 8: Tombstone link shape", () => {
  it("is /debtors/<buyer>#invoice-<invoice>, with ?today=<override> before the fragment only under an override", () => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), fc.option(arbOverride, { nil: null }), (buyerId, invoiceId, override) => {
        const href = debtorHref(buyerId, invoiceId, override);
        if (override === null) {
          expect(href).toBe(`/debtors/${buyerId}#invoice-${invoiceId}`);
          expect(href).not.toContain("today");
        } else {
          expect(href).toBe(`/debtors/${buyerId}?today=${override}#invoice-${invoiceId}`);
        }
      }),
      { numRuns: 100 },
    );
  });
});
