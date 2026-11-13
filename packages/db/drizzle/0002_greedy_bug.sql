CREATE TYPE "public"."draft_language" AS ENUM('hinglish', 'english');--> statement-breakpoint
CREATE TYPE "public"."draft_status" AS ENUM('pending', 'approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."escalation_action" AS ENUM('drafted', 'edited', 'approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"step" "ladder_step" NOT NULL,
	"status" "draft_status" DEFAULT 'pending' NOT NULL,
	"language" "draft_language" NOT NULL,
	"body_text" text NOT NULL,
	"final_text" text NOT NULL,
	"rule_ids" text[] NOT NULL,
	"model_id" text NOT NULL,
	"decision" jsonb NOT NULL,
	"document" "bytea",
	"created_on" date NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drafts_body_not_blank" CHECK (btrim("drafts"."body_text") <> '')
);
--> statement-breakpoint
-- Existing rows were all approved steps, so they backfill as 'approved'. The default is dropped
-- right after, so new rows must name their action.
ALTER TABLE "escalation_events" ADD COLUMN "action" "escalation_action" NOT NULL DEFAULT 'approved';--> statement-breakpoint
ALTER TABLE "escalation_events" ALTER COLUMN "action" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "escalation_events" ADD COLUMN "draft_id" uuid;--> statement-breakpoint
ALTER TABLE "escalation_events" ADD COLUMN "detail" jsonb;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drafts_one_pending_per_invoice" ON "drafts" USING btree ("invoice_id") WHERE "drafts"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "escalation_events" ADD CONSTRAINT "escalation_events_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE restrict ON UPDATE no action;