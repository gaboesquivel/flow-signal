import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { reasoningModelReasoner } from "../../../lib/signal/ai/reasoning-model";

/** The task-agnostic reasoning-model Reasoner against a mock model: no live calls. */

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
