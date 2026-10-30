import type { SignalClientError, SignalOperations } from "@/lib/signal/client";

/**
 * View types and pure rules for the PM console (spec 006 task 05): the triage keymap, each
 * suggestion kind's proposal and edit body, and number formats. Browser-safe: no server imports.
 */

export type SuggestionView = SignalOperations["list_suggestions"]["output"]["suggestions"][number];
export type SuggestionKind = SuggestionView["kind"];
export type Resolution = SignalOperations["resolve_suggestion"]["output"];
export type NeedDetail = SignalOperations["get_need_detail"]["output"];
export type NeedSignal = NeedDetail["signals"][number];
export type OperatorNeed = SignalOperations["list_operator_needs"]["output"]["needs"][number];
export type OperatorNeedStatus = OperatorNeed["status"];
export type OperatorNeedSort = NonNullable<
  SignalOperations["list_operator_needs"]["input"]["sort"]
>;
export type CriterionKey = NeedDetail["scores"][number]["criterion"];
export type PublicTextFinding = SignalOperations["check_public_text"]["output"]["findings"][number];

export const kindLabels: Record<SuggestionKind, string> = {
  decision_brief: "Decision brief",
  draft_need: "Draft need",
  merge: "Merge",
  priority: "Priority",
  public_summary: "Summary",
  split: "Split",
  theme: "Theme",
};

export const criterionKeys = [
  "demand",
  "business_value",
  "strategic_fit",
  "effort",
] as const satisfies readonly CriterionKey[];

export const criterionLabels: Record<CriterionKey, string> = {
  business_value: "Business value",
  demand: "Demand",
  effort: "Effort",
  strategic_fit: "Strategic fit",
};

export const operatorStatuses = [
  "draft",
  "open",
  "planned",
  "in_progress",
  "shipped",
  "declined",
] as const satisfies readonly OperatorNeedStatus[];

export const operatorStatusLabels: Record<OperatorNeedStatus | "merged", string> = {
  declined: "Declined",
  draft: "Draft",
  in_progress: "In progress",
  merged: "Merged",
  open: "Open",
  planned: "Planned",
  shipped: "Shipped",
};

export const sortLabels: Record<OperatorNeedSort, string> = {
  accounts: "Accounts",
  arr: "ARR",
  people: "People",
  priority: "Priority",
};

// Triage keyboard -----------------------------------------------------------------------------

export type TriageCommand = "next" | "previous" | "accept" | "edit" | "reject" | "cancel";

const letterCommands: Record<string, TriageCommand> = {
  a: "accept",
  e: "edit",
  j: "next",
  k: "previous",
  r: "reject",
};

/**
 * DESIGN.md → Actions: J/K move, A accept, E edit, R reject, Esc cancel. Letters do nothing
 * while the PM is typing or holds a modifier; Esc always cancels.
 */
export const triageCommand = (event: {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  typing: boolean;
}): TriageCommand | null => {
  if (event.key === "Escape") return "cancel";
  if (event.typing || event.altKey || event.ctrlKey || event.metaKey) return null;
  return letterCommands[event.key.toLowerCase()] ?? null;
};

/** The row to open after one is resolved: the next pending row, else an earlier one. */
export const nextPendingAfter = (
  ids: readonly string[],
  current: string,
  resolved: ReadonlySet<string>,
): string | null => {
  const index = ids.indexOf(current);
  const ordered = [...ids.slice(index + 1), ...ids.slice(0, Math.max(index, 0))];
  return ordered.find((id) => !resolved.has(id)) ?? null;
};

// Proposals and edits -------------------------------------------------------------------------

const text = (value: unknown) => (typeof value === "string" ? value : "");
const ids = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const scoreMap = (value: unknown) => {
  const scores: Partial<Record<CriterionKey, number>> = {};
  if (value && typeof value === "object")
    for (const key of criterionKeys) {
      const score = (value as Record<string, unknown>)[key];
      if (typeof score === "number") scores[key] = score;
    }
  return scores;
};

/** The proposal's fields by kind, read defensively from the free-form payload. */
export const proposalOf = (
  suggestion: Pick<SuggestionView, "kind" | "payload" | "relatedNeedId" | "signalIds" | "themeId">,
) => {
  const { payload } = suggestion;
  const signalIds = ids(payload.signalIds);
  return {
    intoNeedId: text(payload.intoNeedId) || (suggestion.relatedNeedId ?? ""),
    markdown: text(payload.markdown),
    scores: scoreMap(payload.scores),
    signalIds: signalIds.length > 0 ? signalIds : suggestion.signalIds,
    statement: text(payload.statement),
    summary: text(payload.summary),
    themeDescription: text(payload.themeDescription),
    themeId: text(payload.themeId) || (suggestion.themeId ?? ""),
    themeName: text(payload.themeName),
  };
};

