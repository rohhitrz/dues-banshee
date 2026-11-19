import { z } from "zod";

/**
 * Argument schemas for the three call tools. Shape only: sign, range and calendar validity of the
 * amount and date are checked by the tool handler, so the agent gets a specific error to explain.
 */
export const RecordPromiseArgs = z
  .object({
    amount_paise: z.number().int(),
    date_iso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    spoken_text: z.string().min(1).max(2000),
  })
  .strict();

export const EndCallArgs = z.object({ outcome: z.enum(["dispute", "no_promise", "consent_declined"]) }).strict();

export const GetFactsArgs = z.object({}).strict();

export type RecordPromiseArgsT = z.infer<typeof RecordPromiseArgs>;
export type EndCallArgsT = z.infer<typeof EndCallArgs>;
export type GetFactsArgsT = z.infer<typeof GetFactsArgs>;

export type CallToolName = "get_invoice_facts" | "record_promise_to_pay" | "end_call";

const SCHEMAS = {
  get_invoice_facts: GetFactsArgs,
  record_promise_to_pay: RecordPromiseArgs,
  end_call: EndCallArgs,
} as const;

/** JSON Schema for the Realtime session config, without the `$schema` marker. */
function parametersOf(schema: z.ZodType): unknown {
  const json = { ...(z.toJSONSchema(schema) as Record<string, unknown>) };
  delete json.$schema;
  return json;
}

export const CALL_TOOLS: readonly { name: CallToolName; description: string; parameters: unknown }[] = [
  {
    name: "get_invoice_facts",
    description:
      "Get the verified facts of the invoice being discussed: principal, due date, days overdue, interest, total due and the 31 March tax date. Call this before stating any figure. Takes no arguments.",
    parameters: parametersOf(GetFactsArgs),
  },
  {
    name: "record_promise_to_pay",
    description:
      "Record the buyer's promise to pay. Call only after you have read the amount back in rupees, in words (amount_words style), and the date exactly as its date_list entry is written, and then heard a clear yes from the buyer (haan, ji, yes, ok, theek hai or the like, not a vague answer such as shayad). amount_paise is the amount in paise. date_iso is the date as YYYY-MM-DD, taken from the date list. spoken_text is what the buyer said.",
    parameters: parametersOf(RecordPromiseArgs),
  },
  {
    name: "end_call",
    description:
      "Record why the call is ending without a promise and end it: dispute (buyer disputes the invoice), no_promise (buyer asks not to be called), or consent_declined (buyer objects to the AI or the recording).",
    parameters: parametersOf(EndCallArgs),
  },
];

export type ParsedArgs =
  | { ok: true; name: "get_invoice_facts"; args: GetFactsArgsT }
  | { ok: true; name: "record_promise_to_pay"; args: RecordPromiseArgsT }
  | { ok: true; name: "end_call"; args: EndCallArgsT };

export type ParseToolArgsResult = ParsedArgs | { ok: false; error: "unknown_tool" | "invalid_arguments" };

/** Parses the raw arguments string of a function call. Never throws. */
export function parseToolArgs(name: string, raw: string): ParseToolArgsResult {
  if (!Object.prototype.hasOwnProperty.call(SCHEMAS, name)) return { ok: false, error: "unknown_tool" };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid_arguments" };
  }
  switch (name as CallToolName) {
    case "get_invoice_facts": {
      const r = GetFactsArgs.safeParse(json);
      return r.success ? { ok: true, name: "get_invoice_facts", args: r.data } : { ok: false, error: "invalid_arguments" };
    }
    case "record_promise_to_pay": {
      const r = RecordPromiseArgs.safeParse(json);
      return r.success
        ? { ok: true, name: "record_promise_to_pay", args: r.data }
        : { ok: false, error: "invalid_arguments" };
    }
    case "end_call": {
      const r = EndCallArgs.safeParse(json);
      return r.success ? { ok: true, name: "end_call", args: r.data } : { ok: false, error: "invalid_arguments" };
    }
  }
}
