import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { z } from "zod";

import type { SignalQueryable } from "../db";
import { SignalError } from "../errors";
import { weeklyPreventionSeries, weekStarts } from "../metrics";
import { accountPlans } from "./demand";
import {
  DAY_MS,
  priorityScoreSql,
  queryRows,
  roundScore,
  TREND_DAYS,
  trendOf,
  ts,
} from "./need-facts";

/**
 * The report dataset catalog (spec 013, decision 0010): the only data a report can show. Each
 * dataset is one read-only SQL query with typed params and fixed columns; no dataset returns
 * submitter names, emails, or verbatim signal text. Money is in cents.
 */

export const datasetNames = [
  "needs",
  "signals_weekly",
  "accounts",
  "decisions",
  "metrics_weekly",
] as const;
export type DatasetName = (typeof datasetNames)[number];

/** Rows returned per dataset at most; beyond it `truncated` is true. */
export const MAX_DATASET_ROWS = 500;

const instant = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);
const liveNeedStatuses = [
  "draft",
  "open",
  "planned",
  "in_progress",
  "shipped",
  "declined",
] as const;

export const datasetParamsSchemas = {
  accounts: z.object({ plan: z.enum(accountPlans).optional() }).strict(),
  decisions: z
    .object({
      since: instant.optional(),
      themeId: z.uuid().optional(),
      until: instant.optional(),
    })
    .strict(),
  metrics_weekly: z
    .object({
      actor: z.enum(["all", "human", "agent"]).default("all"),
      since: instant.optional(),
      until: instant.optional(),
    })
    .strict(),
  needs: z
    .object({
      includeDecided: z.boolean().default(true),
      plan: z.enum(accountPlans).optional(),
      status: z.array(z.enum(liveNeedStatuses)).min(1).optional(),
      themeId: z.uuid().optional(),
    })
    .strict(),
  signals_weekly: z
    .object({
      groupBy: z.enum(["none", "theme", "plan", "actor"]).default("none"),
      since: instant.optional(),
      until: instant.optional(),
    })
    .strict(),
} as const satisfies Record<DatasetName, z.ZodObject>;

export type DatasetParams<N extends DatasetName = DatasetName> = z.input<
  (typeof datasetParamsSchemas)[N]
>;

export const columnDefSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(["string", "number", "date"]),
  unit: z.enum(["cents", "count", "days", "percent", "score"]).optional(),
});
export type ColumnDef = z.infer<typeof columnDefSchema>;

const col = (
  key: string,
  label: string,
  type: ColumnDef["type"],
  unit?: ColumnDef["unit"],
): ColumnDef => (unit ? { key, label, type, unit } : { key, label, type });

/** Fixed columns per dataset; `validateReportSpec` checks block references against these. */
export const datasetColumns: Record<DatasetName, ColumnDef[]> = {
  accounts: [
    col("accountId", "Account id", "string"),
    col("account", "Account", "string"),
    col("plan", "Plan", "string"),
    col("arrCents", "ARR", "number", "cents"),
    col("openDealCents", "Open deals", "number", "cents"),
    col("needsSupported", "Needs supported", "number", "count"),
    col("signals", "Signals", "number", "count"),
    col("lastSignalAt", "Last signal", "date"),
  ],
  decisions: [
    col("needId", "Need id", "string"),
    col("statement", "Need", "string"),
    col("theme", "Theme", "string"),
    col("status", "Decision", "string"),
    col("publishedAt", "Published", "date"),
    col("latencyDays", "Days to decide", "number", "days"),
    col("recommendedStatus", "Recommended", "string"),
  ],
  metrics_weekly: [
    col("weekStart", "Week", "date"),
    col("preventionRate", "Prevention rate", "number", "percent"),
    col("signals", "Signals", "number", "count"),
    col("attachedExisting", "Attached to existing", "number", "count"),
    col("mergedLater", "Merged later", "number", "count"),
  ],
  needs: [
    col("needId", "Need id", "string"),
    col("statement", "Need", "string"),
    col("theme", "Theme", "string"),
    col("status", "Status", "string"),
    col("people", "People", "number", "count"),
    col("accounts", "Accounts", "number", "count"),
    col("arrCents", "ARR", "number", "cents"),
    col("openDealCents", "Open deals", "number", "cents"),
    col("score", "Priority score", "number", "score"),
    col("trend", "Trend", "string"),
    col("createdAt", "Created", "date"),
    col("readyAt", "Ready", "date"),
    col("decidedAt", "Decided", "date"),
  ],
  signals_weekly: [
    col("weekStart", "Week", "date"),
    col("group", "Group", "string"),
    col("signals", "Signals", "number", "count"),
    col("attachedExisting", "Attached to existing", "number", "count"),
    col("attachedDraft", "New needs", "number", "count"),
  ],
};

