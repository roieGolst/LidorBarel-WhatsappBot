CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"path" text NOT NULL,
	"type" text NOT NULL,
	"neighborhoods" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"audience" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_path_unique" ON "media_assets" USING btree ("path");