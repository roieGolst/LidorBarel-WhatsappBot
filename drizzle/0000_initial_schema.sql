CREATE TYPE "public"."appointment_status" AS ENUM('pending', 'approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."consent_status" AS ENUM('none', 'privacy_policy_only', 'whatsapp_opt_in', 'opted_out');--> statement-breakpoint
CREATE TYPE "public"."conversation_stage" AS ENUM('new', 'awaiting_first_contact', 'engaged', 'screening_neighborhood', 'screening_currently_marketed', 'qualified', 'disqualified', 'appointment_proposed', 'appointment_pending', 'appointment_confirmed', 'handed_off', 'awaiting_reply', 'closed_no_response', 'opted_out', 'error');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('pending', 'sent', 'delivered', 'read', 'failed');--> statement-breakpoint
CREATE TYPE "public"."disqualification_reason" AS ENUM('not_selling', 'no_urgency', 'exclusive_with_other_agent', 'uncooperative');--> statement-breakpoint
CREATE TYPE "public"."entry_point" AS ENUM('meta_lead_form', 'click_to_whatsapp', 'direct_message', 'website', 'referral', 'manual');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'processing', 'delivered', 'failed');--> statement-breakpoint
CREATE TABLE "appointment_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"proposed_slots" jsonb NOT NULL,
	"selected_slot" timestamp with time zone,
	"status" "appointment_status" DEFAULT 'pending' NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"google_event_id" text,
	"monday_activity_item_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_referrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"ad_id" text,
	"form_id" text,
	"external_lead_id" text,
	"source_url" text,
	"headline" text,
	"raw_payload" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"name" text,
	"email" text,
	"gender" text,
	"consent_status" "consent_status" DEFAULT 'none' NOT NULL,
	"consent_source" text,
	"consent_text" text,
	"consent_recorded_at" timestamp with time zone,
	"entry_point" "entry_point",
	"do_not_contact" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"listing_id" uuid,
	"stage" "conversation_stage" DEFAULT 'new' NOT NULL,
	"qualified" boolean,
	"disqualification_reason" "disqualification_reason",
	"priority_score" integer,
	"extracted" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"window_expires_at" timestamp with time zone,
	"monday_item_id" text,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"followup_count" integer DEFAULT 0 NOT NULL,
	"next_followup_at" timestamp with time zone,
	"handed_off_at" timestamp with time zone,
	"error_state" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"from_stage" text,
	"to_stage" text,
	"actor" text DEFAULT 'system' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_url" text,
	"external_listing_id" text,
	"listing_date" timestamp with time zone,
	"asking_price" numeric,
	"status" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" "message_direction" NOT NULL,
	"body" text,
	"media_type" text,
	"media_url" text,
	"provider_message_id" text,
	"delivery_status" "delivery_status",
	"template_ref" text,
	"llm_model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"cost_usd" numeric(12, 8),
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opt_outs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"reason" text,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"normalized_address" text,
	"street" text,
	"neighborhood" text,
	"city" text DEFAULT 'באר שבע',
	"property_type" text,
	"rooms" numeric,
	"size_sqm" integer,
	"floor" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appointment_requests" ADD CONSTRAINT "appointment_requests_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_referrals" ADD CONSTRAINT "campaign_referrals_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_requests_conversation_idx" ON "appointment_requests" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "appointment_requests_status_idx" ON "appointment_requests" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_referrals_external_lead_unique" ON "campaign_referrals" USING btree ("external_lead_id") WHERE "campaign_referrals"."external_lead_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "campaign_referrals_contact_idx" ON "campaign_referrals" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_phone_unique" ON "contacts" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "contacts_do_not_contact_idx" ON "contacts" USING btree ("do_not_contact");--> statement-breakpoint
CREATE INDEX "conversations_contact_idx" ON "conversations" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "conversations_stage_idx" ON "conversations" USING btree ("stage");--> statement-breakpoint
CREATE INDEX "conversations_next_followup_idx" ON "conversations" USING btree ("next_followup_at");--> statement-breakpoint
CREATE INDEX "conversations_monday_item_idx" ON "conversations" USING btree ("monday_item_id");--> statement-breakpoint
CREATE INDEX "events_aggregate_idx" ON "events" USING btree ("aggregate_type","aggregate_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "listings_source_external_id_unique" ON "listings" USING btree ("source","external_listing_id") WHERE "listings"."external_listing_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "listings_contact_idx" ON "listings" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "listings_property_idx" ON "listings" USING btree ("property_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_message_id_unique" ON "messages" USING btree ("provider_message_id") WHERE "messages"."provider_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "opt_outs_phone_unique" ON "opt_outs" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "outbox_aggregate_idx" ON "outbox" USING btree ("aggregate_type","aggregate_id");--> statement-breakpoint
CREATE INDEX "properties_normalized_address_idx" ON "properties" USING btree ("normalized_address");