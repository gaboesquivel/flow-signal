import type {
  Embedder,
  MatchJudge,
  NeedCandidate,
  NeedExtractor,
  NeedRetriever,
} from "@/lib/signal/ai/ports";
import type { SignalQueryable } from "@/lib/signal/db";
import { CANDIDATE_LIMIT } from "@/lib/signal/domain/matching";

import type { CatalogNeed, LabeledSubmission } from "./dataset";
import type { CaseRun } from "./metrics";

/**
 * Runs the preview hot path (extract → embed → retrieve → judge, as in
 * `lib/signal/domain/matching.ts`) over the labeled set through the AI ports, and records every
 * judgement instead of filtering at a threshold, so the sweep is computed offline. Retrieval is
 * an in-memory cosine index over the fixture catalog (needIds are catalog keys), which ranks the
 * same way as the pgvector retriever without a database.
 */

interface MatchingPorts {
  embedder: Embedder;
  extractor: NeedExtractor;
  judge: MatchJudge;
  /** Optional multi-ask classifier (spec 008), run alongside extraction; recorded, not used. */
  multiAsk?: { detect: (submission: { body: string; title: string }) => Promise<number> };
}

interface PipelineOptions {
  /** Wait for extraction and pass the drafted need to the judge (spec 008 variant; serial). */
  judgeWithDraft?: boolean;
}

interface IndexedNeed {
  embedding: number[];
  needId: string;
  statement: string;
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
};

const inMemoryRetriever = (index: IndexedNeed[]): NeedRetriever => ({
  retrieve: ({ embedding, limit }) =>
    Promise.resolve(
      index
        .map(({ embedding: need, needId, statement }): NeedCandidate => ({
          needId,
          similarity: cosine(embedding, need),
          statement,
        }))
        .toSorted((a, b) => b.similarity - a.similarity)
        .slice(0, limit),
    ),
});

export const indexCatalog = async (catalog: CatalogNeed[], embedder: Embedder) => {
  const embeddings = await embedder.embed(catalog.map((need) => need.statement));
  return catalog.map((need, position) => {
    const embedding = embeddings[position];
    if (!embedding) throw new Error(`No embedding returned for catalog need ${need.key}.`);
    return { embedding, needId: need.key, statement: need.statement };
  });
};

/** The in-memory retriever ignores the database argument the port requires. */
const noDatabase = undefined as unknown as SignalQueryable;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const runCase = async (
  ports: MatchingPorts,
  retriever: NeedRetriever,
  submission: LabeledSubmission,
  { judgeWithDraft = false }: PipelineOptions = {},
  now: () => number = performance.now.bind(performance),
): Promise<CaseRun> => {
  const base = {
    additionalAsks: [] as string[],
    candidates: [] as CaseRun["candidates"],
    caseId: submission.id,
    expected: submission.expected,
    judgements: [] as CaseRun["judgements"],
    kind: submission.kind,
  };
  const input = { body: submission.body, title: submission.title };
  const started = now();
  let draftStatement: string | undefined;
  try {
    // Same flow as `previewSubmission` (lib/signal/domain/matching.ts): extraction runs alongside
    // embed → retrieve → judge on the submission text, so latency is one fast-model call.
    const steps: NonNullable<CaseRun["steps"]> = {};
    const settleExtraction = async () => {
      try {
        const draft = await ports.extractor.extract(input);
        steps.extractMs = now() - started;
        return { draft, ok: true as const };
      } catch (error) {
        return { error, ok: false as const };
      }
    };
    const extraction = settleExtraction();
    // A failed probe is left out of the multi-ask diagnostic.
    const probeMultiAsk = async (): Promise<number | undefined> => {
      try {
        return await ports.multiAsk?.detect(input);
      } catch {
        return Number.NaN;
      }
    };
    const multiAsk = probeMultiAsk();
    const embedStarted = now();
    const [embedding] = await ports.embedder.embed([`${input.title}\n\n${input.body}`]);
    steps.embedMs = now() - embedStarted;
    if (!embedding) throw new Error("The embedder returned no embedding.");
    const candidates = await retriever.retrieve({
      db: noDatabase,
      embedding,
      limit: CANDIDATE_LIMIT,
    });
    const extracted = judgeWithDraft ? await extraction : undefined;
    if (extracted && !extracted.ok) throw extracted.error;
    const judgeStarted = now();
    const judgements =
      candidates.length === 0
        ? []
        : await ports.judge.judge({
            candidates: candidates.map(({ needId, statement }) => ({ needId, statement })),
            ...(extracted?.ok ? { draft: extracted.draft } : {}),
            submission: input,
          });
    if (candidates.length > 0) steps.judgeMs = now() - judgeStarted;
    const settled = await extraction;
    if (!settled.ok) throw settled.error;
    const { draft } = settled;
    draftStatement = draft.statement;
    const probed = await multiAsk;
    const multiAskProbability = Number.isNaN(probed) ? undefined : probed;
    return {
      ...base,
      additionalAsks: draft.additionalAsks,
      candidates: candidates.map(({ needId, similarity }) => ({ needId, similarity })),
      draftStatement,
      judgements: judgements.map(({ needId, probability, reason }) => ({
        needId,
        probability,
        reason,
      })),
      latencyMs: now() - started,
      ...(multiAskProbability === undefined ? {} : { multiAskProbability }),
      steps,
    };
  } catch (error) {
    return {
      ...base,
      ...(draftStatement === undefined ? {} : { draftStatement }),
      error: message(error),
      latencyMs: now() - started,
    };
  }
};

/** Runs `task` over `items` with at most `concurrency` in flight, keeping input order. */
export const mapLimit = async <T, R>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
) => {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    if (next >= items.length) return;
    const index = next;
    next += 1;
    results[index] = await task(items[index] as T, index);
    return worker();
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker),
  );
  return results;
};

/** Pass `index` (from `indexCatalog`) to embed the catalog outside the measured phase. */
export const runPipeline = async ({
  catalog,
  concurrency = 4,
  index,
  onCase,
  options,
  ports,
  submissions,
}: {
  catalog: CatalogNeed[];
  concurrency?: number;
  index?: IndexedNeed[];
  onCase?: (run: CaseRun) => void;
  options?: PipelineOptions;
  ports: MatchingPorts;
  submissions: LabeledSubmission[];
}) => {
  const retriever = inMemoryRetriever(index ?? (await indexCatalog(catalog, ports.embedder)));
  return mapLimit(submissions, concurrency, async (submission) => {
    const run = await runCase(ports, retriever, submission, options);
    onCase?.(run);
    return run;
  });
};
