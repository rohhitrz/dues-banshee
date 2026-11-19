// Texts of the "Start call" control. Plain constants with no imports, so the client component can use them
// without pulling @dues-banshee/db or @dues-banshee/agent into the browser bundle.

/** Call_Copy. */
export const CALL_COPY = "AI call over the internet. Phone (PSTN) calls are on the roadmap.";

/** Same wording as the agent package's DISCLAIMER; kept here because the browser must not import the agent. */
export const CALL_DISCLAIMER = "Reminders a supplier sends to its own buyers. Not legal advice.";

/** Demo_Hours_Text. */
export const DEMO_HOURS_TEXT =
  "Demo account: call hours not enforced. Real accounts: 10:00–19:00 IST, Monday to Saturday.";

export const NOT_CONFIGURED_TEXT = "Voice calls not configured";
export const NOT_CALLABLE_TEXT = "No call needed for this invoice";
