-- pgvector backs needs.embedding; drizzle-kit does not emit extensions.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."actor_kind" AS ENUM('human', 'agent');--> statement-breakpoint
CREATE TYPE "public"."attached_to" AS ENUM('existing', 'draft');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('web', 'mcp');--> statement-breakpoint
CREATE TYPE "public"."criterion_key" AS ENUM('demand', 'business_value', 'strategic_fit', 'effort');--> statement-breakpoint
CREATE TYPE "public"."decision_status" AS ENUM('planned', 'in_progress', 'shipped', 'declined');--> statement-breakpoint
CREATE TYPE "public"."need_status" AS ENUM('draft', 'open', 'planned', 'in_progress', 'shipped', 'declined', 'merged');--> statement-breakpoint
CREATE TYPE "public"."public_summary_status" AS ENUM('none', 'pending', 'approved');--> statement-breakpoint
CREATE TYPE "public"."score_source" AS ENUM('ai', 'pm');--> statement-breakpoint
CREATE TYPE "public"."suggestion_kind" AS ENUM('draft_need', 'merge', 'theme', 'priority', 'public_summary', 'split', 'decision_brief');--> statement-breakpoint
CREATE TYPE "public"."suggestion_status" AS ENUM('pending', 'accepted', 'edited', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."urgency" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TABLE "accounts" (
	"arr_cents" bigint DEFAULT 0 NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"open_deal_cents" bigint DEFAULT 0 NOT NULL,
	"plan" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"brief_markdown" text,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"need_id" uuid NOT NULL,
	"note" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by_kind" "actor_kind" NOT NULL,
	"status" "decision_status" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"actor_kind" "actor_kind" NOT NULL,
	"actor_ref" text NOT NULL,
	"dedupe_key" text,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"need_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"signal_id" uuid,
	"suggestion_id" uuid,
	"type" text NOT NULL,
	CONSTRAINT "events_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "health" (
	"ok" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merges" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"from_need_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"into_need_id" uuid NOT NULL,
	"moved_signal_ids" uuid[] NOT NULL,
	"undone_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "needs" (
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"embedding" vector(1536),
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merged_into_id" uuid,
	"public_summary" text,
	"public_summary_status" "public_summary_status" DEFAULT 'none' NOT NULL,
	"statement" text NOT NULL,
	"status" "need_status" DEFAULT 'draft' NOT NULL,
	"theme_id" uuid
);
--> statement-breakpoint
CREATE TABLE "priority_criteria" (
	"description" text DEFAULT '' NOT NULL,
	"key" "criterion_key" PRIMARY KEY NOT NULL,
	"weight" real NOT NULL,
	CONSTRAINT "priority_criteria_weight_range" CHECK ("priority_criteria"."weight" >= 0 and "priority_criteria"."weight" <= 1)
);
--> statement-breakpoint
CREATE TABLE "priority_scores" (
	"criterion" "criterion_key" NOT NULL,
	"need_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"score" real NOT NULL,
	"source" "score_source" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "priority_scores_need_id_criterion_pk" PRIMARY KEY("need_id","criterion"),
	CONSTRAINT "priority_scores_range" CHECK ("priority_scores"."score" >= 0 and "priority_scores"."score" <= 5)
);
--> statement-breakpoint
CREATE TABLE "proposed_solutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"need_id" uuid NOT NULL,
	"source_signal_id" uuid,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"actor_kind" "actor_kind" NOT NULL,
	"agent_client" text,
	"attached_to" "attached_to" NOT NULL,
	"body" text NOT NULL,
	"channel" "channel" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text,
	"need_id" uuid NOT NULL,
	"original_need_id" uuid NOT NULL,
	"submitter_id" uuid NOT NULL,
	"title" text NOT NULL,
	"tracking_token" text NOT NULL,
	"urgency" "urgency",
	"use_case" text,
	CONSTRAINT "signals_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "signals_tracking_token_unique" UNIQUE("tracking_token")
);
--> statement-breakpoint
CREATE TABLE "submitters" (
	"account_id" uuid,
	"email" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	CONSTRAINT "submitters_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "suggestions" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "suggestion_kind" NOT NULL,
	"model" text,
	"need_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"related_need_id" uuid,
	"resolved_at" timestamp with time zone,
	"resolved_by_kind" "actor_kind",
	"signal_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" "suggestion_status" DEFAULT 'pending' NOT NULL,
	"theme_id" uuid
);
--> statement-breakpoint
CREATE TABLE "themes" (
	"description" text DEFAULT '' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"strategic_weight" real DEFAULT 0.5 NOT NULL,
	CONSTRAINT "themes_name_unique" UNIQUE("name"),
	CONSTRAINT "themes_strategic_weight_range" CHECK ("themes"."strategic_weight" >= 0 and "themes"."strategic_weight" <= 1)
);
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_need_id_needs_id_fk" FOREIGN KEY ("need_id") REFERENCES "public"."needs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merges" ADD CONSTRAINT "merges_from_need_id_needs_id_fk" FOREIGN KEY ("from_need_id") REFERENCES "public"."needs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merges" ADD CONSTRAINT "merges_into_need_id_needs_id_fk" FOREIGN KEY ("into_need_id") REFERENCES "public"."needs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "needs" ADD CONSTRAINT "needs_theme_id_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."themes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "priority_scores" ADD CONSTRAINT "priority_scores_need_id_needs_id_fk" FOREIGN KEY ("need_id") REFERENCES "public"."needs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposed_solutions" ADD CONSTRAINT "proposed_solutions_need_id_needs_id_fk" FOREIGN KEY ("need_id") REFERENCES "public"."needs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposed_solutions" ADD CONSTRAINT "proposed_solutions_source_signal_id_signals_id_fk" FOREIGN KEY ("source_signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_need_id_needs_id_fk" FOREIGN KEY ("need_id") REFERENCES "public"."needs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_original_need_id_needs_id_fk" FOREIGN KEY ("original_need_id") REFERENCES "public"."needs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_submitter_id_submitters_id_fk" FOREIGN KEY ("submitter_id") REFERENCES "public"."submitters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submitters" ADD CONSTRAINT "submitters_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_need_id_needs_id_fk" FOREIGN KEY ("need_id") REFERENCES "public"."needs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_related_need_id_needs_id_fk" FOREIGN KEY ("related_need_id") REFERENCES "public"."needs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_theme_id_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."themes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decisions_need_idx" ON "decisions" USING btree ("need_id");--> statement-breakpoint
CREATE INDEX "events_type_occurred_idx" ON "events" USING btree ("type","occurred_at");--> statement-breakpoint
CREATE INDEX "events_need_idx" ON "events" USING btree ("need_id");--> statement-breakpoint
CREATE INDEX "needs_status_idx" ON "needs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "needs_theme_idx" ON "needs" USING btree ("theme_id");--> statement-breakpoint
CREATE INDEX "needs_embedding_idx" ON "needs" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "proposed_solutions_need_idx" ON "proposed_solutions" USING btree ("need_id");--> statement-breakpoint
CREATE INDEX "signals_need_idx" ON "signals" USING btree ("need_id");--> statement-breakpoint
CREATE INDEX "signals_submitter_idx" ON "signals" USING btree ("submitter_id");--> statement-breakpoint
CREATE INDEX "suggestions_status_kind_idx" ON "suggestions" USING btree ("status","kind");