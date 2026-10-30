import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { DEFAULT_SIGNAL_DECISION_MODEL } from "../../../lib/ai/models";
import {
  byokFailure,
  DECISION_TASKS,
  reasoningModelReasoner,
} from "../../../lib/signal/ai/reasoning-model";

/** Gateway provider metadata with one model attempt made of `attempts`. */
const routing = (attempts: unknown[]) => ({
  gateway: { routing: { modelAttempts: [{ providerAttempts: attempts }] } },
});

/** The task-agnostic reasoning-model Reasoner against a mock model: no live calls. */

const reply = (value: unknown, response?: { modelId: string }) =>
  new MockLanguageModelV4({
    doGenerate: {
      content: [{ text: JSON.stringify(value), type: "text" }],
      finishReason: { raw: "stop", unified: "stop" },
      ...(response ? { response } : {}),
      usage: {
        inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 10, total: 10 },
        outputTokens: { reasoning: 0, text: 10, total: 10 },
      },
      warnings: [],
    },
  });

const schema = z.object({ text: z.string() });

describe("reasoningModelReasoner", () => {
  it("returns the structured value and the reasoning model id", async () => {
    const model = reply({ text: "Demand is rising." });
    const result = await reasoningModelReasoner({ model }).generate({
      prompt: "Summarize this demand.",
      schema,
      system: "You summarize.",
      task: "demand_summary",
    });
    expect(result.value).toEqual({ text: "Demand is rising." });
    expect(result.model).toMatch(/\//u);
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain("Summarize this demand.");
  });

  it("reports ai_unavailable for a failed call or output that fails the schema", async () => {
    const failing = new MockLanguageModelV4({
      doGenerate: () => Promise.reject(new Error("gateway down")),
    });
    for (const model of [failing, reply({ wrong: true })])
      await expect(
        reasoningModelReasoner({ model }).generate({ prompt: "x", schema, task: "priority" }),
      ).rejects.toMatchObject({ code: "ai_unavailable" });
  });
});

const brief = (model: MockLanguageModelV4, modelId?: string) =>
  reasoningModelReasoner({ model, ...(modelId ? { modelId } : {}) }).generate({
    prompt: "Draft a brief.",
    schema,
    task: "decision_brief",
  });

describe("reasoningModelReasoner decision tasks (spec 007, decision 0006)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("only decision_brief is a decision task", () => {
    expect([...DECISION_TASKS]).toEqual(["decision_brief"]);
  });

  it("sends effort and the refusal fallback, never disabled thinking, and BYOK only with the key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const withoutKey = reply({ text: "Plan it." });
    await brief(withoutKey);
    expect(withoutKey.doGenerateCalls[0]?.providerOptions).toEqual({
      anthropic: { effort: "medium", fallbacks: "default" },
    });

    vi.stubEnv("ANTHROPIC_API_KEY", " sk-ant-test ");
    const withKey = reply({ text: "Plan it." });
    await brief(withKey);
    const sent = withKey.doGenerateCalls[0]?.providerOptions;
    expect(sent).toEqual({
      anthropic: { effort: "medium", fallbacks: "default" },
      gateway: { byok: { anthropic: [{ apiKey: "sk-ant-test" }] } },
    });
    expect(JSON.stringify(sent)).not.toContain("disabled");
  });

  it("reports a failed BYOK attempt from the Gateway's routing metadata", () => {
    expect(byokFailure(undefined)).toBeUndefined();
    expect(byokFailure(routing([{ credentialType: "byok", success: true }]))).toBeUndefined();
    expect(
      byokFailure(
        routing([
          { credentialType: "byok", error: "needs anthropic-workspace-id", success: false },
          { credentialType: "system", success: true },
        ]),
      ),
    ).toBe("needs anthropic-workspace-id");
  });

  it("records the responding model so a fallback is visible, else the decision model id", async () => {
    vi.stubEnv("SIGNAL_DECISION_MODEL", "");
    const fallback = reply({ text: "Plan it." }, { modelId: "anthropic/claude-sonnet-5.5" });
    expect((await brief(fallback, DEFAULT_SIGNAL_DECISION_MODEL)).model).toBe(
      "anthropic/claude-sonnet-5.5",
    );
    const answered = reply({ text: "Plan it." }, { modelId: "" });
    expect((await brief(answered)).model).toBe(DEFAULT_SIGNAL_DECISION_MODEL);
  });

  it("leaves other tasks unchanged: no provider options, reasoning model id", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("SIGNAL_REASONING_MODEL", "anthropic/claude-sonnet-5.5");
    const model = reply({ text: "Scored." }, { modelId: "something-else" });
    const result = await reasoningModelReasoner({ model }).generate({
      prompt: "Score.",
      schema,
      task: "priority",
    });
    expect(result.model).toBe("anthropic/claude-sonnet-5.5");
    expect(model.doGenerateCalls[0]?.providerOptions).toBeUndefined();
  });
});
