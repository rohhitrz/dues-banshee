import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fromEpochDay } from "@dues-banshee/engine";
import { pickSendableDraft, sendControlState, type SendableCandidate } from "@/lib/send/control-state";

// Feature: whatsapp-channel, Property 4: Send control state and draft choice
// **Validates: Requirements 4.1, 4.3, 4.4, 4.5**

// Narrow ranges so approval days and creation times often tie and the later keys decide.
const arbCandidate: fc.Arbitrary<SendableCandidate> = fc.record({
  draftId: fc.uuid(),
  approvalDay: fc.integer({ min: 20_000, max: 20_003 }).map(fromEpochDay),
  createdAt: fc.integer({ min: 1_700_000_000_000, max: 1_700_000_000_003 }).map((ms) => new Date(ms)),
});

const arbCandidates = fc.uniqueArray(arbCandidate, { selector: (c) => c.draftId, maxLength: 12 });

const arbNonEmptyCandidates = fc.uniqueArray(arbCandidate, {
  selector: (c) => c.draftId,
  minLength: 1,
  maxLength: 12,
});

/** Independent model: sort descending by (approvalDay, createdAt, draftId) and take the first. */
function expectedPick(list: readonly SendableCandidate[]): SendableCandidate | null {
  const sorted = [...list].sort((a, b) => {
    if (a.approvalDay !== b.approvalDay) return a.approvalDay > b.approvalDay ? -1 : 1;
    if (a.createdAt.getTime() !== b.createdAt.getTime()) return a.createdAt.getTime() > b.createdAt.getTime() ? -1 : 1;
    if (a.draftId !== b.draftId) return a.draftId > b.draftId ? -1 : 1;
    return 0;
  });
  return sorted[0] ?? null;
}

const arbShuffled = arbNonEmptyCandidates.chain((list) =>
  fc.tuple(
    fc.constant(list),
    fc.shuffledSubarray(list, { minLength: list.length, maxLength: list.length }),
  ),
);

describe("Property 4: Send control state and draft choice", () => {
  it("pickSendableDraft returns the candidate maximal by (approvalDay, createdAt, draftId), or null for an empty list", () => {
    fc.assert(
      fc.property(arbCandidates, (list) => {
        expect(pickSendableDraft(list)).toBe(expectedPick(list));
      }),
      { numRuns: 100 },
    );
    expect(pickSendableDraft([])).toBeNull();
  });

  it("pickSendableDraft does not depend on the order of the list", () => {
    fc.assert(
      fc.property(arbShuffled, ([list, shuffled]) => {
        expect(shuffled).toHaveLength(list.length);
        expect(pickSendableDraft(shuffled)).toBe(pickSendableDraft(list));
        expect(pickSendableDraft([...list].reverse())).toBe(pickSendableDraft(list));
      }),
      { numRuns: 100 },
    );
  });

  it("sendControlState is no_draft iff there is no draft, else no_number, sender_not_configured, ready in that precedence", () => {
    fc.assert(
      fc.property(
        arbCandidates,
        fc.boolean(),
        fc.boolean(),
        fc.option(fc.string(), { nil: null }),
        (list, buyerNumberSet, twilioReady, preview) => {
          const draft = pickSendableDraft(list);
          const state = sendControlState({ draft, buyerNumberSet, twilioReady, preview });

          if (draft === null) {
            expect(state).toEqual({ kind: "no_draft" });
            return;
          }
          const text = preview ?? "";
          if (!buyerNumberSet) {
            expect(state).toEqual({ kind: "no_number", draftId: draft.draftId, preview: text });
          } else if (!twilioReady) {
            expect(state).toEqual({ kind: "sender_not_configured", draftId: draft.draftId, preview: text });
          } else {
            expect(state).toEqual({ kind: "ready", draftId: draft.draftId, preview: text });
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("no_draft wins over every other flag, and every other state carries the chosen draft's id", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.string(), (buyerNumberSet, twilioReady, preview) => {
        expect(sendControlState({ draft: null, buyerNumberSet, twilioReady, preview })).toEqual({ kind: "no_draft" });
      }),
      { numRuns: 100 },
    );
    fc.assert(
      fc.property(arbNonEmptyCandidates, fc.boolean(), fc.boolean(), (list, buyerNumberSet, twilioReady) => {
        const chosen = expectedPick(list);
        expect(chosen).not.toBeNull();
        const state = sendControlState({ draft: pickSendableDraft(list), buyerNumberSet, twilioReady, preview: "p" });
        expect(state.kind).not.toBe("no_draft");
        if (state.kind !== "no_draft") expect(state.draftId).toBe(chosen!.draftId);
      }),
      { numRuns: 100 },
    );
  });
});
