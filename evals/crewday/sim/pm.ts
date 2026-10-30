import { and, eq, inArray, notExists, sql } from "drizzle-orm";

import { decisions, needs } from "@/lib/db/schema";
import { criterionKeys } from "@/lib/signal/domain/criteria";
import type { SuggestionView } from "@/lib/signal/domain/suggestions";

import { shareSolution, trueScore, weightedScore } from "./oracle";
import type { Verdict } from "./oracle";
import { draw, identityOf } from "./state";
import type { ActionClass, RecommendedStatus, SimState } from "./state";
import type { CallResult, Surface } from "./surfaces";

/**
 * The PM policy (spec 004 → Simulation), run once per simulated week with `pmActions` actions.
 * It never consults a model: it has no AI port, judges by ground truth (an embedding lookup for
 * draft statements is the oracle's, not the PM's), and only calls operations. Each week:
 *
 * 1. **Triage** (organizing, at most `triageActionCap` actions): `list_suggestions`, then
 *    `resolve_suggestion` per suggestion, judged by the spec's table; `pPmError` flips a verdict.
 * 2. **Decisions** (deciding): live, undecided needs whose supporting accounts' ARR reached
 *    `readinessArrCents`, largest first, while a brief fits the budget. Signal arm:
 *    `draft_decision_brief` + review (`resolve_suggestion`) + `publish_decision` = 3 actions.
 *    Board arm: a hand-written brief (`handBriefActions`) + `publish_decision`. The verdict is the
 *    strategy's, flipped with `pPmError`.
 * 3. **Manual dedup** (organizing) with what is left: read the next unread draft or backlog need's
 *    raw signal (`get_need_detail`, one action); with `pManualFind` the PM spots another live
 *    need with the same true need and merges this one into it (`merge_needs`).
 *
 * Readiness is observed from the database for free (the PM's dashboard); only actions cost.
 *
 * Under `pmPolicy: "follows_signal"` (spec 007, Signal arm only), step 2 is
 * `decideFollowingSignal` instead: Signal says which needs are ready and what to decide.
 */

interface Week {
  budget: number;
  index: number;
  surface: Surface;
}

const spend = (state: SimState, week: Week, cls: ActionClass, what: string, cost = 1) => {
  week.budget -= cost;
  for (let i = 0; i < cost; i += 1)
    state.log.actions.push({
      at: state.clock.current().toISOString(),
      class: cls,
      week: week.index,
      what,
    });
};

const act = (
  state: SimState,
  week: Week,
  cls: ActionClass,
  operation: string,
  input: Record<string, unknown>,
): Promise<CallResult> => {
  spend(state, week, cls, operation);
  return state.router.call(week.surface, operation, input);
};

const flip = (state: SimState, name: string, verdict: Verdict): Verdict => {
  if (!draw(state, `pm:flip:${name}`).chance(state.policy.pPmError)) return verdict;
  return verdict === "reject" ? "accept" : "reject";
};

interface Judgement {
  edit?: Record<string, unknown>;
  key: string | null;
  verdict: Verdict;
}

type Judge = (
  state: SimState,
  suggestion: SuggestionView,
  key: string | null,
) => Promise<Judgement>;

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Accept when the statement's nearest world need is the signal's; edit on a shared solution. */
const judgeDraftNeed: Judge = async (state, suggestion, needKey) => {
  const [signalId] = suggestion.signalIds;
  const worldId = signalId ? state.signalOrigin.get(signalId) : undefined;
  const signal = worldId ? state.index.signals.get(worldId) : undefined;
  const keys = signal?.labels.needKeys ?? (needKey ? [needKey] : []);
  const [main = null] = keys;
  const statement = text(suggestion.payload.statement);
  const nearest = statement ? await state.nearest.nearest(statement) : null;
  const signalNeed = main ? state.index.needs.get(main) : undefined;
  if (nearest && keys.includes(nearest)) return { key: main, verdict: "accept" };
  if (nearest && signalNeed && shareSolution(state.index.needs.get(nearest), signalNeed))
    return { edit: { statement: signalNeed.statement }, key: main, verdict: "edit" };
  return { key: main, verdict: "reject" };
};

const judgeMerge: Judge = async (state, suggestion, key) => {
  const other = suggestion.relatedNeedId ? await identityOf(state, suggestion.relatedNeedId) : null;
  return { key, verdict: key && other === key ? "accept" : "reject" };
};

