CREATE TYPE "public"."assistant_action_status" AS ENUM('proposed', 'confirmed', 'rejected', 'expired', 'failed');--> statement-breakpoint
CREATE TABLE "assistant_actions" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"error_code" text,
	"expires_at" timestamp with time zone NOT NULL,
	"fingerprint" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"input" jsonb NOT NULL,
	"operation" text NOT NULL,
	"preview" jsonb NOT NULL,
	"resolved_at" timestamp with time zone,
	"result" jsonb,
	"status" "assistant_action_status" DEFAULT 'proposed' NOT NULL
);
