import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { z } from "zod";

import type { SignalQueryable } from "./db";

/**
 * The MVP metrics (PRODUCT.md → Metrics; spec 001 → Metrics instrumentation), computed with SQL
 * over the append-only `events` table only. Every metric is read for a window `[from, to)`.
 *
 * What each metric reads (operations that record these events must write the fields named here):
 *
 * - **Prevention rate** reads
 *   - `signal.created`: `occurred_at`, `actor_kind`, `signal_id`, `need_id` (the need the
 *     signal was filed on at submission: the existing need, or its own draft need), and
 *     `payload.attachedTo` (`"existing" | "draft"`).
 *   - `need.merged`: `need_id` (the need merged away), `payload.mergeId`, `occurred_at`.
 *   - `merge.undone`: `payload.mergeId` (the merge it reverts), `occurred_at`.
 *
 *   Numerator: signals created in the window with `attachedTo = existing`. Denominator adds
 *   signals created in the window with `attachedTo = draft` whose need has a `need.merged` event
 *   before `to` that no `merge.undone` (same `mergeId`) reverted before `to`. Grouped by ISO
 *   week (Monday, UTC) of `signal.created`, and split by its `actor_kind`.
 *
 * - **Decision latency** reads `need.created` (`need_id`, `occurred_at`: the need's first
 *   signal) and `decision.published` (`need_id`, `occurred_at`, `actor_kind`). Median days from
 *   `need.created` to the need's first `decision.published`, for first decisions published in
 *   the window, split by the publisher's `actor_kind`. Needs open past 30 days (a `need.created`
 *   more than 30 days before `to`, no `decision.published` before `to`, and not merged away as of
 *   `to`) are counted separately and never enter the median. A need created by `split_need` must
 *   record its own `need.created`.
 *
 * - **Direction accuracy** (spec 007) reads `decision.published` (`occurred_at`, `actor_kind`,
 *   `payload.status`, `payload.recommendedStatus`, `payload.decisionId`). Over decisions
 *   published in the window whose `recommendedStatus` is a string (a decision with no brief, or
 *   recorded before spec 007, has none and is left out): matched when it equals `status`. Each
 *   `decisionId` counts once; split by the publisher's `actor_kind`.
 *
 * - **Readiness lead time** (spec 007) reads `need.ready` (`need_id`, `occurred_at`) and
 *   `decision.published`. Median days from a need's `need.ready` to its first
 *   `decision.published`, for first decisions published in the window at or after readiness.
 *   Needs whose `need.ready` is more than 30 days before `to`, with no `decision.published`
 *   before `to` and not merged away as of `to`, are counted separately.
 *
 * - **Suggestion acceptance** reads `suggestion.accepted | suggestion.edited |
 *   suggestion.rejected` (`suggestion_id`, `occurred_at`, `actor_kind` of the resolver, and
 *   `payload.kind`: the suggestion kind). Per kind: accepted ÷ (accepted + edited + rejected),
 *   with edited and rejected reported; a suggestion's first resolution counts.
 *
 * - **Supporting counts**
 *   - Context rate: `signal.created` `payload.hasUseCase` (boolean: the submitter wrote their
 *     own use case). Signals without the field are left out of the rate.
 *   - Time to triage: median hours from `suggestion.created` (`suggestion_id`) to its first
 *     resolution, for resolutions in the window.
 *   - Review load: suggestions created in the window, resolved in the window, and pending at
 *     `to` (created before `to` with no resolution before `to`).
 *   - Unmerge rate (guardrail): `need.merged` in the window and how many a `merge.undone`
 *     (same `payload.mergeId`) reverted before `to`.
 *   - Close-the-loop rate is not computed yet; see `unsupportedMetrics`.
 *
 * - **Match exposure** (spec 012) reads `signal.created` `payload.exposure` (from
 *   `domain/exposure.ts`) for signals created in the window, split by `actor_kind`:
 *   - Take-up: `kind = shown` with a non-null `chosenRank` ÷ all `kind = shown`.
 *   - Filed new despite a match: `kind = shown` and `attachedTo = draft`; its draft need
 *     (`need_id`) merged as of `to` into a need in `shownNeedIds` (`need.merged`
 *     `payload.intoNeedId`, not undone), merged elsewhere, or unmerged.
 *   - Moved off a taken match: `kind = shown` with a `chosenRank` whose `signal_id` is in a
 *     later `need.split` `payload.signalIds` from that signal's `need_id`, before `to`.
 *   - Previews without a submission: `preview.shown` in the window with at least one match and
 *     no `signal.created` carrying its `payload.previewId` within 24 hours.
 *
 * - **Kill criterion** (PRODUCT.md → Kill criterion, with real users; spec 012) ignores `from`:
 *   every `signal.created` with `exposure.kind = shown` before `to`, its prevention rate (as
 *   above, over that population), and the all-time unmerge rate before `to` (merges are
 *   need-level, so the guardrail is not split by population).
 *
 * Counting rules: events are written in the same transaction as the change, so failed or
 * rejected requests write none; `dedupe_key` makes retries write once, and these queries also
 * count each `signal_id` / `suggestion_id` once in case the same fact was recorded twice.
 */

