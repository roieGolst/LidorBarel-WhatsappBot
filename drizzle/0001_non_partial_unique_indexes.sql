DROP INDEX "campaign_referrals_external_lead_unique";--> statement-breakpoint
DROP INDEX "listings_source_external_id_unique";--> statement-breakpoint
DROP INDEX "messages_provider_message_id_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_referrals_external_lead_unique" ON "campaign_referrals" USING btree ("external_lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "listings_source_external_id_unique" ON "listings" USING btree ("source","external_listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_message_id_unique" ON "messages" USING btree ("provider_message_id");