import type { CriterionKey, PublicTextFinding } from "./console";
import { criterionKeys, criterionLabels } from "./console";

/**
 * Pure rules for the need page (spec 006 task 06): the pending priority suggestion and the PM's
 * override, the current decision brief and its recommendation, the Publish gate, and a small
 * reader for the brief's markdown. Browser-safe: no server imports.
 */

export const decisionStatuses = ["planned", "in_progress", "shipped", "declined"] as const;
export type DecisionStatus = (typeof decisionStatuses)[number];

export const decisionStatusLabels: Record<DecisionStatus, string> = {
  declined: "Declined",
  in_progress: "In progress",
  planned: "Planned",
  shipped: "Shipped",
};

const isDecisionStatus = (value: unknown): value is DecisionStatus =>
  typeof value === "string" && (decisionStatuses as readonly string[]).includes(value);

interface SuggestionLike {
  createdAt: string;
  id: string;
  kind: string;
  needId: string | null;
  payload: Record<string, unknown>;
  status: string;
}

const newestFirst = <T extends { createdAt: string }>(items: readonly T[]) =>
  items.toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));

/** The newest pending suggestion of `kind` about this need (not one where it is the target). */
export const pendingOfKind = <T extends SuggestionLike>(
  detail: { id: string; suggestions: readonly T[] },
  kind: string,
): T | undefined =>
  newestFirst(
    detail.suggestions.filter(
      (item) => item.kind === kind && item.status === "pending" && item.needId === detail.id,
    ),
  )[0];

// Priority ------------------------------------------------------------------------------------

/** The AI's score and reason per criterion from a priority suggestion's payload. */
export const priorityProposal = (suggestion: { payload: Record<string, unknown> }) => {
  const { payload } = suggestion;
  const scores = (payload.scores ?? {}) as Record<string, unknown>;
  const reasons = (payload.reasons ?? {}) as Record<string, unknown>;
  const overall = typeof payload.reason === "string" ? payload.reason : "";
  return criterionKeys.map((criterion) => {
    const score = scores[criterion];
    const reason = reasons[criterion];
    return {
      criterion,
      reason: typeof reason === "string" && reason ? reason : overall,
      score: typeof score === "number" ? score : null,
    };
  });
};

export type PriorityOverrideDraft = Partial<Record<CriterionKey, { note: string; score: string }>>;

/**
 * The `resolve_suggestion` edit for a priority override: the PM's score (0–5) and a required
 * note for each criterion they changed, or what is missing.
 */
export const priorityOverride = (
  draft: PriorityOverrideDraft,
):
  | {
      edit: {
        reasons: Partial<Record<CriterionKey, string>>;
        scores: Partial<Record<CriterionKey, number>>;
      };
    }
  | { error: string } => {
  const scores: Partial<Record<CriterionKey, number>> = {};
  const reasons: Partial<Record<CriterionKey, string>> = {};
  for (const criterion of criterionKeys) {
    const entry = draft[criterion];
    if (!entry) continue;
    const label = criterionLabels[criterion];
    const raw = entry.score.trim();
    const score = Number(raw);
    if (!raw || !Number.isFinite(score) || score < 0 || score > 5)
      return { error: `Give a score from 0 to 5 for ${label}.` };
    const note = entry.note.trim();
    if (!note) return { error: `Add a note saying why you changed ${label}.` };
    scores[criterion] = score;
    reasons[criterion] = note;
  }
  if (Object.keys(scores).length === 0) return { error: "Override at least one criterion." };
  return { edit: { reasons, scores } };
};

// Decision brief ------------------------------------------------------------------------------

/**
 * The brief being worked on: the newest `decision_brief` drafted since the latest published
 * decision (any status; the view decides what a rejected one means), or null.
 */
export const currentBrief = <T extends SuggestionLike>(detail: {
  decisions: readonly { publishedAt: string }[];
  id: string;
  suggestions: readonly T[];
}): T | null => {
  const latestDecision = detail.decisions
    .map((decision) => decision.publishedAt)
    .toSorted()
    .at(-1);
  return (
    newestFirst(
      detail.suggestions.filter(
        (item) =>
          item.kind === "decision_brief" &&
          item.needId === detail.id &&
          (!latestDecision || item.createdAt > latestDecision),
      ),
    )[0] ?? null
  );
};

/** "strategyFit" or "strategy_fit" → "Strategy fit". */
export const humanizeKey = (key: string) => {
  const words = key
    .replaceAll(/(?<lower>[a-z0-9])(?<upper>[A-Z])/gu, "$<lower> $<upper>")
    .replaceAll("_", " ")
    .toLowerCase()
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const formatExtra = (value: unknown): string | null => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    const parts = value.map(formatExtra).filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join("; ") : null;
  }
  return JSON.stringify(value);
};