const judgeTheme: Judge = (state, suggestion, key) => {
  const need = key ? state.index.needs.get(key) : undefined;
  const truth = need ? state.index.themeNames.get(need.themeKey) : undefined;
  const name = text(suggestion.payload.themeName).trim().toLowerCase();
  return Promise.resolve({
    key,
    verdict: truth && truth.toLowerCase() === name ? "accept" : "reject",
  });
};

/** Within one point of the true priority: accept; two off: edit to the true score. */
const judgePriority: Judge = (state, suggestion, key) => {
  const target = key ? trueScore(state.index, key) : null;
  const score = weightedScore((suggestion.payload.scores ?? {}) as Record<string, number>);
  if (target === null || score === null) return Promise.resolve({ key, verdict: "reject" });
  const off = Math.abs(score - target);
  if (off <= 1) return Promise.resolve({ key, verdict: "accept" });
  if (off > 2) return Promise.resolve({ key, verdict: "reject" });
  const value = Math.round(target * 10) / 10;
  return Promise.resolve({
    edit: { scores: Object.fromEntries(criterionKeys.map((criterion) => [criterion, value])) },
    key,
    verdict: "edit",
  });
};

/** Spec triage table, Public summary: accept an anonymized summary, reject one naming anyone. */
const judgePublicSummary: Judge = (state, suggestion, key) => {
  const summary = text(suggestion.payload.summary).toLowerCase();
  const { world } = state;
  const terms = [
    ...world.personas.flatMap((persona) => [persona.name, persona.email]),
    ...world.accounts.map((account) => account.name),
    ...world.signals.flatMap((signal) => signal.pii ?? []),
  ].map((term) => term.toLowerCase());
  const clean = summary.length > 0 && !terms.some((term) => summary.includes(term));
  return Promise.resolve({ key, verdict: clean ? "accept" : "reject" });
};

/** Spec triage table, Split: accept when the moved signals share a true need the need lacks. */
const judgeSplit: Judge = (state, suggestion, key) => {
  const moved = ((suggestion.payload.signalIds ?? []) as string[]).map(
    (id) => state.index.signals.get(state.signalOrigin.get(id) ?? "")?.labels.needKeys[0],
  );
  const [first] = moved;
  const good = Boolean(first && first !== key && moved.every((other) => other === first));
  return Promise.resolve({ key, verdict: good ? "accept" : "reject" });
};

/**
 * Accept when the brief recommends the strategy-implied status; edit (the PM rewrites the
 * recommendation) when it cannot be read; reject a wrong recommendation.
 */
const judgeBrief: Judge = (state, suggestion, key) => {
  const recommendation = suggestion.payload.recommendation as { status?: unknown } | undefined;
  const recommended = text(recommendation?.status);
  const truth = key ? state.index.needs.get(key)?.strategyDecision.status : undefined;
  if (!truth || !recommended)
    return Promise.resolve({
      edit: {
        markdown: `${text(suggestion.payload.markdown) || "Decision brief."}\n\nRecommended: ${truth ?? "declined"}.`,
      },
      key,
      verdict: "edit",
    });
  return Promise.resolve({ key, verdict: recommended === truth ? "accept" : "reject" });
};

const judges: Partial<Record<SuggestionView["kind"], Judge>> = {
  decision_brief: judgeBrief,
  draft_need: judgeDraftNeed,
  merge: judgeMerge,
  priority: judgePriority,
  public_summary: judgePublicSummary,
  split: judgeSplit,
  theme: judgeTheme,
};

/** Ground-truth verdict for one suggestion (spec 004 → PM policy, triage table). */
const judge = async (state: SimState, suggestion: SuggestionView): Promise<Judgement> => {
  const key = suggestion.needId ? await identityOf(state, suggestion.needId) : null;
  const byKind = judges[suggestion.kind];
  return byKind ? byKind(state, suggestion, key) : { key, verdict: "reject" };
};

const PAGE = 100;

/** Every pending suggestion, oldest first, independent of database order (ids are random). */
const listPending = async (state: SimState, week: Week, take: () => boolean) => {
  const queue: SuggestionView[] = [];
  let cursor: string | undefined;
  do {
    if (!take()) break;
    const page = await act(state, week, "organizing", "list_suggestions", { cursor, limit: PAGE });
    if (!page.ok) break;
    const data = page.data as { nextCursor: string | null; suggestions: SuggestionView[] };
    queue.push(...data.suggestions);
    cursor = data.nextCursor ?? undefined;
  } while (cursor);
  return queue.toSorted(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) ||
      a.kind.localeCompare(b.kind) ||
      JSON.stringify(a.payload).localeCompare(JSON.stringify(b.payload)),
  );
};

