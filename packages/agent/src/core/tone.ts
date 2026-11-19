import type { LadderStep } from "@dues-banshee/engine";
import type { BlockReason, CitationResult } from "./citations";
import { normalise, phraseRegex } from "./match";
import { BEGGING_LIST, THREAT_LIST } from "./tone-phrases";

/**
 * Steps whose text must address the buyer as `{{buyer_name}} ji`. A voice_call draft is a
 * brief for the owner and an odr_pack is a statement for the portal, so neither needs it.
 */
export const ADDRESS_REQUIRED: Readonly<Record<LadderStep, boolean>> = {
  whatsapp_nudge: true,
  whatsapp_paylink: true,
  voice_call: false,
  legal_notice: true,
  odr_pack: false,
};

const ADDRESS_FORM = /\{\{buyer_name\}\}\s+ji(?![\p{L}\p{N}])/iu;

interface Entry {
  phrase: string;
  regex: RegExp;
}

// Built once at module load; non-global, so no `lastIndex` state is shared between calls.
const compile = (list: readonly string[]): Entry[] =>
  list.map((phrase) => ({ phrase, regex: phraseRegex(phrase) }));

const THREATS = compile(THREAT_LIST);
const BEGGINGS = compile(BEGGING_LIST);

const blocked = (reason: BlockReason, offending: string | null): CitationResult => ({
  ok: false,
  reason,
  offending,
});

/**
 * Pure tone check on a Model_Output template. Takes only the text and the step, so buyer
 * names and invoice numbers cannot change the result. Checks run in a fixed order and the
 * first failure wins: missing address, threat phrase, begging phrase. `null` = pass.
 */
export function toneCheck(text: string, step: LadderStep): CitationResult | null {
  if (ADDRESS_REQUIRED[step] && !ADDRESS_FORM.test(text)) {
    return blocked("missing_address", null);
  }

  const flat = normalise(text);

  const threat = THREATS.find((e) => e.regex.test(flat));
  if (threat !== undefined) return blocked("threat_phrase", threat.phrase);

  const begging = BEGGINGS.find((e) => e.regex.test(flat));
  if (begging !== undefined) return blocked("begging_phrase", begging.phrase);

  return null;
}
