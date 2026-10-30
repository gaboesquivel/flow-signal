import { createFakeAi, fakeReasoner, tokens } from "@/lib/signal/ai/fakes";
import type { SignalAi } from "@/lib/signal/ai/ports";

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

export const offlineReasoner = () =>
  fakeReasoner({
    decision_brief: ({ prompt }) => ({
      options: [
        { rationale: "Demand is broad.", status: "planned", tradeoffs: "Takes capacity." },
        { rationale: "Demand is narrow.", status: "declined", tradeoffs: "Some disappointment." },
      ],
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
  });

export const createOfflineSignalAi = (): SignalAi => createFakeAi({ reasoner: offlineReasoner() });