export const DAY_MS = 86_400_000;
/** Default window length when `from` is omitted: four weekly buckets. */
const DEFAULT_WINDOW_DAYS = 28;
export const MAX_WINDOW_DAYS = 366;
/** A need with no decision this long after its first signal is reported as open. */
const OPEN_NEED_DAYS = 30;

/** PRODUCT.md → Kill criterion (with real users): submissions shown a match before a verdict. */
export const KILL_CRITERION_MIN_SHOWN = 200;
/** Kill when prevention rate over shown submissions is below this... */
const KILL_CRITERION_MIN_PREVENTION = 0.3;
/** ...or when the unmerge rate exceeds this. */
const KILL_CRITERION_MAX_UNMERGE = 0.1;
/** A preview with no submission this long after it is counted as abandoned (spec 012). */
const PREVIEW_SUBMIT_HOURS = 24;

const unsupportedMetrics = [
  {
    metric: "close_the_loop_rate",
    reason:
      "Needs an event recording that a submitter was told the outcome (e.g. a decision notification or tracking-page view per signal); the MVP records none.",
  },
] as const;

const ratio = (numerator: number, denominator: number) =>
  denominator === 0 ? null : Math.round((numerator / denominator) * 10_000) / 10_000;

const round = (value: number | null, digits = 2) => {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const rateSchema = z.number().min(0).max(1).nullable();

const preventionSchema = z.object({
  /** Signals attached to an existing need at submission (the numerator). */
  attachedToExisting: z.number().int().nonnegative(),
  /** Signals whose draft need was later merged into an existing need (and not undone). */
  mergedDrafts: z.number().int().nonnegative(),
  /** attachedToExisting ÷ (attachedToExisting + mergedDrafts); null with no data. */
  rate: rateSchema,
});
type Prevention = z.infer<typeof preventionSchema>;

const latencySchema = z.object({
  decisions: z.number().int().nonnegative(),
  medianDays: z.number().nonnegative().nullable(),
});

const acceptanceSchema = z.object({
  /** accepted ÷ (accepted + edited + rejected); null with no resolutions. */
  acceptanceRate: rateSchema,
  accepted: z.number().int().nonnegative(),
  edited: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
});
type Acceptance = z.infer<typeof acceptanceSchema>;

const contextSchema = z.object({
  rate: rateSchema,
  /** Signals in the window that report whether they carry a use case. */
  signals: z.number().int().nonnegative(),
  withUseCase: z.number().int().nonnegative(),
});
type Context = z.infer<typeof contextSchema>;

const matchSchema = z.object({
  matched: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

const split = <T extends z.ZodType>(schema: T) =>
  z.object({ agent: schema, all: schema, human: schema });

const count = z.number().int().nonnegative();

const exposureCountsSchema = z.object({
  /** Submissions that picked a shown need, by its rank. */
  chosenRank: z.object({ 1: count, 2: count, 3: count }),
  /** Shown a match and filed a new need anyway, by what a PM later did with the draft. */
  filedNewDespiteMatch: z.object({
    /** Merged into a need other than the ones shown (Signal showed the wrong needs). */
    mergedElsewhere: count,
    /** Merged into one of the shown needs (the submitter turned down a correct match). */
    mergedIntoShown: count,
    total: count,
    unmerged: count,
  }),
  /** Taken matches a PM later split off the need they were filed on (live false-match proxy). */
  movedOffTakenMatch: z.object({ moved: count, rate: rateSchema }),
  /** A preview was found and showed no match. */
  noneShown: count,
  /** Submissions shown at least one match. */
  shown: count,
  /** No `previewId` was sent. */
  skipped: count,
  /** taken ÷ shown; null with no shown submissions. */
  takeUpRate: rateSchema,
  /** Shown submissions that picked a shown need. */
  taken: count,
  /** A `previewId` Signal never issued, or one older than 24 hours. */
  unknown: count,
});
type ExposureCounts = z.infer<typeof exposureCountsSchema>;

const killPopulationSchema = z.object({
  preventionRate: preventionSchema,
  shownSubmissions: count,
  verdict: z.enum(["insufficient_data", "pass", "fail"]),
});
type KillPopulation = z.infer<typeof killPopulationSchema>;

export const metricsSchema = z.object({
  decisionLatency: z.object({
    /** First decisions published in the window, by who published them. */
    decided: split(latencySchema),
    /** Undecided, unmerged needs whose first signal is older than 30 days at `window.to`. */
    openPast30Days: z.object({
      medianAgeDays: z.number().nonnegative().nullable(),
      needs: z.number().int().nonnegative(),
    }),
  }),
  /** Decisions in the window that followed their brief's recommended status (spec 007). */
  directionAccuracy: z.object({
    byActorKind: z.object({ agent: matchSchema, human: matchSchema }),
    matched: z.number().int().nonnegative(),
    /** matched ÷ total; null with no decisions that carry a recommendation. */
    rate: rateSchema,
    total: z.number().int().nonnegative(),
  }),
  /** What submitters were shown at preview and what they chose (spec 012). */
  exposure: z.object({
    previewsWithoutSubmission: split(count),
    submissions: split(exposureCountsSchema),
  }),
  /** PRODUCT.md's real-user kill criterion, over all time before `window.to` (spec 012). */
  killCriterion: z.object({
    maxUnmergeRate: z.number(),
    minPreventionRate: z.number(),
    minShownSubmissions: count,
    populations: split(killPopulationSchema),
    unmergeRate: z.object({ merges: count, rate: rateSchema, undone: count }),
  }),
  preventionRate: z.object({
    overall: split(preventionSchema),
    /** One bucket per ISO week (Monday, UTC) overlapping the window. */
    weeks: z.array(split(preventionSchema).extend({ weekStart: z.iso.date() })),
  }),
  /** Days from a need crossing the readiness line to its first decision (spec 007). */
  readinessLeadTime: z.object({
    /** Needs whose first decision, published in the window, followed `need.ready`. */
    decided: z.number().int().nonnegative(),
    medianDays: z.number().nonnegative().nullable(),
    /** Unmerged needs ready more than 30 days before `window.to` with no decision yet. */
    readyUndecidedOver30Days: z.number().int().nonnegative(),
  }),
  suggestionAcceptance: z.object({
    byKind: z.array(split(acceptanceSchema).extend({ kind: z.string() })),
    overall: split(acceptanceSchema),
  }),
  supporting: z.object({
    contextRate: split(contextSchema),
    reviewLoad: z.object({
      created: z.number().int().nonnegative(),
      pendingAtEnd: z.number().int().nonnegative(),
      resolved: z.number().int().nonnegative(),
    }),
    timeToTriage: z.object({
      medianHours: z.number().nonnegative().nullable(),
      resolved: z.number().int().nonnegative(),
    }),
    unmergeRate: z.object({
      merges: z.number().int().nonnegative(),
      rate: rateSchema,
      undone: z.number().int().nonnegative(),
    }),
  }),
  unsupported: z.array(z.object({ metric: z.string(), reason: z.string() })),
  window: z.object({
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
  }),
});
export type Metrics = z.infer<typeof metricsSchema>;

interface MetricsWindow {
  /** Inclusive. */
  from: Date;
  /** Exclusive. */
  to: Date;
}

type ActorKind = "human" | "agent";

/** `db.execute` returns `{ rows }` on Neon and PGlite; normalize to the rows. */
const query = async <Row>(db: SignalQueryable, statement: SQL) => {
  const result = (await db.execute(statement)) as unknown as { rows?: Row[] } | Row[];
  return Array.isArray(result) ? result : (result.rows ?? []);
};

const num = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));
const numOrNull = (value: unknown) =>
  value === null || value === undefined ? null : Number(value);
const ts = (date: Date) => sql`${date.toISOString()}::timestamptz`;

/** Monday 00:00 UTC of the week containing `date`. */
export const weekStartOf = (date: Date) => {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const offset = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - offset * DAY_MS);
};