const resolveOne = async (
  state: SimState,
  week: Week,
  suggestion: SuggestionView,
  dead: Set<string>,
  cls: ActionClass = "organizing",
) => {
  const truth = await judge(state, suggestion);
  const applied = flip(
    state,
    `${suggestion.kind}:${truth.key ?? "?"}:${suggestion.createdAt}`,
    truth.verdict === "edit" ? "accept" : truth.verdict,
  );
  const action = applied === "accept" && truth.verdict === "edit" ? "edit" : applied;
  const result = await act(state, week, cls, "resolve_suggestion", {
    action,
    edit: action === "edit" ? truth.edit : undefined,
    id: suggestion.id,
  });
  // A conflict (its need was merged or changed) leaves it pending; never retry it.
  if (!result.ok) dead.add(suggestion.id);
  state.log.verdicts.push({
    applied: action,
    kind: suggestion.kind,
    needId: suggestion.needId,
    resolved: result.ok,
    suggestionId: suggestion.id,
    trueNeedKey: truth.key,
    truth: truth.verdict,
  });
};

const triage = async (state: SimState, week: Week, dead: Set<string>) => {
  let spent = 0;
  const take = () => {
    if (week.budget < 1 || spent >= state.policy.triageActionCap) return false;
    spent += 1;
    return true;
  };
  for (;;) {
    const work = (await listPending(state, week, take)).filter(
      (s) => s.kind !== "decision_brief" && !dead.has(s.id),
    );
    if (work.length === 0) return;
    for (const suggestion of work) {
      if (!take()) return;
      await resolveOne(state, week, suggestion, dead);
    }
  }
};

/** Live, undecided needs with the ARR of their distinct supporting accounts. */
const observeDemand = async (state: SimState) => {
  const rows = await state.db
    .select({
      arr: sql<number>`coalesce((
        select sum(a.arr_cents)::float8 from accounts a where a.id in (
          select sb.account_id from signals s join submitters sb on sb.id = s.submitter_id
          where s.need_id = "needs"."id"
        )
      ), 0)`,
      createdAt: needs.createdAt,
      id: needs.id,
      statement: needs.statement,
    })
    .from(needs)
    .where(
      and(
        inArray(needs.status, ["draft", "open"]),
        notExists(
          state.db
            .select({ one: sql`1` })
            .from(decisions)
            .where(eq(decisions.needId, needs.id)),
        ),
      ),
    );
  return rows
    .map((row) => ({ ...row, arr: Number(row.arr), createdAt: new Date(row.createdAt) }))
    .toSorted(
      (a, b) =>
        b.arr - a.arr ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.statement.localeCompare(b.statement),
    );
};

const NOTE = {
  declined: "We looked closely at this request and decided not to build it for now.",
  planned: "Thank you for the requests; this is now planned.",
} as const;

const opposite = { declined: "planned", planned: "declined" } as const;

const recommendationOf = (payload: unknown): RecommendedStatus | null => {
  const recommendation = (payload as { recommendation?: { status?: unknown } } | undefined)
    ?.recommendation;
  const status = recommendation?.status;
  return status === "planned" ||
    status === "in_progress" ||
    status === "shipped" ||
    status === "declined"
    ? status
    : null;
};

/** The oracle only knows planned or declined: any other non-declined status is planned. */
const asDecision = (status: RecommendedStatus) => (status === "declined" ? "declined" : "planned");

/** The status Crewday's strategy memo implies for a need (declined when unknown). */
const strategyDecision = (state: SimState, key: string | null) =>
  (key && state.index.needs.get(key)?.strategyDecision.status) || "declined";

/** Drafts and reviews a brief (Signal arm) or writes one by hand; false when it does not fit. */
const prepareBrief = async (state: SimState, week: Week, needId: string) => {
  const { handBriefActions } = state.policy;
  if (state.arm === "signal") {
    const brief = await act(state, week, "deciding", "draft_decision_brief", { id: needId });
    if (brief.ok) {
      const { suggestion } = brief.data as { suggestion: SuggestionView };
      // Reviewed like any suggestion, so acceptance precision sees the verdict.
      await resolveOne(state, week, suggestion, new Set(), "deciding");
      return { recommended: recommendationOf(suggestion.payload), via: "brief" as const };
    }
  }
  if (week.budget < handBriefActions + 1) return false;
  spend(state, week, "deciding", "hand_brief", handBriefActions);
  return { recommended: null, via: "hand" as const };
};

