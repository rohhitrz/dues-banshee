ALTER TYPE "public"."escalation_action" ADD VALUE 'sent';--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_provider_event_id_key" UNIQUE("provider","event_id")
);
--> statement-breakpoint
ALTER TABLE "buyers" ADD COLUMN "whatsapp_number" text;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "send_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "draft_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "provider_message_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "payment_links" ADD COLUMN "draft_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_links" ADD COLUMN "created_on" date;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_one_sent_per_draft" ON "messages" USING btree ("draft_id") WHERE "messages"."status" IN ('sent', 'handed_off');--> statement-breakpoint
CREATE UNIQUE INDEX "payment_links_draft_id_key" ON "payment_links" USING btree ("draft_id");--> statement-breakpoint
ALTER TABLE "buyers" ADD CONSTRAINT "buyers_whatsapp_number_e164" CHECK ("buyers"."whatsapp_number" ~ '^\+[1-9][0-9]{7,14}$');