/** `YYYY-MM-DD` of every ISO week (Monday, UTC) overlapping `[from, to)`; report datasets reuse it. */
export const weekStarts = ({ from, to }: MetricsWindow) => {
  const weeks: string[] = [];
  for (let start = weekStartOf(from); start < to; start = new Date(start.getTime() + 7 * DAY_MS))
    weeks.push(start.toISOString().slice(0, 10));
  return weeks;
};

/** `need_id`s merged away as of `to` (a `need.merged` with no `merge.undone` of its mergeId). */
const activeMerges = (to: Date) => sql`
  SELECT m.need_id FROM events m
  WHERE m.type = 'need.merged' AND m.need_id IS NOT NULL AND m.occurred_at < ${ts(to)}
    AND NOT EXISTS (
      SELECT 1 FROM events u
      WHERE u.type = 'merge.undone' AND u.occurred_at < ${ts(to)}
        AND u.payload->>'mergeId' = m.payload->>'mergeId'
    )`;

interface SignalRow {
  actor_kind: ActorKind;
  signals: unknown;
  attached: unknown;
  merged_drafts: unknown;
  reporting_context: unknown;
  week: string;
  with_use_case: unknown;
}

const signalCounts = (db: SignalQueryable, { from, to }: MetricsWindow) =>
  query<SignalRow>(
    db,
    sql`
      WITH created AS (
        SELECT DISTINCT ON (COALESCE(signal_id, id))
          actor_kind, need_id, occurred_at, payload
        FROM events
        WHERE type = 'signal.created' AND occurred_at >= ${ts(from)} AND occurred_at < ${ts(to)}
        ORDER BY COALESCE(signal_id, id), occurred_at
      )
      SELECT
        to_char(date_trunc('week', occurred_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS week,
        actor_kind,
        count(*)::int AS signals,
        count(*) FILTER (WHERE payload->>'attachedTo' = 'existing')::int AS attached,
        count(*) FILTER (
          WHERE payload->>'attachedTo' = 'draft' AND need_id IN (${activeMerges(to)})
        )::int AS merged_drafts,
        count(*) FILTER (WHERE jsonb_typeof(payload->'hasUseCase') = 'boolean')::int
          AS reporting_context,
        count(*) FILTER (WHERE payload->>'hasUseCase' = 'true')::int AS with_use_case
      FROM created
      GROUP BY 1, 2
    `,
  );

