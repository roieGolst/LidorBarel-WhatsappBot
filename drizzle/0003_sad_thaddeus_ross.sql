ALTER TYPE "public"."conversation_stage" ADD VALUE 'assessing_motivation' BEFORE 'qualified';--> statement-breakpoint
ALTER TYPE "public"."conversation_stage" ADD VALUE 'needs_review' BEFORE 'disqualified';--> statement-breakpoint
ALTER TYPE "public"."disqualification_reason" ADD VALUE 'spam_or_abuse';--> statement-breakpoint
ALTER TYPE "public"."disqualification_reason" ADD VALUE 'off_topic_abandoned';--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"path" text NOT NULL,
	"sha256" text NOT NULL,
	"media_id" text,
	"type" text NOT NULL,
	"neighborhoods" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"audience" text,
	"uploaded_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "screening_state" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_path_unique" ON "media_assets" USING btree ("path");