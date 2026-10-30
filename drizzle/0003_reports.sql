CREATE TABLE "reports" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_kind" "actor_kind" NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prompt" text NOT NULL,
	"shared_at" timestamp with time zone,
	"share_token" text,
	"snapshot" jsonb NOT NULL,
	"snapshot_at" timestamp with time zone NOT NULL,
	"spec" jsonb NOT NULL,
	"title" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_share_token_unique" UNIQUE("share_token")
);