const toPrevention = (attachedToExisting: number, mergedDrafts: number): Prevention => ({
  attachedToExisting,
  mergedDrafts,
  rate: ratio(attachedToExisting, attachedToExisting + mergedDrafts),
});

const preventionFrom = (rows: SignalRow[], kind?: ActorKind) => {
  const matching = rows.filter((row) => !kind || row.actor_kind === kind);
  return toPrevention(
    matching.reduce((sum, row) => sum + num(row.attached), 0),
    matching.reduce((sum, row) => sum + num(row.merged_drafts), 0),
  );
};

const contextFrom = (rows: SignalRow[], kind?: ActorKind): Context => {
  const matching = rows.filter((row) => !kind || row.actor_kind === kind);
  const signals = matching.reduce((sum, row) => sum + num(row.reporting_context), 0);
  const withUseCase = matching.reduce((sum, row) => sum + num(row.with_use_case), 0);
  return { rate: ratio(withUseCase, signals), signals, withUseCase };
};

const firstDecisions = sql`
  SELECT DISTINCT ON (need_id) need_id, occurred_at, actor_kind
  FROM events
  WHERE type = 'decision.published' AND need_id IS NOT NULL
  ORDER BY need_id, occurred_at, id`;

const needCreations = sql`
  SELECT need_id, min(occurred_at) AS created_at
  FROM events
  WHERE type = 'need.created' AND need_id IS NOT NULL
  GROUP BY need_id`;

const decisionLatency = async (db: SignalQueryable, { from, to }: MetricsWindow) => {
  const decided = await query<{
    actor_kind: ActorKind | null;
    decisions: unknown;
    median: unknown;
  }>(
    db,
    sql`
      WITH created AS (${needCreations}), first_decision AS (${firstDecisions})
      SELECT d.actor_kind, count(*)::int AS decisions,
        (percentile_cont(0.5) WITHIN GROUP (
          ORDER BY extract(epoch FROM d.occurred_at - c.created_at) / 86400
        ))::float8 AS median
      FROM first_decision d JOIN created c ON c.need_id = d.need_id
      WHERE d.occurred_at >= ${ts(from)} AND d.occurred_at < ${ts(to)}
      GROUP BY ROLLUP (d.actor_kind)
    `,
  );
  const open = await query<{ median: unknown; needs: unknown }>(
    db,
    sql`
      WITH created AS (${needCreations})
      SELECT count(*)::int AS needs,
        (percentile_cont(0.5) WITHIN GROUP (
          ORDER BY extract(epoch FROM ${ts(to)} - c.created_at) / 86400
        ))::float8 AS median
      FROM created c
      WHERE c.created_at < ${ts(new Date(to.getTime() - OPEN_NEED_DAYS * DAY_MS))}
        AND NOT EXISTS (
          SELECT 1 FROM events d
          WHERE d.type = 'decision.published' AND d.need_id = c.need_id
            AND d.occurred_at < ${ts(to)}
        )
        AND c.need_id NOT IN (${activeMerges(to)})
    `,
  );
  const latency = (kind: ActorKind | null) => {
    const row = decided.find((candidate) => candidate.actor_kind === kind);
    return { decisions: num(row?.decisions), medianDays: round(numOrNull(row?.median)) };
  };
  return {
    decided: { agent: latency("agent"), all: latency(null), human: latency("human") },
    openPast30Days: {
      medianAgeDays: round(numOrNull(open[0]?.median)),
      needs: num(open[0]?.needs),
    },
  };
};

