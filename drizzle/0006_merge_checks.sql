CREATE TABLE "merge_checks" (
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"draft_supporters" integer NOT NULL,
	"need_id" uuid PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE "merge_checks" ADD CONSTRAINT "merge_checks_need_id_needs_id_fk" FOREIGN KEY ("need_id") REFERENCES "public"."needs"("id") ON DELETE no action ON UPDATE no action;