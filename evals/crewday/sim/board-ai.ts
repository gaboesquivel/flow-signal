import { and, eq, ne, sql } from "drizzle-orm";

import { needs, themes } from "@/lib/db/schema";
import { fakeEmbedding, tokens } from "@/lib/signal/ai/fakes";
import type { SignalAi } from "@/lib/signal/ai/ports";
import type { SignalQueryable } from "@/lib/signal/db";
import { SignalError } from "@/lib/signal/errors";

/**
 * The vote-board arm's AI ports (spec 004 → Arms): what PRODUCT.md calls "a plain vote board",
 * built on Signal's own plumbing so the comparison is fair.
 *
 * - Preview shows `search_needs`-style keyword results for the title: the top 3 live needs by how
 *   many of the title's words appear in their public text (statement, theme, approved summary,
 *   proposed solutions), ties by supporters then age, as search_needs orders. There is no judge:
 *   every result is shown with probability 1 and an empty reason (the board has neither).
 * - No drafting: the extractor returns the title as the statement.
 * - No reasoner, so no suggestions of any kind; the engine also never runs suggestion generation
 *   in this arm.
 *
 * Embeddings are a hashed bag of words (`fakeEmbedding`), used only because `submit_signal`
 * stores one on every new need; nothing in the board ranks by them.
 */

const BOARD_MATCHES = 3;

/** Live needs with the public text a keyword search reads. */
const liveNeedTexts = async (db: SignalQueryable) => {
  const rows = await db
    .select({
      createdAt: needs.createdAt,
      id: needs.id,
      solutions: sql<
        string[]
      >`(select coalesce(array_agg(ps.text), '{}') from proposed_solutions ps where ps.need_id = ${needs.id})`,
      statement: needs.statement,
      summary: sql<
        string | null
      >`case when ${needs.publicSummaryStatus} = 'approved' then ${needs.publicSummary} end`,
      supporters: sql<number>`(select count(distinct s.submitter_id)::int from signals s where s.need_id = ${needs.id})`,
      themeName: themes.name,
    })
    .from(needs)
    .leftJoin(themes, eq(themes.id, needs.themeId))
    .where(and(ne(needs.status, "merged")));
  return rows.map((row) => ({
    createdAt: new Date(row.createdAt).getTime(),
    id: row.id,
    statement: row.statement,
    supporters: Number(row.supporters),
    text: [row.statement, row.themeName ?? "", row.summary ?? "", ...(row.solutions ?? [])]
      .join(" ")
      .toLowerCase(),
  }));
};

export interface KeywordDocument {
  createdAt: number;
  id: string;
  supporters: number;
  /** Lowercased public text. */
  text: string;
}

/**
 * Ranks documents by how many distinct query words (stop words dropped) they contain as
 * substrings, like search_needs' per-word `ilike`, keeping only documents with at least one hit.
 * Ties: more supporters, then newer, then statement order, so the ranking never depends on ids.
 */
export const keywordRank = <D extends KeywordDocument>(query: string, documents: D[]) => {
  const words = [...new Set(tokens(query))];
  if (words.length === 0) return [];
  return documents
    .map((document) => ({
      document,
      hits: words.filter((word) => document.text.includes(word)).length,
    }))
    .filter(({ hits }) => hits > 0)
    .toSorted(
      (a, b) =>
        b.hits - a.hits ||
        b.document.supporters - a.document.supporters ||
        b.document.createdAt - a.document.createdAt ||
        a.document.text.localeCompare(b.document.text),
    )
    .map(({ document, hits }) => ({ document, hits, share: hits / words.length }));
};

/** `previewSubmission` embeds `title\n\nbody`; the board searches the title only. */
const titleOf = (embeddedText: string) => embeddedText.split("\n\n")[0] ?? embeddedText;

const unavailable = () =>
  Promise.reject(new SignalError("ai_unavailable", "The vote board has no reasoning model."));

export const createBoardAi = (): SignalAi => {
  // Preview runs embed → retrieve in sequence; the retriever searches the last embedded title.
  let lastQuery = "";
  return {
    embedder: {
      embed: (texts) => {
        lastQuery = titleOf(texts[0] ?? "");
        return Promise.resolve(texts.map(fakeEmbedding));
      },
      model: "board/keywords",
    },
    extractor: {
      extract: ({ title }) => Promise.resolve({ additionalAsks: [], statement: title.trim() }),
    },
    judge: {
      judge: ({ candidates }) =>
        Promise.resolve(candidates.map(({ needId }) => ({ needId, probability: 1, reason: "" }))),
      model: "board/none",
    },
    reasoner: { generate: unavailable },
    retriever: {
      retrieve: async ({ db }) => {
        const ranked = keywordRank(lastQuery, await liveNeedTexts(db)).slice(0, BOARD_MATCHES);
        return ranked.map(({ document, share }, index) => ({
          needId: document.id,
          // Keeps search order through `chooseMatches`, which breaks equal probabilities by this.
          similarity: share - index * 1e-6,
          statement: document.statement,
        }));
      },
    },
  };
};
