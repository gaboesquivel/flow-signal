import { describe, expect, it } from "vitest";

import { signalClassifierCalls } from "../../../lib/ai/models";
import { fakeDecisionModel } from "../../../lib/signal/ai/fakes";
import { createGatewayAi } from "../../../lib/signal/ai/gateway";
import { JEV_MATCH_THRESHOLD, jevJudge, jevMultiAskDetector } from "../../../lib/signal/ai/jev";

/**
 * The Jev implementations (spec 008) against a fake decision model: no live calls. The default
 * `choice` design asks which candidate is closest plus whether any is the same need; the
 * `per_candidate` design asks one boolean per candidate. Reasons are written in code.
 */

const submission = {
  body: "Our CEO wants the KPI dashboard in the board deck every month.",
  title: "Export dashboards to PDF",
};
const candidates = [
  { needId: "need-a", statement: "Executives need to share dashboard snapshots" },
  { needId: "need-b", statement: "Compliance teams need to archive monthly reports" },
];

const byCandidate = (probabilities: Record<string, number>) =>
  fakeDecisionModel((id) => ({ probability: probabilities[id] ?? 0, type: "boolean" }));

const choice = (anySame: number, which: Record<string, number>) =>
  fakeDecisionModel((id, question) => {
    if (id === "any_same") return { probability: anySame, type: "boolean" };
    const names = Object.keys(question.type === "choice" ? question.criteria : {});
    return {
      choice: names[0] ?? "",
      probabilities: Object.fromEntries(
        names.map((name) => [name, which[name] ?? 1 / names.length]),
      ),
      type: "choice",
    };
  });

describe("jevJudge (choice design, the default)", () => {
  it("gives each candidate P(any same) × P(chosen), options named by statement", async () => {
    const model = choice(0.9, { [candidates[0]!.statement]: 0.8, [candidates[1]!.statement]: 0.2 });
    const judge = jevJudge({ model });
    const judgements = await judge.judge({ candidates, submission });
    expect(judgements.map(({ needId, probability }) => [needId, probability])).toEqual([
      ["need-a", expect.closeTo(0.72)],
      ["need-b", expect.closeTo(0.18)],
    ]);
    expect(judge.threshold).toBe(JEV_MATCH_THRESHOLD);
    const [call] = model.calls;
    expect(Object.keys(call?.questions ?? {})).toEqual(["any_same", "which"]);
    expect(call?.questions.which).toMatchObject({
      criteria: { [candidates[0]!.statement]: null, [candidates[1]!.statement]: null },
      type: "choice",
    });
    expect(JSON.stringify(call?.state)).toContain("Export dashboards to PDF");
  });

  it("keeps option names unique when two candidates share a statement", async () => {
    const twins = [candidates[0]!, { ...candidates[0]!, needId: "need-c" }];
    const model = choice(1, {});
    await jevJudge({ model }).judge({ candidates: twins, submission });
    const question = model.calls[0]?.questions.which;
    expect(Object.keys(question?.type === "choice" ? question.criteria : {})).toHaveLength(2);
  });
});

describe("jevJudge (per_candidate design)", () => {
  it("asks one boolean question per candidate, naming its statement, over the request", async () => {
    const model = byCandidate({ candidate_1: 0.91, candidate_2: 0.04 });
    const judge = jevJudge({ design: "per_candidate", model });
    const judgements = await judge.judge({ candidates, submission });
    expect(judge.threshold).toBeUndefined();
    expect(judgements.map(({ needId, probability }) => ({ needId, probability }))).toEqual([
      { needId: "need-a", probability: 0.91 },
      { needId: "need-b", probability: 0.04 },
    ]);
    const [call] = model.calls;
    expect(Object.keys(call?.questions ?? {})).toEqual(["candidate_1", "candidate_2"]);
    expect(call?.questions.candidate_1).toMatchObject({ type: "boolean" });
    expect(JSON.stringify(call?.questions.candidate_1)).toContain(candidates[0]?.statement);
    expect(JSON.stringify(call?.state)).toContain("Export dashboards to PDF");
    expect(JSON.stringify(call?.state)).not.toContain("drafted_need");
  });

  it("writes a short reason from the probability", async () => {
    const [same, different] = await jevJudge({
      design: "per_candidate",
      model: byCandidate({ candidate_1: 0.9, candidate_2: 0.1 }),
    }).judge({ candidates, submission });
    expect(same?.reason).toMatch(/same/iu);
    expect(different?.reason).toMatch(/different/iu);
  });

  it("adds the drafted statement to the state when given", async () => {
    const model = byCandidate({});
    await jevJudge({ design: "per_candidate", model }).judge({
      candidates,
      draft: { additionalAsks: [], statement: "Executives need dashboards in board decks" },
      submission,
    });
    expect(JSON.stringify(model.calls[0]?.state)).toContain(
      "Executives need dashboards in board decks",
    );
  });

  it("treats a refusal as unavailable (decide returns no partial answers)", async () => {
    const model = fakeDecisionModel((id) =>
      id === "candidate_1" ? { type: "refusal" } : { probability: 0.2, type: "boolean" },
    );
    await expect(jevJudge({ model }).judge({ candidates, submission })).rejects.toMatchObject({
      code: "ai_unavailable",
    });
  });

  it("makes no call without candidates", async () => {
    const empty = byCandidate({});
    await expect(jevJudge({ model: empty }).judge({ candidates: [], submission })).resolves.toEqual(
      [],
    );
    expect(empty.calls).toHaveLength(0);
  });

  it("reports ai_unavailable when the decision model fails", async () => {
    const model = fakeDecisionModel(() => {
      throw new Error("gateway down");
    });
    await expect(jevJudge({ model }).judge({ candidates, submission })).rejects.toMatchObject({
      code: "ai_unavailable",
    });
  });
});

describe("jevMultiAskDetector", () => {
  it("returns P(the request asks for more than one separate thing)", async () => {
    const model = fakeDecisionModel(() => ({ probability: 0.8, type: "boolean" }));
    await expect(jevMultiAskDetector({ model }).detect(submission)).resolves.toBe(0.8);
    expect(Object.keys(model.calls[0]?.questions ?? {})).toEqual(["multiple_asks"]);
  });
});

describe("classifier switch", () => {
  it("routes a call to the classifier only when listed", () => {
    expect(
      signalClassifierCalls({ SIGNAL_CLASSIFIER_CALLS: "match_judge" }).has("match_judge"),
    ).toBe(true);
    expect(signalClassifierCalls({ SIGNAL_CLASSIFIER_CALLS: "none" }).size).toBe(0);
    expect(signalClassifierCalls({ SIGNAL_CLASSIFIER_CALLS: " bogus , match_judge " })).toEqual(
      new Set(["match_judge"]),
    );
  });

  it("puts the match judge on Jev by default (it won the spec 008 eval)", () => {
    expect(signalClassifierCalls({})).toEqual(new Set(["match_judge"]));
  });

  it("builds the match judge from the switch", () => {
    expect(createGatewayAi({ SIGNAL_CLASSIFIER_CALLS: "match_judge" }).judge.model).toBe(
      "typesafe-ai/jev",
    );
    expect(createGatewayAi({ SIGNAL_CLASSIFIER_CALLS: "none" }).judge.model).toBe(
      "anthropic/claude-haiku-5.5",
    );
  });
});