const decide = async (state: SimState, week: Week, readyAt: Map<string, string>) => {
  const now = state.clock.current().toISOString();
  const demand = await observeDemand(state);
  const ready = demand.filter((need) => need.arr >= state.policy.readinessArrCents);
  for (const need of ready) if (!readyAt.has(need.id)) readyAt.set(need.id, now);
  const briefCost = state.arm === "signal" ? 2 : state.policy.handBriefActions;
  for (const need of ready) {
    if (week.budget < briefCost + 1) return;
    const prepared = await prepareBrief(state, week, need.id);
    if (!prepared) return;
    const key = await identityOf(state, need.id);
    const truth = strategyDecision(state, key);
    const noisy = draw(state, `pm:decide:${key ?? need.id}:${week.index}`);
    const status = noisy.chance(state.policy.pPmError) ? opposite[truth] : truth;
    const published = await act(state, week, "deciding", "publish_decision", {
      id: need.id,
      note: NOTE[status],
      status,
    });
    if (published.ok)
      state.log.decisions.push({
        at: state.clock.current().toISOString(),
        needId: need.id,
        needKey: key,
        readyAt: readyAt.get(need.id) ?? now,
        recommendedStatus: prepared.recommended,
        status,
        via: prepared.via,
      });
  }
};

/** One need from `list_ready_needs` (spec 007 → Typed API contract). */
export interface ReadyNeed {
  arrCents: number;
  brief: {
    recommendation: {
      capacityNote?: string;
      confidence?: number;
      note: string;
      status: RecommendedStatus;
      strategyFit?: { inFocus: boolean; reason: string };
    } | null;
    status: string;
    suggestionId: string;
  } | null;
  needId: string;
  readyAt: string;
  statement: string;
  supporters: number;
}

/** Every ready, undecided need (oldest ready first, Signal's order); one action per page. */
const listReady = async (state: SimState, week: Week) => {
  const ready: ReadyNeed[] = [];
  let cursor: string | undefined;
  do {
    if (week.budget < 1) break;
    const page = await act(state, week, "deciding", "list_ready_needs", cursor ? { cursor } : {});
    if (!page.ok) break;
    const data = page.data as { needs: ReadyNeed[]; nextCursor: string | null };
    ready.push(...data.needs);
    cursor = data.nextCursor ?? undefined;
  } while (cursor);
  return ready;
};

type ReadyBrief = NonNullable<ReadyNeed["brief"]>;

/**
 * Accepts a brief as Signal drafted it (the PM follows Signal), logging ground truth's verdict
 * beside it so acceptance precision still sees whether the brief was right.
 */
const acceptBrief = async (state: SimState, week: Week, needId: string, brief: ReadyBrief) => {
  const result = await act(state, week, "deciding", "resolve_suggestion", {
    action: "accept",
    id: brief.suggestionId,
  });
  const key = await identityOf(state, needId);
  const truth = await judgeBrief(
    state,
    { payload: { recommendation: brief.recommendation } } as unknown as SuggestionView,
    key,
  );
  state.log.verdicts.push({
    applied: "accept",
    kind: "decision_brief",
    needId,
    resolved: result.ok,
    suggestionId: brief.suggestionId,
    trueNeedKey: key,
    truth: truth.verdict,
  });
  return result.ok;
};

/** Actions left to decide a need: publish, plus a review, plus a draft when there is no brief. */
const costToDecide = (brief: ReadyNeed["brief"]) => {
  if (brief?.status === "accepted" || brief?.status === "edited") return 1;
  return brief?.status === "pending" ? 2 : 3;
};

/** A reviewed brief to publish from: drafted when missing, accepted when pending; else null. */
const reviewedBrief = async (
  state: SimState,
  week: Week,
  need: ReadyNeed,
): Promise<ReadyBrief | null> => {
  const cost = costToDecide(need.brief);
  if (cost === 1) return need.brief;
  let { brief } = need;
  if (cost === 3) {
    const drafted = await act(state, week, "deciding", "draft_decision_brief", {
      id: need.needId,
    });
    if (!drafted.ok) return null;
    const { suggestion } = drafted.data as { suggestion: SuggestionView };
    brief = {
      recommendation: (suggestion.payload.recommendation ?? null) as ReadyBrief["recommendation"],
      status: suggestion.status,
      suggestionId: suggestion.id,
    };
  }
  if (!brief) return null;
  return (await acceptBrief(state, week, need.needId, brief)) ? brief : null;
};

