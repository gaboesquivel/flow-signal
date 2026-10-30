import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { gatewayReasoner } from "../../../lib/signal/ai/gateway";

/** The AI SDK reasoner (structured output on the reasoning model) against a mock model. */

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

const schema = z.object({ reason: z.string(), summary: z.string() });

describe("gatewayReasoner", () => {
  it("returns the schema-validated value and the model id", async () => {
    const model = reply({ reason: "r", summary: "s" });
    const result = await gatewayReasoner({ model, modelId: "test/reasoner" }).generate({
      prompt: "Use cases: ...",
      schema,
      system: "Summarize.",
      task: "public_summary",
    });
    expect(result).toEqual({ model: "test/reasoner", value: { reason: "r", summary: "s" } });
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain("Use cases");
  });

  it("reports ai_unavailable when the model fails or returns junk", async () => {
    const failing = new MockLanguageModelV4({
      doGenerate: () => Promise.reject(new Error("gateway down")),
    });
    await expect(
      gatewayReasoner({ model: failing }).generate({ prompt: "p", schema, task: "theme" }),
    ).rejects.toMatchObject({ code: "ai_unavailable" });
    await expect(
      gatewayReasoner({ model: reply({ nope: 1 }) }).generate({
        prompt: "p",
        schema,
        task: "theme",
      }),
    ).rejects.toMatchObject({ code: "ai_unavailable" });
  });

  it("reports ai_unavailable without Gateway access", async () => {
    const prior = { key: process.env.AI_GATEWAY_API_KEY, vercel: process.env.VERCEL };
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL;
    try {
      await expect(
        gatewayReasoner().generate({ prompt: "p", schema, task: "theme" }),
      ).rejects.toMatchObject({ code: "ai_unavailable" });
    } finally {
      if (prior.key !== undefined) process.env.AI_GATEWAY_API_KEY = prior.key;
      if (prior.vercel !== undefined) process.env.VERCEL = prior.vercel;
    }
  });
});