/** One line per dataset for model prompts and the `get_report_dataset` description. */
export const datasetDescriptions: Record<DatasetName, string> = {
  accounts:
    "accounts: one row per customer account with plan, ARR, open deals, how many live needs it supports, its signal count, and its last signal. Params: plan?.",
  decisions:
    "decisions: one row per published decision (newest first) with the need, theme, status, days from the need's first signal to the decision, and the brief's recommended status. Params: since? (default 180 days ago), until?, themeId?.",
  metrics_weekly:
    "metrics_weekly: the get_metrics weekly series: prevention rate (0–1), signals, attached to existing, and drafts merged later, per week. Params: since? (default 12 weeks ago), until?, actor (all | human | agent).",
  needs:
    "needs: one row per live need (merged-away excluded) with theme, status, people, requesting accounts, their ARR and open deals, priority score (0–5), trend (rising | steady | falling), and created/ready/decided dates. Params: themeId?, plan? (needs some account on that plan supports), status?[], includeDecided (default true).",
  signals_weekly:
    "signals_weekly: signals per week (weekStart, Monday UTC) split by group (theme name, account plan, or human/agent; 'All' when groupBy is none), with how many attached to an existing need vs. created a new draft. Params: since? (default 12 weeks ago), until?, groupBy (none | theme | plan | actor).",
};

