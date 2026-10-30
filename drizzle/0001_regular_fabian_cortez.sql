CREATE TABLE "strategies" (
	"capacity_per_quarter" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_kind" "actor_kind" NOT NULL,
	"focus_theme_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notes" text,
	"readiness_arr_cents" bigint NOT NULL,
	"readiness_supporters" integer NOT NULL,
	"revenue_focus" text DEFAULT '' NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "strategies_version_unique" UNIQUE("version"),
	CONSTRAINT "strategies_capacity_nonnegative" CHECK ("strategies"."capacity_per_quarter" >= 0),
	CONSTRAINT "strategies_readiness_line" CHECK ("strategies"."readiness_arr_cents" >= 0 and "strategies"."readiness_supporters" >= 0 and ("strategies"."readiness_arr_cents" > 0 or "strategies"."readiness_supporters" > 0))
);
--> statement-breakpoint
ALTER TABLE "needs" ADD COLUMN "ready_at" timestamp with time zone;