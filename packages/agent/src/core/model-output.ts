import { z } from "zod";

/** What the model must return for a draft: the body text and the rule IDs it cites. */
export const MODEL_OUTPUT_SCHEMA = z.object({
  text: z.string(),
  ruleIds: z.array(z.string()),
});

export type ModelOutput = z.infer<typeof MODEL_OUTPUT_SCHEMA>;

export type DraftLanguage = "hinglish" | "english";