const directionAccuracy = async (db: SignalQueryable, { from, to }: MetricsWindow) => {
  const rows = await query<{ actor_kind: ActorKind; matched: unknown; total: unknown }>(
    db,
    sql`
      SELECT actor_kind, count(*)::int AS total,
        count(*) FILTER (WHERE recommended = status)::int AS matched
      FROM (
        SELECT DISTINCT ON (COALESCE(payload->>'decisionId', id::text))
          actor_kind, payload->>'recommendedStatus' AS recommended, payload->>'status' AS status
        FROM events
        WHERE type = 'decision.published'
          AND jsonb_typeof(payload->'recommendedStatus') = 'string'
          AND occurred_at >= ${ts(from)} AND occurred_at < ${ts(to)}
        ORDER BY COALESCE(payload->>'decisionId', id::text), occurred_at, id
      ) d
      GROUP BY actor_kind
    `,
  );
  const tally = (kind: ActorKind) => {
    const row = rows.find((candidate) => candidate.actor_kind === kind);
    return { matched: num(row?.matched), total: num(row?.total) };
  };
  const byActorKind = { agent: tally("agent"), human: tally("human") };
  const matched = rows.reduce((sum, row) => sum + num(row.matched), 0);
  const total = rows.reduce((sum, row) => sum + num(row.total), 0);
  return { byActorKind, matched, rate: ratio(matched, total), total };
};

const readinessLeadTime = async (db: SignalQueryable, { from, to }: MetricsWindow) => {
  const [row] = await query<{ decided: unknown; median: unknown; undecided: unknown }>(
    db,
    sql`
      WITH ready AS (
        SELECT need_id, min(occurred_at) AS ready_at
        FROM events
        WHERE type = 'need.ready' AND need_id IS NOT NULL
        GROUP BY need_id
      ), first_decision AS (${firstDecisions}), lead AS (
        SELECT extract(epoch FROM d.occurred_at - r.ready_at) / 86400 AS days
        FROM first_decision d JOIN ready r ON r.need_id = d.need_id
        WHERE d.occurred_at >= ${ts(from)} AND d.occurred_at < ${ts(to)}
          AND d.occurred_at >= r.ready_at
      )
      SELECT
        (SELECT count(*) FROM lead)::int AS decided,
        (SELECT (percentile_cont(0.5) WITHIN GROUP (ORDER BY days))::float8 FROM lead) AS median,
        (SELECT count(*) FROM ready r
          WHERE r.ready_at < ${ts(new Date(to.getTime() - OPEN_NEED_DAYS * DAY_MS))}
            AND NOT EXISTS (
              SELECT 1 FROM events d
              WHERE d.type = 'decision.published' AND d.need_id = r.need_id
                AND d.occurred_at < ${ts(to)}
            )
            AND r.need_id NOT IN (${activeMerges(to)})
        )::int AS undecided
    `,
  );
  return {
    decided: num(row?.decided),
    medianDays: round(numOrNull(row?.median)),
    readyUndecidedOver30Days: num(row?.undecided),
  };
};

const resolutionTypes = sql`('suggestion.accepted', 'suggestion.edited', 'suggestion.rejected')`;

/** Each suggestion's first resolution before `to`, kept when it falls in the window. */
const resolutions = ({ from, to }: MetricsWindow) => sql`
  SELECT * FROM (
    SELECT DISTINCT ON (COALESCE(suggestion_id, id))
      type, actor_kind, COALESCE(payload->>'kind', 'unknown') AS kind, occurred_at, suggestion_id
    FROM events
    WHERE type IN ${resolutionTypes} AND occurred_at < ${ts(to)}
    ORDER BY COALESCE(suggestion_id, id), occurred_at, id
  ) first_resolution
  WHERE occurred_at >= ${ts(from)}`;

interface AcceptanceRow {
  accepted: unknown;
  actor_kind: ActorKind;
  edited: unknown;
  kind: string;
  rejected: unknown;
}

const acceptanceFrom = (rows: AcceptanceRow[]): Acceptance => {
  const accepted = rows.reduce((sum, row) => sum + num(row.accepted), 0);
  const edited = rows.reduce((sum, row) => sum + num(row.edited), 0);
  const rejected = rows.reduce((sum, row) => sum + num(row.rejected), 0);
  return {
    acceptanceRate: ratio(accepted, accepted + edited + rejected),
    accepted,
    edited,
    rejected,
  };
};

const splitAcceptance = (rows: AcceptanceRow[]) => ({
  agent: acceptanceFrom(rows.filter((row) => row.actor_kind === "agent")),
  all: acceptanceFrom(rows),
  human: acceptanceFrom(rows.filter((row) => row.actor_kind === "human")),
});

const suggestionAcceptance = async (db: SignalQueryable, window: MetricsWindow) => {
  const rows = await query<AcceptanceRow>(
    db,
    sql`
      SELECT kind, actor_kind,
        count(*) FILTER (WHERE type = 'suggestion.accepted')::int AS accepted,
        count(*) FILTER (WHERE type = 'suggestion.edited')::int AS edited,
        count(*) FILTER (WHERE type = 'suggestion.rejected')::int AS rejected
      FROM (${resolutions(window)}) r
      GROUP BY kind, actor_kind
    `,
  );
  const kinds = [...new Set(rows.map((row) => row.kind))].toSorted();
  return {
    byKind: kinds.map((kind) => ({
      kind,
      ...splitAcceptance(rows.filter((row) => row.kind === kind)),
    })),
    overall: splitAcceptance(rows),
  };
};

