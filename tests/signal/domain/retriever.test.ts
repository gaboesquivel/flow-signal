import { expect, it } from "vitest";

import { fakeEmbedding } from "../../../lib/signal/ai/fakes";
import { pgvectorRetriever } from "../../../lib/signal/ai/gateway";
import { insertNeed } from "../support/builders";
import { describeWithDatabase, useTestDatabase } from "../support/database";

const statement = (text: string) => ({ embedding: fakeEmbedding(text), statement: text });

describeWithDatabase("pgvectorRetriever", () => {
  const harness = useTestDatabase();

  it("returns the nearest live needs by cosine similarity, never merged ones", async () => {
    const share = await insertNeed(
      harness.db,
      statement("Executives need to share dashboard snapshots with the board"),
    );
    const archive = await insertNeed(
      harness.db,
      statement("Compliance teams need to archive monthly reports for audits"),
    );
    await insertNeed(harness.db, {
      ...statement("Executives need dashboard snapshots for the board"),
      status: "merged",
    });
    await insertNeed(harness.db, { statement: "No embedding yet" });

    const results = await pgvectorRetriever.retrieve({
      db: harness.db,
      embedding: fakeEmbedding("Share dashboard snapshots with executives"),
      limit: 8,
    });

    expect(results.map((result) => result.needId)).toEqual([share.need.id, archive.need.id]);
    expect(results[0]!.similarity).toBeGreaterThan(results[1]!.similarity);
  });
});
