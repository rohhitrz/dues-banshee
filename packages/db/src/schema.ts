import {
  APPROVAL_STEP_LIST,
  type EscalationDecision,
  LADDER_STEPS,
  MAX_PAISE,
  SUPPLIER_ACTIVITIES,
  SUPPLIER_CATEGORIES,
} from "@dues-banshee/engine";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Turns a readonly list of Engine constants into the non-empty tuple that `pgEnum` needs. */
const tuple = <T extends string>(v: readonly T[]): [T, ...T[]] => {
  if (v.length === 0) throw new Error("enum needs at least one value");
  return [...v] as [T, ...T[]];
};

// Enums. All but `approval_status` take their values from the Engine, so the two can't drift apart.
export const ladderStep = pgEnum("ladder_step", tuple(LADDER_STEPS));
export const approvalStep = pgEnum("approval_step", tuple(APPROVAL_STEP_LIST));
export const supplierCategory = pgEnum("supplier_category", tuple(SUPPLIER_CATEGORIES));
export const supplierActivity = pgEnum("supplier_activity", tuple(SUPPLIER_ACTIVITIES));
export const approvalStatus = pgEnum("approval_status", ["pending", "approved", "rejected"]);
export const draftStatus = pgEnum("draft_status", ["pending", "approved", "rejected", "expired"]);
export const draftLanguage = pgEnum("draft_language", ["hinglish", "english"]);
export const escalationAction = pgEnum("escalation_action", [
  "drafted",
  "edited",
  "approved",
  "rejected",
  "expired",
  "sent",
]);
export const voiceCallStatus = pgEnum("voice_call_status", ["created", "live", "ended", "expired"]);
export const voiceCallOutcome = pgEnum("voice_call_outcome", [
  "promise",
  "dispute",
  "no_promise",
  "incomplete",
  "consent_declined",
]);
export const transcriptSpeaker = pgEnum("transcript_speaker", ["buyer", "agent"]);
export const promiseSource = pgEnum("promise_source", ["manual", "voice"]);

// Column helpers. Dates are calendar days (string mode, "YYYY-MM-DD"); instants are timestamptz.
const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const paise = (name: string) => bigint(name, { mode: "number" });
const day = (name: string) => date(name, { mode: "string" });
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({ dataType: () => "bytea" });