const reviewCounts = async (db: SignalQueryable, window: MetricsWindow) => {
  const { from, to } = window;
  const [row] = await query<{
    created: unknown;
    median_hours: unknown;
    pending: unknown;
    resolved: unknown;
    triaged: unknown;
  }>(
    db,
    sql`
      WITH created AS (
        SELECT suggestion_id, min(occurred_at) AS created_at
        FROM events
        WHERE type = 'suggestion.created' AND suggestion_id IS NOT NULL
          AND occurred_at < ${ts(to)}
        GROUP BY suggestion_id
      ), resolved AS (${resolutions(window)})
      SELECT
        (SELECT count(*) FROM created WHERE created_at >= ${ts(from)})::int AS created,
        (SELECT count(*) FROM resolved)::int AS resolved,
        (SELECT count(*) FROM created c WHERE NOT EXISTS (
          SELECT 1 FROM events r
          WHERE r.type IN ${resolutionTypes} AND r.suggestion_id = c.suggestion_id
            AND r.occurred_at < ${ts(to)}
        ))::int AS pending,
        (SELECT (percentile_cont(0.5) WITHIN GROUP (
          ORDER BY extract(epoch FROM r.occurred_at - c.created_at) / 3600
        ))::float8 FROM resolved r JOIN created c ON c.suggestion_id = r.suggestion_id)
          AS median_hours,
        (SELECT count(*) FROM resolved r JOIN created c ON c.suggestion_id = r.suggestion_id)::int
          AS triaged
    `,
  );
  return {
    reviewLoad: {
      created: num(row?.created),
      pendingAtEnd: num(row?.pending),
      resolved: num(row?.resolved),
    },
    timeToTriage: {
      medianHours: round(numOrNull(row?.median_hours)),
      resolved: num(row?.triaged),
    },
  };
};

const unmergeRate = async (db: SignalQueryable, { from, to }: MetricsWindow) => {
  const [row] = await query<{ merges: unknown; undone: unknown }>(
    db,
    sql`
      SELECT count(*)::int AS merges,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM events u
          WHERE u.type = 'merge.undone' AND u.occurred_at < ${ts(to)}
            AND u.payload->>'mergeId' = m.payload->>'mergeId'
        ))::int AS undone
      FROM (
        SELECT DISTINCT ON (COALESCE(payload->>'mergeId', id::text)) payload
        FROM events
        WHERE type = 'need.merged' AND occurred_at >= ${ts(from)} AND occurred_at < ${ts(to)}
        ORDER BY COALESCE(payload->>'mergeId', id::text), occurred_at
      ) m
    `,
  );
  const merges = num(row?.merges);
  const undone = num(row?.undone);
  return { merges, rate: ratio(undone, merges), undone };
};

/** Need merges active as of `to`, with the need each was merged into. */
const activeMergeTargets = (to: Date) => sql`
  SELECT m.need_id, m.payload->>'intoNeedId' AS into_need_id FROM events m
  WHERE m.type = 'need.merged' AND m.need_id IS NOT NULL AND m.occurred_at < ${ts(to)}
    AND NOT EXISTS (
      SELECT 1 FROM events u
      WHERE u.type = 'merge.undone' AND u.occurred_at < ${ts(to)}
        AND u.payload->>'mergeId' = m.payload->>'mergeId'
    )`;

interface ExposureRow {
  actor_kind: ActorKind;
  filed_new: unknown;
  merged_elsewhere: unknown;
  merged_into_shown: unknown;
  moved_off: unknown;
  none_shown: unknown;
  rank_1: unknown;
  rank_2: unknown;
  rank_3: unknown;
  shown: unknown;
  skipped: unknown;
  taken: unknown;
  unknown: unknown;
}