/**
 * `follows_signal` (spec 007 → Crewday), Signal arm: the PM reads `list_ready_needs` instead of
 * observing readiness, accepts each need's pending brief (`resolve_suggestion`), and publishes its
 * recommendation; with `pPmOverride` (`pm:override:<need>:<week>`) it publishes the
 * strategy-implied status instead. A need whose brief is missing (`brief: null`, or one already
 * rejected) gets one drafted first (`draft_decision_brief`, one more action) when it fits; an
 * already accepted or edited brief is published without another review. Same costs as `oracle`:
 * one action per operation call; a need that does not fit the budget left waits for next week.
 */
const decideFollowingSignal = async (state: SimState, week: Week) => {
  const ready = await listReady(state, week);
  for (const need of ready) {
    if (week.budget < costToDecide(need.brief)) continue;
    const brief = await reviewedBrief(state, week, need);
    if (!brief) continue;
    const key = await identityOf(state, need.needId);
    const truth = strategyDecision(state, key);
    const recommended = recommendationOf(brief);
    const override = draw(state, `pm:override:${key ?? need.needId}:${week.index}`).chance(
      state.policy.pPmOverride,
    );
    const status = override || !recommended ? truth : asDecision(recommended);
    const published = await act(state, week, "deciding", "publish_decision", {
      id: need.needId,
      note: NOTE[status],
      status,
    });
    if (published.ok)
      state.log.decisions.push({
        at: state.clock.current().toISOString(),
        needId: need.needId,
        needKey: key,
        overridden: recommended !== null && status !== asDecision(recommended),
        readyAt: new Date(need.readyAt).toISOString(),
        recommendedStatus: recommended,
        status,
        via: "brief",
      });
  }
};

/** The oldest other live need with the same true need, if any. */
const twinOf = async (state: SimState, needId: string, key: string) => {
  const live = await state.db
    .select({ createdAt: needs.createdAt, id: needs.id })
    .from(needs)
    .where(
      inArray(needs.status, ["draft", "open", "planned", "in_progress", "shipped", "declined"]),
    );
  const oldestFirst = live.toSorted(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  for (const need of oldestFirst)
    if (need.id !== needId && (await identityOf(state, need.id)) === key) return need.id;
};

const manualDedup = async (state: SimState, week: Week) => {
  while (week.budget >= 1 && state.readQueue.length > 0) {
    const needId = state.readQueue.shift() ?? "";
    const [row] = await state.db
      .select({ status: needs.status })
      .from(needs)
      .where(eq(needs.id, needId));
    // Already merged away (triage or an earlier read): nothing left to read there.
    if (!row || row.status === "merged") continue;
    const detail = await act(state, week, "organizing", "get_need_detail", { id: needId });
    const key = await identityOf(state, needId);
    if (
      !detail.ok ||
      !draw(state, `pm:find:${key ?? needId}:${week.index}`).chance(state.policy.pManualFind)
    )
      continue;
    const target = key ? await twinOf(state, needId, key) : undefined;
    if (target && week.budget >= 1)
      await act(state, week, "organizing", "merge_needs", { id: needId, intoNeedId: target });
  }
};

export interface PmMemory {
  /** Suggestions whose resolution conflicted; skipped from then on. */
  dead: Set<string>;
  /** When the PM first saw each need ready. */
  readyAt: Map<string, string>;
}

export const createPmMemory = (): PmMemory => ({ dead: new Set(), readyAt: new Map() });

/** One simulated week of PM work; the surface alternates REST (even weeks) and Operator MCP. */
export const runPmWeek = async (state: SimState, memory: PmMemory, index: number) => {
  const week: Week = {
    budget: state.policy.pmActions,
    index,
    surface: index % 2 === 0 ? "rest" : "operator_mcp",
  };
  await triage(state, week, memory.dead);
  await (state.arm === "signal" && state.policy.pmPolicy === "follows_signal"
    ? decideFollowingSignal(state, week)
    : decide(state, week, memory.readyAt));
  await manualDedup(state, week);
};
