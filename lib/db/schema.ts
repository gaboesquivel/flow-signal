import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

/** Embedding width of `SIGNAL_EMBEDDING_MODEL` (default `openai/text-embedding-3-small`). */
export const EMBEDDING_DIMENSIONS = 1536;

export const health = pgTable("health", {
  ok: integer("ok").notNull(),
});

// Enums hold the values spec 001 lists. Event types stay free text so new operations add types
// without a migration (see `lib/signal/events.ts`).
export const needStatus = pgEnum("need_status", [
  "draft",
  "open",
  "planned",
  "in_progress",
  "shipped",
  "declined",
  "merged",
]);
export const publicSummaryStatus = pgEnum("public_summary_status", ["none", "pending", "approved"]);
export const urgency = pgEnum("urgency", ["low", "medium", "high"]);
export const channel = pgEnum("channel", ["web", "mcp"]);
export const actorKind = pgEnum("actor_kind", ["human", "agent"]);
export const attachedTo = pgEnum("attached_to", ["existing", "draft"]);
export const criterionKey = pgEnum("criterion_key", [
  "demand",
  "business_value",
  "strategic_fit",
  "effort",
]);
export const scoreSource = pgEnum("score_source", ["ai", "pm"]);
export const suggestionKind = pgEnum("suggestion_kind", [
  "draft_need",
  "merge",
  "theme",
  "priority",
  "public_summary",
  "split",
  "decision_brief",
]);
export const suggestionStatus = pgEnum("suggestion_status", [
  "pending",
  "accepted",
  "edited",
  "rejected",
]);
export const decisionStatus = pgEnum("decision_status", [
  "planned",
  "in_progress",
  "shipped",
  "declined",
]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const accounts = pgTable("accounts", {
  arrCents: bigint("arr_cents", { mode: "number" }).notNull().default(0),
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  openDealCents: bigint("open_deal_cents", { mode: "number" }).notNull().default(0),
  plan: text("plan").notNull(),
});

export const submitters = pgTable("submitters", {
  accountId: uuid("account_id").references(() => accounts.id),
  email: text("email").notNull().unique(),
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name"),
});

export const themes = pgTable(
  "themes",
  {
    description: text("description").notNull().default(""),
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique(),
    strategicWeight: real("strategic_weight").notNull().default(0.5),
  },
  (table) => [
    check(
      "themes_strategic_weight_range",
      sql`${table.strategicWeight} >= 0 and ${table.strategicWeight} <= 1`,
    ),
  ],
);

export const needs = pgTable(
  "needs",
  {
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: createdAt(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    id: uuid("id").primaryKey().defaultRandom(),
    mergedIntoId: uuid("merged_into_id"),
    publicSummary: text("public_summary"),
    publicSummaryStatus: publicSummaryStatus("public_summary_status").notNull().default("none"),
    statement: text("statement").notNull(),
    status: needStatus("status").notNull().default("draft"),
    themeId: uuid("theme_id").references(() => themes.id),
  },
  (table) => [
    index("needs_status_idx").on(table.status),
    index("needs_theme_idx").on(table.themeId),
    index("needs_embedding_idx").using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);

export const signals = pgTable(
  "signals",
  {
    actorKind: actorKind("actor_kind").notNull(),
    agentClient: text("agent_client"),
    attachedTo: attachedTo("attached_to").notNull(),
    body: text("body").notNull(),
    channel: channel("channel").notNull(),
    createdAt: createdAt(),
    id: uuid("id").primaryKey().defaultRandom(),
    idempotencyKey: text("idempotency_key").unique(),
    needId: uuid("need_id")
      .notNull()
      .references(() => needs.id),
    originalNeedId: uuid("original_need_id")
      .notNull()
      .references(() => needs.id),
    submitterId: uuid("submitter_id")
      .notNull()
      .references(() => submitters.id),
    title: text("title").notNull(),
    trackingToken: text("tracking_token").notNull().unique(),
    urgency: urgency("urgency"),
    useCase: text("use_case"),
  },
  (table) => [
    index("signals_need_idx").on(table.needId),
    index("signals_submitter_idx").on(table.submitterId),
  ],
);

export const proposedSolutions = pgTable(
  "proposed_solutions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    needId: uuid("need_id")
      .notNull()
      .references(() => needs.id),
    sourceSignalId: uuid("source_signal_id").references(() => signals.id),
    text: text("text").notNull(),
  },
  (table) => [index("proposed_solutions_need_idx").on(table.needId)],
);

export const merges = pgTable("merges", {
  createdAt: createdAt(),
  fromNeedId: uuid("from_need_id")
    .notNull()
    .references(() => needs.id),
  id: uuid("id").primaryKey().defaultRandom(),
  intoNeedId: uuid("into_need_id")
    .notNull()
    .references(() => needs.id),
  movedSignalIds: uuid("moved_signal_ids").array().notNull(),
  undoneAt: timestamp("undone_at", { withTimezone: true }),
});

export const priorityCriteria = pgTable(
  "priority_criteria",
  {
    description: text("description").notNull().default(""),
    key: criterionKey("key").primaryKey(),
    weight: real("weight").notNull(),
  },
  (table) => [
    check("priority_criteria_weight_range", sql`${table.weight} >= 0 and ${table.weight} <= 1`),
  ],
);

export const priorityScores = pgTable(
  "priority_scores",
  {
    criterion: criterionKey("criterion").notNull(),
    needId: uuid("need_id")
      .notNull()
      .references(() => needs.id),
    reason: text("reason").notNull(),
    score: real("score").notNull(),
    source: scoreSource("source").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.needId, table.criterion] }),
    check("priority_scores_range", sql`${table.score} >= 0 and ${table.score} <= 5`),
  ],
);