const exposureCounts = (db: SignalQueryable, { from, to }: MetricsWindow) =>
  query<ExposureRow>(
    db,
    sql`
      WITH created AS (
        SELECT DISTINCT ON (COALESCE(signal_id, id))
          signal_id, actor_kind, need_id, occurred_at, payload,
          payload->'exposure'->>'kind' AS kind,
          (payload->'exposure'->>'chosenRank')::int AS chosen_rank,
          payload->'exposure'->'shownNeedIds' AS shown_ids
        FROM events
        WHERE type = 'signal.created' AND occurred_at >= ${ts(from)} AND occurred_at < ${ts(to)}
        ORDER BY COALESCE(signal_id, id), occurred_at
      ), merges AS (${activeMergeTargets(to)}),
      shown AS (
        SELECT c.*,
          EXISTS (
            SELECT 1 FROM merges mg
            WHERE mg.need_id = c.need_id AND c.shown_ids @> jsonb_build_array(mg.into_need_id)
          ) AS into_shown,
          EXISTS (SELECT 1 FROM merges mg WHERE mg.need_id = c.need_id) AS merged,
          EXISTS (
            SELECT 1 FROM events s
            WHERE s.type = 'need.split' AND s.need_id = c.need_id
              AND s.occurred_at >= c.occurred_at AND s.occurred_at < ${ts(to)}
              AND s.payload->'signalIds' @> jsonb_build_array(c.signal_id::text)
          ) AS moved
        FROM created c WHERE c.kind = 'shown'
      )
      SELECT actor_kind,
        count(*) FILTER (WHERE kind = 'shown')::int AS shown,
        count(*) FILTER (WHERE kind = 'none_shown')::int AS none_shown,
        count(*) FILTER (WHERE kind = 'skipped')::int AS skipped,
        count(*) FILTER (WHERE kind = 'unknown')::int AS unknown,
        (SELECT count(*) FROM shown s WHERE s.actor_kind = c.actor_kind
          AND s.chosen_rank IS NOT NULL)::int AS taken,
        (SELECT count(*) FROM shown s WHERE s.actor_kind = c.actor_kind
          AND s.chosen_rank = 1)::int AS rank_1,
        (SELECT count(*) FROM shown s WHERE s.actor_kind = c.actor_kind
          AND s.chosen_rank = 2)::int AS rank_2,
        (SELECT count(*) FROM shown s WHERE s.actor_kind = c.actor_kind
          AND s.chosen_rank = 3)::int AS rank_3,
        (SELECT count(*) FROM shown s WHERE s.actor_kind = c.actor_kind
          AND s.payload->>'attachedTo' = 'draft')::int AS filed_new,
        (SELECT count(*) FROM shown s WHERE s.actor_kind = c.actor_kind
          AND s.payload->>'attachedTo' = 'draft' AND s.into_shown)::int AS merged_into_shown,
        (SELECT count(*) FROM shown s WHERE s.actor_kind = c.actor_kind
          AND s.payload->>'attachedTo' = 'draft' AND s.merged AND NOT s.into_shown)::int
          AS merged_elsewhere,
        (SELECT count(*) FROM shown s WHERE s.actor_kind = c.actor_kind
          AND s.chosen_rank IS NOT NULL AND s.moved)::int AS moved_off
      FROM created c
      GROUP BY actor_kind
    `,
  );

const exposureFrom = (rows: ExposureRow[], kind?: ActorKind): ExposureCounts => {
  const matching = rows.filter((row) => !kind || row.actor_kind === kind);
  const sum = (key: Exclude<keyof ExposureRow, "actor_kind">) =>
    matching.reduce((total, row) => total + num(row[key]), 0);
  const filedNew = sum("filed_new");
  const mergedIntoShown = sum("merged_into_shown");
  const mergedElsewhere = sum("merged_elsewhere");
  const taken = sum("taken");
  const shown = sum("shown");
  const moved = sum("moved_off");
  return {
    chosenRank: { 1: sum("rank_1"), 2: sum("rank_2"), 3: sum("rank_3") },
    filedNewDespiteMatch: {
      mergedElsewhere,
      mergedIntoShown,
      total: filedNew,
      unmerged: filedNew - mergedIntoShown - mergedElsewhere,
    },
    movedOffTakenMatch: { moved, rate: ratio(moved, taken) },
    noneShown: sum("none_shown"),
    shown,
    skipped: sum("skipped"),
    takeUpRate: ratio(taken, shown),
    taken,
    unknown: sum("unknown"),
  };
};

const abandonedPreviews = async (db: SignalQueryable, { from, to }: MetricsWindow) => {
  const rows = await query<{ actor_kind: ActorKind; previews: unknown }>(
    db,
    sql`
      SELECT p.actor_kind, count(*)::int AS previews
      FROM events p
      WHERE p.type = 'preview.shown' AND p.occurred_at >= ${ts(from)} AND p.occurred_at < ${ts(to)}
        AND jsonb_array_length(COALESCE(p.payload->'matches', '[]'::jsonb)) > 0
        AND NOT EXISTS (
          SELECT 1 FROM events s
          WHERE s.type = 'signal.created' AND s.payload->>'previewId' = p.payload->>'previewId'
            AND s.occurred_at >= p.occurred_at
            AND s.occurred_at < p.occurred_at + make_interval(hours => ${PREVIEW_SUBMIT_HOURS})
        )
      GROUP BY p.actor_kind
    `,
  );
  const of = (kind?: ActorKind) =>
    rows
      .filter((row) => !kind || row.actor_kind === kind)
      .reduce((sum, row) => sum + num(row.previews), 0);
  return { agent: of("agent"), all: of(), human: of("human") };
};

