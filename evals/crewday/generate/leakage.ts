import { isCounted } from "../checks";
import type { Need, Theme, WorldSignal } from "../format";
import { keywordRank } from "../sim/board-ai";
import type { KeywordDocument } from "../sim/board-ai";

/**
 * The leakage check (spec 004 → The worlds, generation step 3). For every counted signal whose
 * true need already existed, rank the needs that existed at that moment by the vote board's
 * keyword retriever (`keywordRank`) on the signal's title and body. A signal is keyword-findable
 * when its true need ranks first (for a split child not yet raised, its parent). The world's
 * `keywordFindableShare` is the findable share of those signals; the ceiling is 0.6.
 */

export const KEYWORD_FINDABLE_CEILING = 0.6;

interface NeedDocument extends KeywordDocument {
  key: string;
}

interface Findability {
  /** Signal id → whether its true need ranked first, and its share of query words hit there. */
  bySignal: Map<string, { findable: boolean; trueShare: number }>;
  considered: number;
  findable: number;
  share: number;
}

export const needText = (need: Need, themes: Theme[]) =>
  [
    need.statement,
    themes.find((theme) => theme.key === need.themeKey)?.name ?? "",
    ...need.solutions,
  ]
    .join(" ")
    .toLowerCase();

export const keywordFindability = (world: {
  needs: Need[];
  signals: WorldSignal[];
  themes: Theme[];
}): Findability => {
  const { needs, signals, themes } = world;
  const parentOf = new Map(
    needs.flatMap((need) => (need.splitInto ?? []).map((child) => [child, need.key] as const)),
  );
  const docs = new Map<string, NeedDocument>();
  const add = (need: Need, createdAt: number) => {
    if (!docs.has(need.key)) {
      docs.set(need.key, {
        createdAt,
        id: need.key,
        key: need.key,
        supporters: 0,
        text: needText(need, themes),
      });
    }
  };
  for (const need of needs) if (need.inBacklog) add(need, 0);
  const bySignal = new Map<string, { findable: boolean; trueShare: number }>();
  let considered = 0;
  let findable = 0;
  for (const signal of signals) {
    if (!isCounted(signal)) continue;
    const [main] = signal.labels.needKeys;
    if (signal.labels.existedAtTime && main) {
      const target = docs.has(main) ? main : (parentOf.get(main) ?? main);
      const ranked = keywordRank(`${signal.title}\n\n${signal.body}`, [...docs.values()]);
      const hit = ranked[0]?.document.key === target;
      const trueShare = ranked.find((entry) => entry.document.key === target)?.share ?? 0;
      bySignal.set(signal.id, { findable: hit, trueShare });
      considered += 1;
      if (hit) findable += 1;
    }
    const time = Date.parse(signal.at);
    for (const key of signal.labels.needKeys) {
      const need = needs.find((n) => n.key === key);
      if (need) add(need, time);
      const doc = docs.get(key);
      if (doc) doc.supporters += 1;
    }
  }
  return { bySignal, considered, findable, share: considered ? findable / considered : 0 };
};
