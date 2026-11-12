import {
  APPROVAL_STEP_LIST,
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
  date,
  foreignKey,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
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

// Column helpers. Dates are calendar days (string mode, "YYYY-MM-DD"); instants are timestamptz.
const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const paise = (name: string) => bigint(name, { mode: "number" });
const day = (name: string) => date(name, { mode: "string" });

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
    createdAt: createdAt(),
  },
  (t) => [
    unique("buyers_supplier_name_key").on(t.supplierId, t.nameKey),
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

export const escalationEvents = pgTable("escalation_events", {
  id: id(),
  invoiceId: invoiceId(),
  step: ladderStep("step").notNull(),
  occurredOn: day("occurred_on").notNull(),
  createdAt: createdAt(),
});

export const promises = pgTable(
  "promises",
  {
    id: id(),
    invoiceId: invoiceId(),
    promisedDate: day("promised_date").notNull(),
    amountPaise: paise("amount_paise").notNull(),
    recordedOn: day("recorded_on").notNull(),
    createdAt: createdAt(),
  },
  (t) => [check("promises_amount_range", sql`${t.amountPaise} between 1 and ${sql.raw(String(MAX_PAISE))}`)],
);

export const messages = pgTable("messages", {
  id: id(),
  invoiceId: invoiceId(),
  channel: text("channel").notNull(),
  direction: text("direction").notNull(),
  body: text("body").notNull(),
  status: text("status").notNull(),
  createdAt: createdAt(),
});

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
    createdAt: createdAt(),
  },
  (t) => [check("payment_links_amount_range", sql`${t.amountPaise} between 1 and ${sql.raw(String(MAX_PAISE))}`)],
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
export type EscalationEventRow = typeof escalationEvents.$inferSelect;
export type PromiseRow = typeof promises.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type CallRow = typeof calls.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type PaymentLinkRow = typeof paymentLinks.$inferSelect;
export type AgentRunRow = typeof agentRuns.$inferSelect;
export type ConfigRow = typeof config.$inferSelect;