export type Proposal = ReturnType<typeof proposalOf>;

const MIN_STATEMENT = 10;

/**
 * The `edit` body `resolve_suggestion` takes for each kind triage edits (lib/signal/README.md →
 * PM triage), or what is missing. Priority and decision briefs are edited on the need page.
 */
export const buildEdit = (
  kind: SuggestionKind,
  values: Proposal,
): { edit: Record<string, unknown> } | { error: string } => {
  switch (kind) {
    case "draft_need": {
      const statement = values.statement.trim();
      return statement.length >= MIN_STATEMENT
        ? { edit: { statement } }
        : { error: "Write the need statement (at least 10 characters)." };
    }
    case "merge": {
      const intoNeedId = values.intoNeedId.trim();
      return intoNeedId ? { edit: { intoNeedId } } : { error: "Pick the need to merge into." };
    }
    case "theme": {
      if (values.themeId.trim()) return { edit: { themeId: values.themeId.trim() } };
      const themeName = values.themeName.trim();
      if (themeName.length < 2) return { error: "Pick a theme or name a new one." };
      const themeDescription = values.themeDescription.trim();
      return { edit: themeDescription ? { themeDescription, themeName } : { themeName } };
    }
    case "public_summary": {
      const summary = values.summary.trim();
      return summary ? { edit: { summary } } : { error: "Write the public summary." };
    }
    case "split": {
      const statement = values.statement.trim();
      if (statement.length < MIN_STATEMENT)
        return { error: "Write the new need's statement (at least 10 characters)." };
      if (values.signalIds.length === 0) return { error: "Pick at least one signal to move." };
      return { edit: { signalIds: values.signalIds, statement } };
    }
    default: {
      return { error: "Edit this on the need page." };
    }
  }
};

// Needs ---------------------------------------------------------------------------------------

const urgencyRank = { high: 0, low: 2, medium: 1 } as const;

/** The signals to read first: high urgency before medium, low, and none; newest first within. */
export const mostUrgentSignals = <
  T extends { createdAt: string; urgency: "high" | "medium" | "low" | null },
>(
  signals: readonly T[],
  count = 2,
): T[] =>
  signals
    .toSorted((left, right) => {
      const rank =
        (left.urgency ? urgencyRank[left.urgency] : 3) -
        (right.urgency ? urgencyRank[right.urgency] : 3);
      return rank === 0 ? right.createdAt.localeCompare(left.createdAt) : rank;
    })
    .slice(0, count);

/** Each theme once, by name. */
export const themesOf = (needs: readonly { theme: { id: string; name: string } | null }[]) =>
  [...new Map(needs.flatMap((need) => (need.theme ? [[need.theme.id, need.theme]] : []))).values()]
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .map(({ id, name }) => ({ id, name }));

// Formats -------------------------------------------------------------------------------------

/** ARR in compact dollars: $1.38M, $887k, $120. */
export const formatCents = (cents: number) => {
  const dollars = cents / 100;
  if (dollars >= 1_000_000) return `$${Number((dollars / 1_000_000).toFixed(2))}M`;
  if (dollars >= 1000) return `$${Number((dollars / 1000).toFixed(dollars >= 100_000 ? 0 : 1))}k`;
  return `$${Math.round(dollars)}`;
};

export const formatScore = (score: number | null) => (score === null ? "—" : score.toFixed(2));

const DAY_MS = 86_400_000;

/** How long ago, short: today, 1d … 6d, then weeks. */
const startOfDay = (date: Date) =>
  Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

export const relativeAge = (iso: string, now: Date) => {
  const days = Math.round((startOfDay(now) - startOfDay(new Date(iso))) / DAY_MS);
  if (days <= 0) return "today";
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
};

export const formatDate = (iso: string) =>
  new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(iso));

/** Plain-language text for a failed console call. */
export const describeError = (error: Pick<SignalClientError, "code" | "message">) => {
  switch (error.code) {
    case "ai_unavailable": {
      return "AI is unavailable right now. You can still do this by hand.";
    }
    case "conflict": {
      return `This changed since the queue loaded: ${error.message} Reload to see the latest.`;
    }
    case "database_unavailable": {
      return "Signal can't reach its database right now. Nothing was saved; try again shortly.";
    }
    case "network_error": {
      return "Couldn't reach Signal. Check your connection and try again.";
    }
    case "unauthorized": {
      return "Your Operator session has ended. Sign in again on the access page.";
    }
    case "validation_failed": {
      return error.message;
    }
    default: {
      return "Something went wrong. Try again in a moment.";
    }
  }
};
