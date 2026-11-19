CREATE TYPE "public"."promise_source" AS ENUM('manual', 'voice');--> statement-breakpoint
CREATE TYPE "public"."transcript_speaker" AS ENUM('buyer', 'agent');--> statement-breakpoint
CREATE TYPE "public"."voice_call_outcome" AS ENUM('promise', 'dispute', 'no_promise', 'incomplete', 'consent_declined');--> statement-breakpoint
CREATE TYPE "public"."voice_call_status" AS ENUM('created', 'live', 'ended', 'expired');--> statement-breakpoint
CREATE TABLE "voice_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"buyer_id" uuid NOT NULL,
	"call_today" date NOT NULL,
	"token_hash" text NOT NULL,
	"token_expires_at" timestamp with time zone NOT NULL,
	"status" "voice_call_status" DEFAULT 'created' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"outcome" "voice_call_outcome",
	"requested_outcome" "voice_call_outcome",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voice_calls_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "voice_calls_token_hash_format" CHECK ("voice_calls"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "voice_calls_duration_range" CHECK ("voice_calls"."duration_seconds" is null or "voice_calls"."duration_seconds" between 0 and 300),
	CONSTRAINT "voice_calls_requested_outcome_values" CHECK ("voice_calls"."requested_outcome" is null or "voice_calls"."requested_outcome" in ('dispute', 'no_promise', 'consent_declined')),
	CONSTRAINT "voice_calls_started_iff_joined" CHECK (("voice_calls"."status" in ('created', 'expired')) = ("voice_calls"."started_at" is null)),
	CONSTRAINT "voice_calls_ended_fields" CHECK (("voice_calls"."status" = 'ended') = ("voice_calls"."ended_at" is not null and "voice_calls"."outcome" is not null and "voice_calls"."duration_seconds" is not null))
);
--> statement-breakpoint
CREATE TABLE "voice_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"voice_call_id" uuid NOT NULL,
	"call_id" text NOT NULL,
	"tool" text NOT NULL,
	"arguments" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voice_tool_calls_call_id_key" UNIQUE("voice_call_id","call_id"),
	CONSTRAINT "voice_tool_calls_call_id_format" CHECK ("voice_tool_calls"."call_id" ~ '^[A-Za-z0-9_-]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "voice_transcript_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"voice_call_id" uuid NOT NULL,
	"speaker" "transcript_speaker" NOT NULL,
	"item_id" text NOT NULL,
	"text" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voice_transcript_lines_call_item_key" UNIQUE("voice_call_id","item_id"),
	CONSTRAINT "voice_transcript_lines_text_length" CHECK (char_length("voice_transcript_lines"."text") between 1 and 2000)
);
--> statement-breakpoint
ALTER TABLE "promises" ADD COLUMN "source" "promise_source" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "promises" ADD COLUMN "voice_call_id" uuid;--> statement-breakpoint
ALTER TABLE "promises" ADD COLUMN "spoken_text" text;--> statement-breakpoint
ALTER TABLE "promises" ADD COLUMN "is_partial" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "promises" ADD COLUMN "superseded_on" date;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_buyer_id_buyers_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."buyers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_tool_calls" ADD CONSTRAINT "voice_tool_calls_voice_call_id_voice_calls_id_fk" FOREIGN KEY ("voice_call_id") REFERENCES "public"."voice_calls"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_transcript_lines" ADD CONSTRAINT "voice_transcript_lines_voice_call_id_voice_calls_id_fk" FOREIGN KEY ("voice_call_id") REFERENCES "public"."voice_calls"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voice_calls_buyer_started_idx" ON "voice_calls" USING btree ("buyer_id","started_at");--> statement-breakpoint
ALTER TABLE "promises" ADD CONSTRAINT "promises_voice_call_id_voice_calls_id_fk" FOREIGN KEY ("voice_call_id") REFERENCES "public"."voice_calls"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Hand-edited: keep every existing promise, but mark all but the newest per invoice as replaced on
-- the day the next one was recorded. This must run before the partial unique index below, which
-- allows only one promise per invoice with superseded_on IS NULL.
UPDATE "promises" p SET "superseded_on" = n."next_recorded_on"
FROM (
	SELECT "id", lead("recorded_on") OVER (PARTITION BY "invoice_id" ORDER BY "recorded_on", "id") AS "next_recorded_on"
	FROM "promises"
) n
WHERE p."id" = n."id" AND n."next_recorded_on" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "promises_one_current_per_invoice" ON "promises" USING btree ("invoice_id") WHERE "promises"."superseded_on" is null;--> statement-breakpoint
ALTER TABLE "promises" ADD CONSTRAINT "promises_spoken_text_length" CHECK ("promises"."spoken_text" is null or char_length("promises"."spoken_text") between 1 and 2000);--> statement-breakpoint
ALTER TABLE "promises" ADD CONSTRAINT "promises_superseded_after_recorded" CHECK ("promises"."superseded_on" is null or "promises"."superseded_on" >= "promises"."recorded_on");--> statement-breakpoint
ALTER TABLE "promises" ADD CONSTRAINT "promises_voice_fields" CHECK (("promises"."source" = 'voice') = ("promises"."voice_call_id" is not null and "promises"."spoken_text" is not null));