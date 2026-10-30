import { createFakeAi, fakeReasoner, tokens } from "@/lib/signal/ai/fakes";
import type { ReasonerTask, SignalAi } from "@/lib/signal/ai/ports";

import type { World } from "../format";

/**
 * Deterministic Signal-arm AI for offline runs (`pnpm test`): the `lib/signal/ai/fakes.ts`
 * extractor, embedder, judge, and pgvector retriever, plus a reasoner that answers every task
 * suggestion generation and decision briefs use, from word overlap in the prompt. It is crude on
 * purpose; it only has to exercise every suggestion kind so the policies and scorer run end to
 * end. Live runs (task 04) inject the Gateway instead.
 */

const quoted = (text: string, label: string) => {
  const match = new RegExp(`${label}: (?<json>"(?:[^"\\\\]|\\\\.)*")`, "u").exec(text);
  const json = match?.groups?.json;
  if (!json) return "";
  try {
    return JSON.parse(json) as string;
  } catch {
    return "";
  }
};

const overlap = (left: string, right: string) => {
  const a = new Set(tokens(left));
  const b = new Set(tokens(right));
  const shared = [...a].filter((token) => b.has(token)).length;
  return shared / Math.max(1, Math.min(a.size, b.size));
};

/** The numbered lines ("1. ...") of a prompt section. */
const numbered = (text: string) =>
  [...text.matchAll(/^(?<n>\d+)\. (?<line>.+)$/gmu)].map((match) => ({
    line: match.groups?.line ?? "",
    n: Number(match.groups?.n),
  }));

/** The best-overlapping numbered line at or above `min`, or null. */
const bestLine = (subject: string, text: string, min: number) => {
  let best: { n: number; score: number } | null = null;
  for (const { line, n } of numbered(text)) {
    const score = overlap(subject, line);
    if (score >= min && (!best || score > best.score)) best = { n, score };
  }
  return best?.n ?? null;
};

const clampScore = (value: number) => Math.max(0, Math.min(5, Math.round(value * 10) / 10));

/** The `value` group of `pattern` in `text`, as a number (0 when absent). */
const number = (text: string, pattern: RegExp) => Number(pattern.exec(text)?.groups?.value ?? 0);

type Handler = (input: { prompt: string; system?: string }) => unknown;

const BRIEF_OPTIONS = [
  { rationale: "Demand is broad.", status: "planned", tradeoffs: "Takes capacity." },
  { rationale: "Demand is narrow.", status: "declined", tradeoffs: "Some disappointment." },
];

const offlineReasoner = (overrides: Partial<Record<ReasonerTask, Handler>> = {}) =>
  fakeReasoner({
    decision_brief: ({ prompt }) => ({
      options: BRIEF_OPTIONS,
      recommendation: {
        note: "Thanks for telling us how this affects your work; here is our decision.",
        status: number(prompt, /Supporters: (?<value>\d+)/u) >= 2 ? "planned" : "declined",
      },
      summary: "Several teams ask for this.",
    }),
    draft_need: ({ prompt }) => ({
      reason: "The submission describes a problem no existing need covers.",
      statement: quoted(prompt, "Drafted need") || quoted(prompt, "Submission title"),
    }),
    merge: ({ prompt }) => {
      const draft = quoted(prompt, "New draft need");
      const section = prompt.split("Existing needs:")[1] ?? "";
      const candidate = bestLine(draft, section, 0.5);
      return {
        candidate,
        reason: candidate ? "Both describe the same problem." : "No existing need matches.",
      };
    },
    priority: ({ prompt }) => {
      const supporters = number(prompt, /Supporters: (?<value>\d+)/u);
      const weight = number(prompt, /strategic weight (?<value>[\d.]+)/u);
      const reason = "From the need's facts.";
      return {
        business_value: { reason, score: clampScore(1 + (prompt.match(/ARR \$/gu)?.length ?? 0)) },
        demand: { reason, score: clampScore(supporters) },
        effort: { reason, score: 3 },
        strategic_fit: { reason, score: clampScore(weight * 5) },
        summary: "Scored from supporters, accounts, and theme weight.",
      };
    },
    public_summary: ({ prompt }) => ({
      reason: "Anonymized from the need.",
      summary: `People need this because: ${quoted(prompt, "Need")}`.slice(0, 400),
    }),
    split: () => ({ reason: "Every signal asks for the same need.", split: null }),
    theme: ({ prompt }) => {
      const need = quoted(prompt, "Need");
      const section = prompt.split("Themes:")[1] ?? "";
      return {
        newThemeName: null,
        reason: "Closest theme by wording.",
        theme: bestLine(need, section, 0) ?? (numbered(section).length ? 1 : null),
      };
    },
    ...overrides,
  });

/**
 * Spec 007 bounds for `follows_signal`: a `decision_brief` fake that recommends the status
 * Crewday's strategy implies for the need (`"strategy"`), or the opposite (`"opposite"`). It reads
 * the need's statement from the prompt and finds its true need by statement: a backlog row, a
 * world need, or the statement the offline extractor drafts from a signal (title: body); else the
 * statement with the most shared words.
 */
export const strategyBriefHandler = (world: World, mode: "strategy" | "opposite"): Handler => {
  const byStatement = new Map<string, string>();
  for (const need of world.needs) byStatement.set(need.statement, need.key);
  for (const row of world.backlog)
    byStatement.set(
      row.body.trim() ? `${row.title.trim()}: ${row.body.trim()}` : row.title,
      row.trueNeedKey,
    );
  for (const signal of world.signals) {
    const [main] = signal.labels.needKeys;
    if (main) byStatement.set(`${signal.title.trim()}: ${signal.body.trim()}`.slice(0, 280), main);
  }
  const keyOf = (statement: string) => {
    const exact = byStatement.get(statement);
    if (exact) return exact;
    let best: { key: string; score: number } | null = null;
    for (const [text, key] of byStatement) {
      const score = overlap(statement, text);
      if (!best || score > best.score) best = { key, score };
    }
    return best?.key;
  };
  const needs = new Map(world.needs.map((need) => [need.key, need]));
  return ({ prompt }) => {
    const key = keyOf(quoted(prompt, "Need"));
    const truth = (key && needs.get(key)?.strategyDecision.status) || "declined";
    const opposite = truth === "planned" ? "declined" : "planned";
    const status = mode === "strategy" ? truth : opposite;
    return {
      options: BRIEF_OPTIONS,
      recommendation: { note: "Thanks for telling us how this affects your work.", status },
      summary: "Several teams ask for this.",
    };
  };
};

interface OfflineAiOptions {
  /** Replaces the offline `decision_brief` fake (e.g. `strategyBriefHandler`). */
  decisionBrief?: Handler;
}

export const createOfflineSignalAi = (options: OfflineAiOptions = {}): SignalAi =>
  createFakeAi({
    reasoner: offlineReasoner(
      options.decisionBrief ? { decision_brief: options.decisionBrief } : {},
    ),
  });
