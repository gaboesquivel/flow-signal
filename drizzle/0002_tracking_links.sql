CREATE TABLE "tracking_links" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	CONSTRAINT "tracking_links_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "tracking_link_id" uuid;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_tracking_link_id_tracking_links_id_fk" FOREIGN KEY ("tracking_link_id") REFERENCES "public"."tracking_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signals_tracking_link_idx" ON "signals" USING btree ("tracking_link_id");