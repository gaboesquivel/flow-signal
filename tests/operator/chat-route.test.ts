import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  answerOperatorQuestion,
  buildOperatorChatTools,
  operatorChatSystem,
} from "../../app/api/operator/chat/answer";
import { POST } from "../../app/api/operator/chat/route";
import { operations } from "../../lib/signal/operations/registry";

/** Console chat (spec 006 task 07): the Operator agent answering with read operations. */

const N1 = "11111111-1111-4111-8111-111111111111";
const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 10, total: 10 },
  outputTokens: { reasoning: 0, text: 10, total: 10 },
};

describe("operator chat tools", () => {
  it("offers only read operations, including get_demand_summary with its plan filter", () => {
    const tools = buildOperatorChatTools(() => {});
    const names = Object.keys(tools);
    expect(names).toContain("get_demand_summary");
    expect(names).toContain("list_operator_needs");
    const writes = operations.filter((operation) => operation.effects === "write");
    expect(writes.length).toBeGreaterThan(0);
    for (const operation of writes) expect(names).not.toContain(operation.name);
    expect(names).not.toContain("submit_signal");
    expect(JSON.stringify(tools.get_demand_summary?.inputSchema)).toContain("Enterprise");
  });

  it("tells the agent to use the plan filter and link needs by id", async () => {
    const system = await operatorChatSystem();
    expect(system).toContain("# Operator agent");
    expect(system).toMatch(/get_demand_summary\*\* with `plan`/u);
    expect(system).toContain("(need:<needId>)");
  });
});

describe("answerOperatorQuestion", () => {
  it("runs the agent's tool calls and cites the needs its answer links", async () => {
    const calls: { input: unknown; name: string }[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            {
              input: JSON.stringify({ plan: "Enterprise" }),
              toolCallId: "call-1",
              toolName: "get_demand_summary",
              type: "tool-call",
            },
          ],
          finishReason: { raw: "tool_calls", unified: "tool-calls" },
          usage,
          warnings: [],
        },
        {
          content: [
            {
              text: `Enterprise accounts wait on [dashboard snapshots](need:${N1}).`,
              type: "text",
            },
          ],
          finishReason: { raw: "stop", unified: "stop" },
          usage,
          warnings: [],
        },
      ],
    });
    const answer = await answerOperatorQuestion({
      messages: [{ content: "What are enterprise accounts blocked on?", role: "user" }],
      model,
      run: (operation, input) => {
        calls.push({ input, name: operation.name });
        return Promise.resolve({
          data: {
            needs: [
              {
                accounts: [{ accountId: N1, name: "Acme", plan: "Enterprise" }],
                needId: N1,
                statement: "Executives need to share dashboard snapshots",
                status: "open",
                supporters: 11,
              },
            ],
          },
          ok: true,
        });
      },
    });
    expect(calls).toEqual([{ input: { plan: "Enterprise" }, name: "get_demand_summary" }]);
    expect(answer.sources).toEqual(calls);
    expect(answer.cited).toEqual([
      {
        accounts: ["Acme"],
        id: N1,
        people: 11,
        statement: "Executives need to share dashboard snapshots",
        status: "open",
      },
    ]);
  });
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request("http://signal.localhost/api/operator/chat", {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", ...headers },
      method: "POST",
    }),
  );

describe("POST /api/operator/chat", () => {
  const previous = process.env.OPERATOR_SECRET;
  const secret = "chat-route-test-secret-0123456789";
  beforeEach(() => {
    process.env.OPERATOR_SECRET = secret;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.OPERATOR_SECRET;
    else process.env.OPERATOR_SECRET = previous;
  });

  it("refuses a request without Operator access", async () => {
    const response = await post({ messages: [{ content: "hi", role: "user" }] });
    expect(response.status).toBe(401);
  });

  it("rejects a conversation that does not end with the user's question", async () => {
    const previousKey = process.env.AI_GATEWAY_API_KEY;
    process.env.AI_GATEWAY_API_KEY = "test-key-never-called";
    try {
      const response = await post(
        { messages: [{ content: "hi", role: "assistant" }] },
        { Authorization: `Bearer ${secret}` },
      );
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("invalid_request");
    } finally {
      if (previousKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
      else process.env.AI_GATEWAY_API_KEY = previousKey;
    }
  });
});