export const datasetQuerySchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,23}$/u),
    name: z.enum(datasetNames),
    params: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((query, context) => {
    const parsed = datasetParamsSchemas[query.name].safeParse(query.params);
    if (!parsed.success)
      context.addIssue({
        code: "custom",
        message: `Invalid params for dataset ${query.name}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "params"} ${issue.message}`).join("; ")}`,
        path: ["params"],
      });
  });
export type DatasetQuery = z.infer<typeof datasetQuerySchema>;

export const datasetCellSchema = z.union([z.string(), z.number(), z.null()]);
export const datasetResultSchema = z.object({
  columns: z.array(columnDefSchema),
  rows: z.array(z.record(z.string(), datasetCellSchema)),
  truncated: z.boolean(),
});
export type DatasetResult = z.infer<typeof datasetResultSchema>;

type Cell = string | number | null;
type Row = Record<string, Cell>;
type Params<N extends DatasetName> = z.output<(typeof datasetParamsSchemas)[N]>;

/** `signals_weekly` and `metrics_weekly` default to the 12 weeks before `until` (now). */
const DEFAULT_WEEKLY_DAYS = 12 * 7;
/** `decisions` defaults to the 180 days before `until` (now). */
const DEFAULT_DECISION_DAYS = 180;
const FETCH_LIMIT = MAX_DATASET_ROWS + 1;

/** An ISO-8601 UTC string from a timestamptz column, the same on Neon and PGlite. */
const isoSql = (column: SQL) =>
  sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const toNumber = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));
const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));

/** Keeps exactly the dataset's columns, in order, and at most `MAX_DATASET_ROWS` rows. */
const resultOf = (name: DatasetName, rows: Row[]): DatasetResult => {
  const columns = datasetColumns[name];
  return {
    columns,
    rows: rows
      .slice(0, MAX_DATASET_ROWS)
      .map((row) =>
        Object.fromEntries(columns.map((column) => [column.key, row[column.key] ?? null])),
      ),
    truncated: rows.length > MAX_DATASET_ROWS,
  };
};

/** `[since, until)` with the defaults; `validation_failed` when it is empty. */
const windowOf = (params: { since?: string; until?: string }, now: Date, defaultDays: number) => {
  const to = params.until ? new Date(params.until) : now;
  const from = params.since
    ? new Date(params.since)
    : new Date(to.getTime() - defaultDays * DAY_MS);
  if (from >= to) throw new SignalError("validation_failed", "`since` must be before `until`.");
  return { from, to };
};

const needsRows = async (db: SignalQueryable, params: Params<"needs">, now: Date) => {
  const recentFrom = new Date(now.getTime() - TREND_DAYS * DAY_MS);
  const previousFrom = new Date(now.getTime() - 2 * TREND_DAYS * DAY_MS);
  const conditions: SQL[] = [sql`n.status <> 'merged'`];
  if (params.themeId) conditions.push(sql`n.theme_id = ${params.themeId}`);
  if (params.status)
    conditions.push(
      sql`n.status::text in (${sql.join(
        params.status.map((status) => sql`${status}`),
        sql`, `,
      )})`,
    );
  if (params.plan)
    conditions.push(sql`exists (
      select 1 from signals s join submitters u on u.id = s.submitter_id
      join accounts ac on ac.id = u.account_id
      where s.need_id = n.id and ac.plan = ${params.plan}
    )`);
  if (!params.includeDecided)
    conditions.push(sql`n.status not in ('shipped', 'declined')
      and not exists (select 1 from decisions dd where dd.need_id = n.id)`);
  const rows = await queryRows<Record<string, unknown>>(
    db,
    sql`
      select n.id, n.statement, t.name as theme, n.status,
        ${priorityScoreSql(sql`n.id`)} as score,
        coalesce(p.people, 0) as people,
        coalesce(a.accounts, 0) as accounts,
        coalesce(a.arr_cents, 0) as arr_cents,
        coalesce(a.open_deal_cents, 0) as open_deal_cents,
        coalesce(f.recent_30, 0) as recent_30,
        coalesce(f.previous_30, 0) as previous_30,
        ${isoSql(sql`n.created_at`)} as created_at,
        ${isoSql(sql`n.ready_at`)} as ready_at,
        ${isoSql(sql`d.decided_at`)} as decided_at
      from needs n
      left join themes t on t.id = n.theme_id
      left join lateral (
        select count(distinct s.submitter_id)::int as people from signals s where s.need_id = n.id
      ) p on true
      left join lateral (
        select count(*)::int as accounts, sum(ac.arr_cents)::bigint as arr_cents,
          sum(ac.open_deal_cents)::bigint as open_deal_cents
        from accounts ac
        where ac.id in (
          select u.account_id from signals s join submitters u on u.id = s.submitter_id
          where s.need_id = n.id and u.account_id is not null
        )
      ) a on true
      left join lateral (
        select
          count(*) filter (
            where f.first_at >= ${ts(recentFrom)} and f.first_at < ${ts(now)}
          )::int as recent_30,
          count(*) filter (
            where f.first_at >= ${ts(previousFrom)} and f.first_at < ${ts(recentFrom)}
          )::int as previous_30
        from (
          select s.submitter_id, min(s.created_at) as first_at
          from signals s where s.need_id = n.id group by s.submitter_id
        ) f
      ) f on true
      left join lateral (
        select max(dd.published_at) as decided_at from decisions dd where dd.need_id = n.id
      ) d on true
      where ${sql.join(conditions, sql` and `)}
      order by score desc nulls last, people desc, n.id
      limit ${FETCH_LIMIT}
    `,
  );
  return rows.map((row): Row => ({
    accounts: toNumber(row.accounts),
    arrCents: toNumber(row.arr_cents),
    createdAt: toText(row.created_at),
    decidedAt: toText(row.decided_at),
    needId: String(row.id),
    openDealCents: toNumber(row.open_deal_cents),
    people: toNumber(row.people),
    readyAt: toText(row.ready_at),
    score: roundScore(row.score === null || row.score === undefined ? null : Number(row.score)),
    statement: String(row.statement),
    status: String(row.status),
    theme: toText(row.theme),
    trend: trendOf(toNumber(row.recent_30), toNumber(row.previous_30)),
  }));
};

const signalGroup: Record<Params<"signals_weekly">["groupBy"], SQL> = {
  actor: sql`s.actor_kind::text`,
  none: sql`'All'`,
  plan: sql`coalesce(ac.plan, 'No account')`,
  theme: sql`coalesce(t.name, 'No theme')`,
};

/**
 * Signals per ISO week (the weeks of `get_metrics` for `[since, until)`), grouped by the theme of
 * the need each signal is on now, the submitter's account plan, or the actor kind; every week is
 * zero-filled for every group seen, so stacked charts line up.
 */
const signalsWeeklyRows = async (
  db: SignalQueryable,
  params: Params<"signals_weekly">,
  now: Date,
) => {
  const window = windowOf(params, now, DEFAULT_WEEKLY_DAYS);
  const counted = await queryRows<Record<string, unknown>>(
    db,
    sql`
      select
        to_char(date_trunc('week', s.created_at at time zone 'UTC'), 'YYYY-MM-DD') as week,
        ${signalGroup[params.groupBy]} as grp,
        count(*)::int as signals,
        count(*) filter (where s.attached_to = 'existing')::int as attached_existing,
        count(*) filter (where s.attached_to = 'draft')::int as attached_draft
      from signals s
      join needs n on n.id = s.need_id
      left join themes t on t.id = n.theme_id
      join submitters u on u.id = s.submitter_id
      left join accounts ac on ac.id = u.account_id
      where s.created_at >= ${ts(window.from)} and s.created_at < ${ts(window.to)}
      group by 1, 2
    `,
  );
  const groups =
    params.groupBy === "none"
      ? ["All"]
      : [...new Set(counted.map((row) => String(row.grp)))].toSorted((a, b) => a.localeCompare(b));
  const byKey = new Map(counted.map((row) => [`${String(row.week)}|${String(row.grp)}`, row]));
  return weekStarts(window).flatMap((weekStart) =>
    groups.map((group): Row => {
      const row = byKey.get(`${weekStart}|${group}`);
      return {
        attachedDraft: toNumber(row?.attached_draft),
        attachedExisting: toNumber(row?.attached_existing),
        group,
        signals: toNumber(row?.signals),
        weekStart,
      };
    }),
  );
};

const accountsRows = async (db: SignalQueryable, params: Params<"accounts">) => {
  const rows = await queryRows<Record<string, unknown>>(
    db,
    sql`
      select ac.id, ac.name, ac.plan, ac.arr_cents, ac.open_deal_cents,
        coalesce(sg.needs_supported, 0) as needs_supported,
        coalesce(sg.signals, 0) as signals,
        ${isoSql(sql`sg.last_signal_at`)} as last_signal_at
      from accounts ac
      left join lateral (
        select
          count(distinct s.need_id) filter (where n.status <> 'merged')::int as needs_supported,
          count(*)::int as signals, max(s.created_at) as last_signal_at
        from signals s
        join submitters u on u.id = s.submitter_id
        join needs n on n.id = s.need_id
        where u.account_id = ac.id
      ) sg on true
      ${params.plan ? sql`where ac.plan = ${params.plan}` : sql``}
      order by ac.arr_cents desc, ac.name, ac.id
      limit ${FETCH_LIMIT}
    `,
  );
  return rows.map((row): Row => ({
    account: String(row.name),
    accountId: String(row.id),
    arrCents: toNumber(row.arr_cents),
    lastSignalAt: toText(row.last_signal_at),
    needsSupported: toNumber(row.needs_supported),
    openDealCents: toNumber(row.open_deal_cents),
    plan: String(row.plan),
    signals: toNumber(row.signals),
  }));
};

/**
 * Published decisions in `[since, until)`, newest first (no upper bound when `until` is
 * omitted). Latency starts where `get_metrics`' decision latency does (the need's `need.created`
 * event: its first signal); a need without one falls back to its first signal, then its creation.
 */
const decisionsRows = async (db: SignalQueryable, params: Params<"decisions">, now: Date) => {
  const until = params.until ? new Date(params.until) : null;
  const since = params.since
    ? new Date(params.since)
    : new Date((until ?? now).getTime() - DEFAULT_DECISION_DAYS * DAY_MS);
  if (until && since >= until)
    throw new SignalError("validation_failed", "`since` must be before `until`.");
  const conditions: SQL[] = [sql`d.published_at >= ${ts(since)}`];
  if (until) conditions.push(sql`d.published_at < ${ts(until)}`);
  if (params.themeId) conditions.push(sql`n.theme_id = ${params.themeId}`);
  const rows = await queryRows<Record<string, unknown>>(
    db,
    sql`
      select d.need_id, n.statement, t.name as theme, d.status,
        ${isoSql(sql`d.published_at`)} as published_at,
        (extract(epoch from d.published_at - coalesce(c.created_at, fs.first_at, n.created_at))
          / 86400)::float8 as latency_days,
        ev.recommended_status
      from decisions d
      join needs n on n.id = d.need_id
      left join themes t on t.id = n.theme_id
      left join lateral (
        select min(e.occurred_at) as created_at from events e
        where e.type = 'need.created' and e.need_id = d.need_id
      ) c on true
      left join lateral (
        select min(s.created_at) as first_at from signals s where s.need_id = d.need_id
      ) fs on true
      left join lateral (
        select e.payload->>'recommendedStatus' as recommended_status from events e
        where e.type = 'decision.published' and e.need_id = d.need_id
          and (e.payload->>'decisionId' is null or e.payload->>'decisionId' = d.id::text)
        order by (e.payload->>'decisionId' = d.id::text) desc nulls last,
          abs(extract(epoch from e.occurred_at - d.published_at)), e.id
        limit 1
      ) ev on true
      where ${sql.join(conditions, sql` and `)}
      order by d.published_at desc, d.id
      limit ${FETCH_LIMIT}
    `,
  );
  return rows.map((row): Row => ({
    latencyDays:
      row.latency_days === null || row.latency_days === undefined
        ? null
        : Math.round(Number(row.latency_days) * 100) / 100,
    needId: String(row.need_id),
    publishedAt: toText(row.published_at),
    recommendedStatus: toText(row.recommended_status),
    statement: String(row.statement),
    status: String(row.status),
    theme: toText(row.theme),
  }));
};

/** `get_metrics`' weekly prevention series for one actor split, one row per week. */
const metricsWeeklyRows = async (
  db: SignalQueryable,
  params: Params<"metrics_weekly">,
  now: Date,
) => {
  const series = await weeklyPreventionSeries(
    db,
    windowOf(params, now, DEFAULT_WEEKLY_DAYS),
    params.actor,
  );
  return series.map((week): Row => ({
    attachedExisting: week.attachedToExisting,
    mergedLater: week.mergedDrafts,
    preventionRate: week.rate,
    signals: week.signals,
    weekStart: week.weekStart,
  }));
};

const datasetRows: {
  [N in DatasetName]: (db: SignalQueryable, params: Params<N>, now: Date) => Promise<Row[]>;
} = {
  accounts: (db, params) => accountsRows(db, params),
  decisions: decisionsRows,
  metrics_weekly: metricsWeeklyRows,
  needs: needsRows,
  signals_weekly: signalsWeeklyRows,
};

/** Parses a dataset's params with its schema (defaults applied); `validation_failed` otherwise. */
export const parseDatasetParams = <N extends DatasetName>(name: N, params: unknown): Params<N> => {
  const parsed = datasetParamsSchemas[name].safeParse(params ?? {});
  if (!parsed.success)
    throw new SignalError(
      "validation_failed",
      `Invalid params for dataset ${name}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "params"} ${issue.message}`).join("; ")}`,
    );
  return parsed.data as Params<N>;
};

/**
 * Runs one dataset query: exactly `datasetColumns[name]` per row, at most `MAX_DATASET_ROWS` rows
 * (`truncated` beyond). Params are validated here (`validation_failed`).
 */
export const runReportDataset = async (
  db: SignalQueryable,
  query: Pick<DatasetQuery, "name" | "params">,
  now: Date,
): Promise<DatasetResult> => {
  const { name } = query;
  if (!Object.hasOwn(datasetRows, name))
    throw new SignalError("validation_failed", `Unknown dataset ${String(name)}.`);
  const rows = datasetRows[name] as (
    db: SignalQueryable,
    params: unknown,
    now: Date,
  ) => Promise<Row[]>;
  return resultOf(name, await rows(db, parseDatasetParams(name, query.params), now));
};

export type RunReportDataset = typeof runReportDataset;