export const suppliers = pgTable(
  "suppliers",
  {
    id: id(),
    name: text("name").notNull(),
    udyamNumber: text("udyam_number").notNull(),
    supplierCategory: supplierCategory("supplier_category").notNull(),
    supplierActivity: supplierActivity("supplier_activity").notNull(),
    udyamRegisteredOn: day("udyam_registered_on"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("suppliers_udyam_number_key").on(t.udyamNumber),
    check("suppliers_udyam_number_format", sql`${t.udyamNumber} ~ '^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$'`),
  ],
);

export const buyers = pgTable(
  "buyers",
  {
    id: id(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    /** E.164 WhatsApp number, e.g. `+919000000001`. Null until the owner or the demo seed sets it. */
    whatsappNumber: text("whatsapp_number"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("buyers_supplier_name_key").on(t.supplierId, t.nameKey),
    check("buyers_whatsapp_number_e164", sql`${t.whatsappNumber} ~ '^\\+[1-9][0-9]{7,14}$'`),
    // Target of the composite foreign key on invoices.
    unique("buyers_id_supplier_key").on(t.id, t.supplierId),
  ],
);

export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    buyerId: uuid("buyer_id").notNull(),
    invoiceNumber: text("invoice_number").notNull(),
    invoiceNumberKey: text("invoice_number_key").notNull(),
    invoiceDate: day("invoice_date").notNull(),
    acceptedOn: day("accepted_on").notNull(),
    acceptanceDateDefaulted: boolean("acceptance_date_defaulted").notNull().default(false),
    agreedTermDays: integer("agreed_term_days"),
    amountPaise: paise("amount_paise").notNull(),
    paidOn: day("paid_on"),
    supplierCategory: supplierCategory("supplier_category").notNull(),
    supplierActivity: supplierActivity("supplier_activity").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("invoices_dedupe_key").on(t.supplierId, t.buyerId, t.invoiceNumberKey),
    // An invoice can't point at another supplier's buyer.
    foreignKey({
      name: "invoices_buyer_supplier_fkey",
      columns: [t.buyerId, t.supplierId],
      foreignColumns: [buyers.id, buyers.supplierId],
    }).onDelete("restrict"),
    check("invoices_amount_range", sql`${t.amountPaise} between 1 and ${sql.raw(String(MAX_PAISE))}`),
    check("invoices_term_positive", sql`${t.agreedTermDays} is null or ${t.agreedTermDays} > 0`),
  ],
);

const invoiceId = () =>
  uuid("invoice_id")
    .notNull()
    .references(() => invoices.id, { onDelete: "restrict" });

/**
 * An LLM draft waiting for the owner's decision. There is no `supplier_id`: ownership is always
 * reached through `invoices.supplier_id`, so a Draft can't disagree with its invoice.
 */
export const drafts = pgTable(
  "drafts",
  {
    id: id(),
    invoiceId: invoiceId(),
    step: ladderStep("step").notNull(),
    status: draftStatus("status").notNull().default("pending"),
    language: draftLanguage("language").notNull(),
    bodyText: text("body_text").notNull(),
    finalText: text("final_text").notNull(),
    ruleIds: text("rule_ids").array().notNull(),
    modelId: text("model_id").notNull(),
    decision: jsonb("decision").$type<EscalationDecision>().notNull(),
    document: bytea("document"),
    createdOn: day("created_on").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** Set while one send request holds the claim on this Draft; cleared on failure, expires after a lease. */
    sendClaimedAt: timestamp("send_claimed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // At most one pending Draft per invoice.
    uniqueIndex("drafts_one_pending_per_invoice")
      .on(t.invoiceId)
      .where(sql`${t.status} = 'pending'`),
    check("drafts_body_not_blank", sql`btrim(${t.bodyText}) <> ''`),
  ],
);
/**
 * What an `edited`, `rejected` or `sent` event records: the text before and after, the reject
 * reason, or the channel and the Message_Row of a send.
 */
export type EscalationDetail =
  | { before: string; after: string }
  | { reason: string | null }
  | { channel: "twilio_sandbox" | "wa_me"; messageRowId: string };
/** Only rows with `action = 'approved'` count as ladder steps; the rest are the Draft audit trail. */
export const escalationEvents = pgTable("escalation_events", {
  id: id(),
  invoiceId: invoiceId(),
  step: ladderStep("step").notNull(),
  occurredOn: day("occurred_on").notNull(),
  action: escalationAction("action").notNull(),
  draftId: uuid("draft_id").references(() => drafts.id, { onDelete: "restrict" }),
  detail: jsonb("detail").$type<EscalationDetail>(),
  createdAt: createdAt(),
});
/**
 * One buyer voice call, bound to one invoice. The Join_Token is never stored, only its SHA-256 hex
 * in `token_hash`. `started_at` is set when the buyer joins, `ended_at`, `outcome` and
 * `duration_seconds` when the call ends. No raw audio is stored.
 */
export const voiceCalls = pgTable(
  "voice_calls",
  {
    id: id(),
    invoiceId: invoiceId(),
    buyerId: uuid("buyer_id")
      .notNull()
      .references(() => buyers.id, { onDelete: "restrict" }),
    /** The Today in effect when the owner started the call. */
    callToday: day("call_today").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }).notNull(),
    status: voiceCallStatus("status").notNull().default("created"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds"),
    outcome: voiceCallOutcome("outcome"),
    /** What the agent's `end_call` tool asked for; `endVoiceCall` turns it into `outcome`. */
    requestedOutcome: voiceCallOutcome("requested_outcome"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("voice_calls_token_hash_key").on(t.tokenHash),
    index("voice_calls_buyer_started_idx").on(t.buyerId, t.startedAt),
    check("voice_calls_token_hash_format", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check("voice_calls_duration_range", sql`${t.durationSeconds} is null or ${t.durationSeconds} between 0 and 300`),
    check(
      "voice_calls_requested_outcome_values",
      sql`${t.requestedOutcome} is null or ${t.requestedOutcome} in ('dispute', 'no_promise', 'consent_declined')`,
    ),
    check(
      "voice_calls_started_iff_joined",
      sql`(${t.status} in ('created', 'expired')) = (${t.startedAt} is null)`,
    ),
    check(
      "voice_calls_ended_fields",
      sql`(${t.status} = 'ended') = (${t.endedAt} is not null and ${t.outcome} is not null and ${t.durationSeconds} is not null)`,
    ),
  ],
);

export const voiceTranscriptLines = pgTable(
  "voice_transcript_lines",
  {
    id: id(),
    voiceCallId: uuid("voice_call_id")
      .notNull()
      .references(() => voiceCalls.id, { onDelete: "restrict" }),
    speaker: transcriptSpeaker("speaker").notNull(),
    /** The Realtime item id; a repeated delivery of the same item is dropped. */
    itemId: text("item_id").notNull(),
    text: text("text").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("voice_transcript_lines_call_item_key").on(t.voiceCallId, t.itemId),
    check("voice_transcript_lines_text_length", sql`char_length(${t.text}) between 1 and 2000`),
  ],
);

/** One row per model function call (`call_id`), so a repeated call returns the stored result. */
export const voiceToolCalls = pgTable(
  "voice_tool_calls",
  {
    id: id(),
    voiceCallId: uuid("voice_call_id")
      .notNull()
      .references(() => voiceCalls.id, { onDelete: "restrict" }),
    callId: text("call_id").notNull(),
    tool: text("tool").notNull(),
    /** The raw arguments string as the model sent it. */
    arguments: text("arguments").notNull(),
    /** Null only inside the transaction that claimed the row. */
    result: jsonb("result"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("voice_tool_calls_call_id_key").on(t.voiceCallId, t.callId),
    check("voice_tool_calls_call_id_format", sql`${t.callId} ~ '^[A-Za-z0-9_-]{1,64}$'`),
  ],
);

export const promises = pgTable(
  "promises",
  {
    id: id(),
    invoiceId: invoiceId(),
    promisedDate: day("promised_date").notNull(),
    amountPaise: paise("amount_paise").notNull(),
    recordedOn: day("recorded_on").notNull(),
    source: promiseSource("source").notNull().default("manual"),
    voiceCallId: uuid("voice_call_id").references(() => voiceCalls.id, { onDelete: "restrict" }),
    spokenText: text("spoken_text"),
    isPartial: boolean("is_partial").notNull().default(false),
    /** The day a newer promise replaced this one. Null for the Current_Promise. */
    supersededOn: day("superseded_on"),
    createdAt: createdAt(),
  },
  (t) => [
    check("promises_amount_range", sql`${t.amountPaise} between 1 and ${sql.raw(String(MAX_PAISE))}`),
    check("promises_spoken_text_length", sql`${t.spokenText} is null or char_length(${t.spokenText}) between 1 and 2000`),
    check("promises_superseded_after_recorded", sql`${t.supersededOn} is null or ${t.supersededOn} >= ${t.recordedOn}`),
    check(
      "promises_voice_fields",
      sql`(${t.source} = 'voice') = (${t.voiceCallId} is not null and ${t.spokenText} is not null)`,
    ),
    // At most one Current_Promise per invoice.
    uniqueIndex("promises_one_current_per_invoice")
      .on(t.invoiceId)
      .where(sql`${t.supersededOn} is null`),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    invoiceId: invoiceId(),
    channel: text("channel").notNull(),
    direction: text("direction").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull(),
    draftId: uuid("draft_id").references(() => drafts.id, { onDelete: "restrict" }),
    providerMessageId: text("provider_message_id"),
    errorCode: text("error_code"),
    createdAt: createdAt(),
  },
  (t) => [
    // One Sent_Message per Draft. `failed` rows are not limited.
    uniqueIndex("messages_one_sent_per_draft")
      .on(t.draftId)
      .where(sql`${t.status} IN ('sent', 'handed_off')`),
  ],
);

export const calls = pgTable("calls", {
  id: id(),
  invoiceId: invoiceId(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  transcript: text("transcript"),
  createdAt: createdAt(),
});

export const approvals = pgTable("approvals", {
  id: id(),
  invoiceId: invoiceId(),
  step: approvalStep("step").notNull(),
  status: approvalStatus("status").notNull().default("pending"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const paymentLinks = pgTable(
  "payment_links",
  {
    id: id(),
    invoiceId: invoiceId(),
    providerLinkId: text("provider_link_id").notNull(),
    url: text("url").notNull(),
    amountPaise: paise("amount_paise").notNull(),
    status: text("status").notNull(),
    draftId: uuid("draft_id").references(() => drafts.id, { onDelete: "restrict" }),
    /** The Today in effect when the link was created (the demo supplier's Payment_Day). */
    createdOn: day("created_on"),
    createdAt: createdAt(),
  },
  (t) => [
    check("payment_links_amount_range", sql`${t.amountPaise} between 1 and ${sql.raw(String(MAX_PAISE))}`),
    // One Pay_Link per Draft.
    uniqueIndex("payment_links_draft_id_key").on(t.draftId),
    // The Razorpay webhook finds the link by this id, so two rows must never share one.
    uniqueIndex("payment_links_provider_link_id_key").on(t.providerLinkId),
  ],
);

/** Provider event ids already processed, so a repeated webhook delivery is a no-op. */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: id(),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("webhook_events_provider_event_id_key").on(t.provider, t.eventId)],
);

export const agentRuns = pgTable("agent_runs", {
  id: id(),
  tool: text("tool").notNull(),
  input: jsonb("input").notNull(),
  output: jsonb("output"),
  invoiceId: uuid("invoice_id").references(() => invoices.id, { onDelete: "restrict" }),
  createdAt: createdAt(),
});

export const config = pgTable(
  "config",
  {
    id: id(),
    key: text("key").notNull(),
    valueInt: integer("value_int").notNull(),
    effectiveFrom: day("effective_from").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("config_key_effective_from_key").on(t.key, t.effectiveFrom)],
);

export type SupplierRow = typeof suppliers.$inferSelect;
export type NewSupplierRow = typeof suppliers.$inferInsert;
export type BuyerRow = typeof buyers.$inferSelect;
export type NewBuyerRow = typeof buyers.$inferInsert;
export type InvoiceRow = typeof invoices.$inferSelect;
export type NewInvoiceRow = typeof invoices.$inferInsert;
export type DraftRow = typeof drafts.$inferSelect;
export type NewDraftRow = typeof drafts.$inferInsert;
export type EscalationEventRow = typeof escalationEvents.$inferSelect;
export type PromiseRow = typeof promises.$inferSelect;
export type VoiceCallRow = typeof voiceCalls.$inferSelect;
export type VoiceTranscriptLineRow = typeof voiceTranscriptLines.$inferSelect;
export type VoiceToolCallRow = typeof voiceToolCalls.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type CallRow = typeof calls.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type PaymentLinkRow = typeof paymentLinks.$inferSelect;
export type AgentRunRow = typeof agentRuns.$inferSelect;
export type WebhookEventRow = typeof webhookEvents.$inferSelect;
export type ConfigRow = typeof config.$inferSelect;
