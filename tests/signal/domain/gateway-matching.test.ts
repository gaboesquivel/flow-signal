import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { gatewayExtractor, gatewayJudge } from "../../../lib/signal/ai/gateway";

/**
 * The AI SDK extractor and judge (decision 0002) against a mock language model: no live calls.
 * The structured output is parsed with zod and mapped back onto the domain types.
 */

const reply = (value: unknown) =>
  new MockLanguageModelV4({
    doGenerate: {
      content: [{ text: JSON.stringify(value), type: "text" }],
      finishReason: { raw: "stop", unified: "stop" },
      usage: {
        inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 10, total: 10 },
        outputTokens: { reasoning: 0, text: 10, total: 10 },
      },
      warnings: [],
    },
  });

const failing = () =>
  new MockLanguageModelV4({
    doGenerate: () => Promise.reject(new Error("gateway down")),
  });

const promptText = (model: MockLanguageModelV4) => JSON.stringify(model.doGenerateCalls[0]?.prompt);

const submission = {
  body: "Our CEO wants the KPI dashboard in the board deck every month. Also SSO please.",
  title: "Export dashboards to PDF",
};

describe("gatewayExtractor", () => {
  it("returns the drafted need, a named solution, and additional asks", async () => {
    const model = reply({
      additionalAsks: ["Admins need SSO so that access is managed centrally"],
      proposedSolution: "PDF export",
      statement: "Executives need to share dashboards so that board decks use current numbers",
    });
    await expect(gatewayExtractor({ model }).extract(submission)).resolves.toEqual({
      additionalAsks: ["Admins need SSO so that access is managed centrally"],
      proposedSolution: "PDF export",
      statement: "Executives need to share dashboards so that board decks use current numbers",
    });
    expect(promptText(model)).toContain("Export dashboards to PDF");
  });

  it("omits an empty proposed solution", async () => {
    const model = reply({ additionalAsks: [], proposedSolution: null, statement: "S" });
    await expect(gatewayExtractor({ model }).extract(submission)).resolves.toEqual({
      additionalAsks: [],
      statement: "S",
    });
  });

  it("reports ai_unavailable when the model call fails or returns junk", async () => {
    await expect(gatewayExtractor({ model: failing() }).extract(submission)).rejects.toMatchObject({
      code: "ai_unavailable",
    });
    await expect(
      gatewayExtractor({ model: reply({ nope: true }) }).extract(submission),
    ).rejects.toMatchObject({ code: "ai_unavailable" });
  });
});

describe("gatewayJudge", () => {
  const candidates = [
    { needId: "need-a", statement: "Executives need to share dashboard snapshots" },
    { needId: "need-b", statement: "Compliance teams need to archive monthly reports" },
  ];
  const draft = { additionalAsks: [], statement: "Executives need dashboards in board decks" };

  it("maps verdicts back to candidates by number, clamped, unknown ones dropped", async () => {
    const model = reply({
      verdicts: [
        { candidate: 2, probability: 0.1, reason: "Archiving, not sharing." },
        { candidate: 1, probability: 1.4, reason: "Same need: sharing with executives." },
        { candidate: 7, probability: 0.9, reason: "Hallucinated." },
      ],
    });
    const judge = gatewayJudge({ model });
    await expect(judge.judge({ candidates, draft, submission })).resolves.toEqual([
      { needId: "need-b", probability: 0.1, reason: "Archiving, not sharing." },
      { needId: "need-a", probability: 1, reason: "Same need: sharing with executives." },
    ]);
    const prompt = promptText(model);
    expect(prompt).toContain("Compliance teams need to archive monthly reports");
    expect(prompt).not.toContain("need-a");
  });

  it("judges nothing without candidates and needs no model call", async () => {
    const model = failing();
    await expect(
      gatewayJudge({ model }).judge({ candidates: [], draft, submission }),
    ).resolves.toEqual([]);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("reports ai_unavailable when the model call fails", async () => {
    await expect(
      gatewayJudge({ model: failing() }).judge({ candidates, draft, submission }),
    ).rejects.toMatchObject({ code: "ai_unavailable" });
  });
});