export const suggestions = pgTable(
  "suggestions",
  {
    createdAt: createdAt(),
    id: uuid("id").primaryKey().defaultRandom(),
    kind: suggestionKind("kind").notNull(),
    model: text("model"),
    /** Subject ids: the need, a second need (merge target), signals (split), theme. */
    needId: uuid("need_id").references(() => needs.id),
    /** Kind-specific proposal (statement, target, scores, summary, brief, ...) plus its reason. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    relatedNeedId: uuid("related_need_id").references(() => needs.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByKind: actorKind("resolved_by_kind"),
    signalIds: uuid("signal_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    status: suggestionStatus("status").notNull().default("pending"),
    themeId: uuid("theme_id").references(() => themes.id),
  },
  (table) => [index("suggestions_status_kind_idx").on(table.status, table.kind)],
);

export const decisions = pgTable(
  "decisions",
  {
    briefMarkdown: text("brief_markdown"),
    id: uuid("id").primaryKey().defaultRandom(),
    needId: uuid("need_id")
      .notNull()
      .references(() => needs.id),
    note: text("note").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
    publishedByKind: actorKind("published_by_kind").notNull(),
    status: decisionStatus("status").notNull(),
  },
  (table) => [index("decisions_need_idx").on(table.needId)],
);

/** Append-only event log behind the MVP metrics; write it with `recordEvent` only. */
export const events = pgTable(
  "events",
  {
    actorKind: actorKind("actor_kind").notNull(),
    actorRef: text("actor_ref").notNull(),
    dedupeKey: text("dedupe_key").unique(),
    id: uuid("id").primaryKey().defaultRandom(),
    needId: uuid("need_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    signalId: uuid("signal_id"),
    suggestionId: uuid("suggestion_id"),
    type: text("type").notNull(),
  },
  (table) => [
    index("events_type_occurred_idx").on(table.type, table.occurredAt),
    index("events_need_idx").on(table.needId),
  ],
);

/** Every Signal table; the test harness and the seed truncate these. */
export const signalTableNames = [
  "events",
  "decisions",
  "suggestions",
  "priority_scores",
  "priority_criteria",
  "merges",
  "proposed_solutions",
  "signals",
  "needs",
  "themes",
  "submitters",
  "accounts",
] as const;