const killCriterion = async (db: SignalQueryable, { to }: MetricsWindow) => {
  const rows = await query<{
    actor_kind: ActorKind;
    attached: unknown;
    merged_drafts: unknown;
    shown: unknown;
  }>(
    db,
    sql`
      WITH created AS (
        SELECT DISTINCT ON (COALESCE(signal_id, id)) actor_kind, need_id, payload
        FROM events
        WHERE type = 'signal.created' AND occurred_at < ${ts(to)}
          AND payload->'exposure'->>'kind' = 'shown'
        ORDER BY COALESCE(signal_id, id), occurred_at
      )
      SELECT actor_kind,
        count(*)::int AS shown,
        count(*) FILTER (WHERE payload->>'attachedTo' = 'existing')::int AS attached,
        count(*) FILTER (
          WHERE payload->>'attachedTo' = 'draft' AND need_id IN (${activeMerges(to)})
        )::int AS merged_drafts
      FROM created
      GROUP BY actor_kind
    `,
  );
  const unmerge = await unmergeRate(db, { from: new Date(0), to });
  const population = (kind?: ActorKind): KillPopulation => {
    const matching = rows.filter((row) => !kind || row.actor_kind === kind);
    const total = (key: "attached" | "merged_drafts" | "shown") =>
      matching.reduce((sum, row) => sum + num(row[key]), 0);
    const preventionRate = toPrevention(total("attached"), total("merged_drafts"));
    const shownSubmissions = total("shown");
    let verdict: KillPopulation["verdict"] = "pass";
    if (shownSubmissions < KILL_CRITERION_MIN_SHOWN) verdict = "insufficient_data";
    else if (
      (preventionRate.rate ?? 0) < KILL_CRITERION_MIN_PREVENTION ||
      (unmerge.rate ?? 0) > KILL_CRITERION_MAX_UNMERGE
    )
      verdict = "fail";
    return { preventionRate, shownSubmissions, verdict };
  };
  return {
    maxUnmergeRate: KILL_CRITERION_MAX_UNMERGE,
    minPreventionRate: KILL_CRITERION_MIN_PREVENTION,
    minShownSubmissions: KILL_CRITERION_MIN_SHOWN,
    populations: { agent: population("agent"), all: population(), human: population("human") },
    unmergeRate: unmerge,
  };
};

/**
 * The weekly prevention series of `get_metrics` (`preventionRate.weeks`) for one actor split,
 * plus the `signal.created` count per week; the `metrics_weekly` report dataset (spec 013).
 */
export const weeklyPreventionSeries = async (
  db: SignalQueryable,
  window: MetricsWindow,
  actor: ActorKind | "all",
) => {
  const rows = await signalCounts(db, window);
  return weekStarts(window).map((weekStart) => {
    const week = rows.filter(
      (row) => row.week === weekStart && (actor === "all" || row.actor_kind === actor),
    );
    return {
      ...preventionFrom(week),
      signals: week.reduce((sum, row) => sum + num(row.signals), 0),
      weekStart,
    };
  });
};

/** All MVP metrics and supporting counts for `[from, to)`. */
export const computeMetrics = async (
  db: SignalQueryable,
  window: MetricsWindow,
): Promise<Metrics> => {
  const signalRows = await signalCounts(db, window);
  const latency = await decisionLatency(db, window);
  const acceptance = await suggestionAcceptance(db, window);
  const review = await reviewCounts(db, window);
  const unmerge = await unmergeRate(db, window);
  const direction = await directionAccuracy(db, window);
  const readiness = await readinessLeadTime(db, window);
  const exposureRows = await exposureCounts(db, window);
  const abandoned = await abandonedPreviews(db, window);
  const kill = await killCriterion(db, window);

  return {
    decisionLatency: latency,
    directionAccuracy: direction,
    exposure: {
      previewsWithoutSubmission: abandoned,
      submissions: {
        agent: exposureFrom(exposureRows, "agent"),
        all: exposureFrom(exposureRows),
        human: exposureFrom(exposureRows, "human"),
      },
    },
    killCriterion: kill,
    preventionRate: {
      overall: {
        agent: preventionFrom(signalRows, "agent"),
        all: preventionFrom(signalRows),
        human: preventionFrom(signalRows, "human"),
      },
      weeks: weekStarts(window).map((weekStart) => {
        const rows = signalRows.filter((row) => row.week === weekStart);
        return {
          agent: preventionFrom(rows, "agent"),
          all: preventionFrom(rows),
          human: preventionFrom(rows, "human"),
          weekStart,
        };
      }),
    },
    readinessLeadTime: readiness,
    suggestionAcceptance: acceptance,
    supporting: {
      contextRate: {
        agent: contextFrom(signalRows, "agent"),
        all: contextFrom(signalRows),
        human: contextFrom(signalRows, "human"),
      },
      ...review,
      unmergeRate: unmerge,
    },
    unsupported: unsupportedMetrics.map((entry) => ({ ...entry })),
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
  };
};

/** Resolves an optional `from`/`to` against the clock: `to` defaults to now, `from` to 28 days before. */
export const resolveMetricsWindow = (
  input: { from?: string; to?: string },
  now: Date,
): MetricsWindow => {
  const to = input.to ? new Date(input.to) : now;
  const from = input.from
    ? new Date(input.from)
    : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
  return { from, to };
};