export interface BriefOption {
  rationale: string;
  status: DecisionStatus | null;
  tradeoffs: string;
}

export interface BriefRecommendation {
  /** Fields beyond status, note, and rationale (spec 007 adds confidence, strategy fit, ...). */
  extras: { key: string; label: string; value: string }[];
  note: string;
  rationale: string;
  status: DecisionStatus | null;
}

const str = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * A brief's markdown, options, and recommendation, read defensively: the recommendation is
 * rendered generically so fields added later still show.
 */
export const briefOf = (suggestion: {
  payload: Record<string, unknown>;
}): { markdown: string; options: BriefOption[]; recommendation: BriefRecommendation | null } => {
  const { payload } = suggestion;
  const options: BriefOption[] = Array.isArray(payload.options)
    ? payload.options.flatMap((option) =>
        option && typeof option === "object"
          ? [
              {
                rationale: str((option as Record<string, unknown>).rationale),
                status: isDecisionStatus((option as Record<string, unknown>).status)
                  ? ((option as Record<string, unknown>).status as DecisionStatus)
                  : null,
                tradeoffs: str((option as Record<string, unknown>).tradeoffs),
              },
            ]
          : [],
      )
    : [];
  const raw = payload.recommendation;
  let recommendation: BriefRecommendation | null = null;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const fields = raw as Record<string, unknown>;
    const status = isDecisionStatus(fields.status) ? fields.status : null;
    const matching = options.find((option) => status && option.status === status);
    recommendation = {
      extras: Object.keys(fields)
        .filter((key) => !["note", "rationale", "status"].includes(key))
        .toSorted()
        .flatMap((key) => {
          const value = formatExtra(fields[key]);
          return value === null ? [] : [{ key, label: humanizeKey(key), value }];
        }),
      note: str(fields.note),
      rationale: str(fields.rationale) || matching?.rationale || "",
      status,
    };
  }
  return { markdown: str(payload.markdown), options, recommendation };
};

// Publish -------------------------------------------------------------------------------------

/** Why Publish is unavailable, or null when the note may be published. */
export const publishBlock = ({
  checking,
  failed,
  findings,
  note,
}: {
  checking: boolean;
  failed: boolean;
  findings: readonly PublicTextFinding[] | undefined;
  note: string;
}): string | null => {
  if (!note.trim()) return "Write the public note first.";
  if (failed) return "The note couldn't be checked; try again.";
  if (checking || !findings) return "Checking the note…";
  if (findings.length > 0) return "Remove names, accounts, and emails from the note.";
  return null;
};

// Brief markdown ------------------------------------------------------------------------------

export type BriefBlock =
  | { level: number; text: string; type: "heading" }
  | { items: string[]; type: "list" }
  | { text: string; type: "paragraph" };

/** Headings, bullet lists, and paragraphs: all the brief's markdown uses. */
export const briefBlocks = (markdown: string): BriefBlock[] => {
  const blocks: BriefBlock[] = [];
  for (const line of markdown.split(/\r?\n/u)) {
    const trimmed = line.trim();
    const last = blocks.at(-1);
    const heading = /^(?<hashes>#{1,6})\s+(?<text>.*)$/u.exec(trimmed)?.groups;
    const item = /^[-*]\s+(?<text>.*)$/u.exec(trimmed)?.groups;
    if (!trimmed) {
      blocks.push({ text: "", type: "paragraph" });
    } else if (heading) {
      blocks.push({
        level: heading.hashes?.length ?? 1,
        text: heading.text ?? "",
        type: "heading",
      });
    } else if (item) {
      if (last?.type === "list") last.items.push(item.text ?? "");
      else blocks.push({ items: [item.text ?? ""], type: "list" });
    } else if (last?.type === "paragraph" && last.text) {
      last.text = `${last.text} ${trimmed}`;
    } else {
      blocks.push({ text: trimmed, type: "paragraph" });
    }
  }
  return blocks.filter((block) => block.type !== "paragraph" || block.text);
};

/** Bold (`**x**`) and code (`` `x` ``) spans; everything else is text. */
export const inlineSegments = (text: string) => {
  const segments: { kind: "code" | "strong" | "text"; text: string }[] = [];
  let rest = text;
  while (rest) {
    const match = /\*\*(?<strong>.+?)\*\*|`(?<code>[^`]+)`/u.exec(rest);
    if (!match) {
      segments.push({ kind: "text", text: rest });
      break;
    }
    if (match.index > 0) segments.push({ kind: "text", text: rest.slice(0, match.index) });
    const { code, strong } = match.groups ?? {};
    segments.push(
      strong === undefined ? { kind: "code", text: code ?? "" } : { kind: "strong", text: strong },
    );
    rest = rest.slice(match.index + match[0].length);
  }
  return segments;
};
