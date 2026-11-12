CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."approval_step" AS ENUM('voice_call', 'legal_notice', 'odr_pack');--> statement-breakpoint
CREATE TYPE "public"."ladder_step" AS ENUM('whatsapp_nudge', 'whatsapp_paylink', 'voice_call', 'legal_notice', 'odr_pack');--> statement-breakpoint
CREATE TYPE "public"."supplier_activity" AS ENUM('manufacturing', 'services', 'trading');--> statement-breakpoint
CREATE TYPE "public"."supplier_category" AS ENUM('micro', 'small', 'medium', 'unregistered');--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tool" text NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"invoice_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"step" "approval_step" NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buyers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buyers_supplier_name_key" UNIQUE("supplier_id","name_key"),
	CONSTRAINT "buyers_id_supplier_key" UNIQUE("id","supplier_id")
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"transcript" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"value_int" integer NOT NULL,
	"effective_from" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "config_key_effective_from_key" UNIQUE("key","effective_from")
);
--> statement-breakpoint
CREATE TABLE "escalation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"step" "ladder_step" NOT NULL,
	"occurred_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_id" uuid NOT NULL,
	"buyer_id" uuid NOT NULL,
	"invoice_number" text NOT NULL,
	"invoice_number_key" text NOT NULL,
	"invoice_date" date NOT NULL,
	"accepted_on" date NOT NULL,
	"acceptance_date_defaulted" boolean DEFAULT false NOT NULL,
	"agreed_term_days" integer,
	"amount_paise" bigint NOT NULL,
	"paid_on" date,
	"supplier_category" "supplier_category" NOT NULL,
	"supplier_activity" "supplier_activity" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_dedupe_key" UNIQUE("supplier_id","buyer_id","invoice_number_key"),
	CONSTRAINT "invoices_amount_range" CHECK ("invoices"."amount_paise" between 1 and 1000000000000),
	CONSTRAINT "invoices_term_positive" CHECK ("invoices"."agreed_term_days" is null or "invoices"."agreed_term_days" > 0)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"direction" text NOT NULL,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"provider_link_id" text NOT NULL,
	"url" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"promised_date" date NOT NULL,
	"amount_paise" bigint NOT NULL,
	"recorded_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"udyam_number" text NOT NULL,
	"supplier_category" "supplier_category" NOT NULL,
	"supplier_activity" "supplier_activity" NOT NULL,
	"udyam_registered_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_udyam_number_key" UNIQUE("udyam_number"),
	CONSTRAINT "suppliers_udyam_number_format" CHECK ("suppliers"."udyam_number" ~ '^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$')
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyers" ADD CONSTRAINT "buyers_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalation_events" ADD CONSTRAINT "escalation_events_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_buyer_supplier_fkey" FOREIGN KEY ("buyer_id","supplier_id") REFERENCES "public"."buyers"("id","supplier_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promises" ADD CONSTRAINT "promises_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;