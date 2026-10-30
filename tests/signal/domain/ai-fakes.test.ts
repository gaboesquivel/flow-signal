import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { EMBEDDING_DIMENSIONS } from "../../../lib/db/schema";
import {
  createFakeAi,
  createUnavailableAi,
  fakeEmbedding,
  fakeReasoner,
} from "../../../lib/signal/ai/fakes";
import { createGatewayAi } from "../../../lib/signal/ai/gateway";

const cosine = (a: number[], b: number[]) =>
  a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);

describe("AI fakes", () => {
  it("embed deterministically at the schema's dimension, closer for shared words", () => {
    const pdf = fakeEmbedding("Export dashboards to PDF for the board");
    expect(pdf).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(fakeEmbedding("Export dashboards to PDF for the board")).toEqual(pdf);
    expect(
      cosine(pdf, fakeEmbedding("Executives share dashboard PDF with the board")),
    ).toBeGreaterThan(cosine(pdf, fakeEmbedding("Single sign-on with Okta")));
  });

  it("judge candidates by overlap unless a judgement is fixed", async () => {
    const ai = createFakeAi();
    const draft = { additionalAsks: [], statement: "Executives share dashboard snapshots" };
    const [match, other] = await ai.judge.judge({
      candidates: [
        { needId: "a", statement: "Executives need to share dashboard snapshots" },
        { needId: "b", statement: "Admins need SSO" },
      ],
      draft,
      submission: { body: "", title: "" },
    });
    expect(match!.probability).toBeGreaterThan(0.6);
    expect(other!.probability).toBe(0);
  });

  it("answer reasoner tasks from handlers and validate with the caller's schema", async () => {
    const reasoner = fakeReasoner({ public_summary: () => ({ summary: "Teams share KPIs." }) });
    await expect(
      reasoner.generate({
        prompt: "p",
        schema: z.object({ summary: z.string() }),
        task: "public_summary",
      }),
    ).resolves.toEqual({ model: "fake/reasoner", value: { summary: "Teams share KPIs." } });
    await expect(
      reasoner.generate({ prompt: "p", schema: z.object({}), task: "theme" }),
    ).rejects.toMatchObject({ code: "ai_unavailable" });
  });

  it("can simulate AI being unavailable", async () => {
    await expect(
      createUnavailableAi().extractor.extract({ body: "", title: "" }),
    ).rejects.toMatchObject({
      code: "ai_unavailable",
    });
  });
});

describe("gateway AI without Gateway access", () => {
  const prior = { key: process.env.AI_GATEWAY_API_KEY, vercel: process.env.VERCEL };
  afterEach(() => {
    if (prior.key === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = prior.key;
    if (prior.vercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = prior.vercel;
  });

  it("reports ai_unavailable instead of calling a model", async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL;
    const ai = createGatewayAi();
    await expect(ai.embedder.embed(["x"])).rejects.toMatchObject({ code: "ai_unavailable" });
    await expect(ai.extractor.extract({ body: "", title: "" })).rejects.toMatchObject({
      code: "ai_unavailable",
    });
  });
});
