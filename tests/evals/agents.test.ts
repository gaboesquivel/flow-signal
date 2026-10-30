import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  called,
  calledBefore,
  lacksTools,
  notCalled,
  onlyAvailableTools,
  repliesOmit,
  text,
} from "@/evals/agents/checks";
import { scriptedModel, scriptPosition } from "@/evals/agents/fake-model";
import type { Fixture } from "@/evals/agents/fixture";
import { loadAgent, runConversation, toolJsonSchema } from "@/evals/agents/harness";
import type { LoadedAgent, ToolCallRecord, Transcript } from "@/evals/agents/harness";
import { OPERATOR_TOOLS, scenarios, selectScenarios } from "@/evals/agents/scenarios";
import { operations } from "@/lib/signal/operations/registry";

// Offline: the agent-eval harness logic (checks, scenario selection, the conversation runner
// with a scripted model). The live run is `pnpm eval:agents` (never `pnpm test` or CI).

const targetOf = (item: ToolCallRecord) => text(item.input, "target", "needId");

const call = (name: string, input: unknown = {}, extra: Partial<ToolCallRecord> = {}) =>
  ({ available: true, input, ms: 1, name, turn: 0, ...extra }) satisfies ToolCallRecord;

const transcript = (toolCalls: ToolCallRecord[], reply = "ok", availableTools: string[] = []) =>
  ({
    agent: "assistant",
    availableTools,
    modelId: "test",
    toolCalls,
    turns: [{ ms: 1, steps: 1, text: reply, user: "hi" }],
  }) satisfies Transcript;

describe("checks", () => {
  test("called matches successful calls and a predicate on the input", () => {
    const run = transcript([
      call("submit_signal", { target: { needId: "n2" } }, { errorCode: "conflict" }),
      call("submit_signal", { target: { needId: "n1" } }),
    ]);
    expect(called(run, "submit_signal").pass).toBe(true);
    expect(called(run, "submit_signal", { where: (item) => targetOf(item) === "n1" }).pass).toBe(
      true,
    );
    const failed = called(run, "submit_signal", {
      where: (item) => targetOf(item) === "n2",
    });
    expect(failed.pass).toBe(false);
    expect(failed.detail).toContain("conflict");
    expect(
      called(run, "submit_signal", {
        allowError: true,
        where: (item) => targetOf(item) === "n2",
      }).pass,
    ).toBe(true);
    expect(called(run, "preview_signal").detail).toContain("no preview_signal call");
  });

  test("calledBefore compares the first successful calls", () => {
    expect(
      calledBefore(
        transcript([call("preview_signal"), call("submit_signal")]),
        "preview_signal",
        "submit_signal",
      ).pass,
    ).toBe(true);
    expect(
      calledBefore(
        transcript([call("submit_signal"), call("preview_signal")]),
        "preview_signal",
        "submit_signal",
      ).pass,
    ).toBe(false);
    expect(
      calledBefore(transcript([call("preview_signal")]), "preview_signal", "submit_signal").pass,
    ).toBe(false);
  });

  test("notCalled, onlyAvailableTools, and lacksTools flag out-of-scope tools", () => {
    const run = transcript(
      [
        call("search_needs"),
        call("merge_needs", {}, { available: false, errorCode: "no_such_tool" }),
      ],
      "ok",
      ["search_needs", "submit_signal"],
    );
    expect(notCalled(run, "merge_needs").pass).toBe(false);
    expect(notCalled(run, "publish_decision").pass).toBe(true);
    expect(onlyAvailableTools(run).pass).toBe(false);
    expect(lacksTools(run, ["merge_needs"]).pass).toBe(true);
    expect(lacksTools(transcript([], "ok", ["merge_needs"]), ["merge_needs"]).pass).toBe(false);
  });

  test("repliesOmit is case-insensitive and names what leaked", () => {
    const run = transcript([], "Supporters include Beverly from ACME and bob@globex.example.");
    const result = repliesOmit(run, "no PII", ["acme", "bob@globex.example", "Initech"]);
    expect(result.pass).toBe(false);
    expect(result.detail).toBe("reply mentions acme, bob@globex.example");
    expect(repliesOmit(run, "no PII", ["Initech"]).pass).toBe(true);
  });
});

const scenarioById = (id: string) => {
  const found = scenarios.find((item) => item.id === id);
  if (!found) throw new Error(id);
  return found;
};

/** Checks of scenarios that read no database state, so an empty fixture is enough. */
const passes = async (id: string, run: Transcript) => {
  const results = await scenarioById(id).check(run, {} as Fixture);
  return results.every((item) => item.pass);
};

describe("scenarios", () => {
  test("ids are unique and cover both agents with 10–15 scenarios", () => {
    const ids = scenarios.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(10);
    expect(ids.length).toBeLessThanOrEqual(15);
    for (const scenario of scenarios)
      expect(scenario.id.startsWith(`${scenario.agent}/`)).toBe(true);
  });

  test("OPERATOR_TOOLS is every operator operation in the registry", () => {
    expect(OPERATOR_TOOLS.toSorted()).toEqual(
      operations
        .filter((item) => item.access === "operator")
        .map((item) => item.name)
        .toSorted(),
    );
    expect(OPERATOR_TOOLS).toContain("publish_decision");
  });

  test("selectScenarios filters by id or prefix", () => {
    expect(selectScenarios(scenarios)).toHaveLength(scenarios.length);
    expect(selectScenarios(scenarios, "operator/").every((item) => item.agent === "operator")).toBe(
      true,
    );
    expect(
      selectScenarios(scenarios, "operator/triage-queue, assistant/declines-merge").map(
        (item) => item.id,
      ),
    ).toEqual(["assistant/declines-merge", "operator/triage-queue"]);
    expect(selectScenarios(scenarios, "nope")).toEqual([]);
  });

  test("operator read scenarios pass on the right read and fail on an unrequested write", async () => {
    const good = transcript([call("get_demand_summary")], "Enterprise accounts ask for sharing.");
    expect(await passes("operator/enterprise-blockers", good)).toBe(true);
    expect(
      await passes(
        "operator/enterprise-blockers",
        transcript([...good.toolCalls, call("publish_decision")]),
      ),
    ).toBe(false);
    expect(await passes("operator/enterprise-blockers", transcript([call("search_needs")]))).toBe(
      false,
    );
    expect(await passes("operator/triage-queue", transcript([call("list_suggestions")]))).toBe(
      true,
    );
    expect(
      await passes(
        "operator/triage-queue",
        transcript([call("list_suggestions"), call("resolve_suggestion")]),
      ),
    ).toBe(false);
    expect(await passes("operator/duplicates-this-month", transcript([call("get_metrics")]))).toBe(
      true,
    );
  });
});

describe("harness", () => {
  test("toolJsonSchema drops $schema from a Standard Schema's JSON Schema", () => {
    expect(toolJsonSchema(z.object({ q: z.string() }))).toEqual({
      properties: { q: { type: "string" } },
      required: ["q"],
      type: "object",
    });
  });

  test("scriptPosition counts user turns and assistant steps since the last user message", () => {
    expect(scriptPosition([{ role: "system" }, { role: "user" }])).toEqual({ step: 0, turn: 0 });
    expect(
      scriptPosition([
        { role: "user" },
        { role: "assistant" },
        { role: "tool" },
        { role: "assistant" },
        { role: "user" },
        { role: "assistant" },
        { role: "tool" },
      ]),
    ).toEqual({ step: 1, turn: 1 });
  });

  test("runConversation records calls, unknown tools, and stops follow-ups once `until` holds", async () => {
    const seen: unknown[] = [];
    const agent: LoadedAgent = {
      instructions: "Be helpful.",
      modelId: "test",
      name: "assistant",
      tools: {
        echo: {
          description: "Echo",
          execute: (input) => {
            seen.push(input);
            return { echoed: input };
          },
          inputSchema: z.object({ say: z.string() }),
        },
        fail: {
          execute: () => ({ error: { code: "not_found" } }),
          inputSchema: z.object({}),
        },
      },
    };
    const run = await runConversation({
      agent,
      followUps: ["again", "never sent"],
      model: scriptedModel([
        [
          {
            calls: [
              { input: {}, name: "merge_needs" },
              { input: {}, name: "fail" },
            ],
          },
          { text: "Shall I echo?" },
        ],
        [{ calls: [{ input: { say: "hi" }, name: "echo" }] }, { text: "Echoed." }],
      ]),
      prompt: "start",
      sessionId: "test",
      until: (current) => current.toolCalls.some((item) => item.name === "echo"),
    });
    expect(run.turns.map((turn) => [turn.user, turn.text])).toEqual([
      ["start", "Shall I echo?"],
      ["again", "Echoed."],
    ]);
    expect(seen).toEqual([{ say: "hi" }]);
    expect(
      run.toolCalls.map((item) => [item.name, item.turn, item.available, item.errorCode]),
    ).toEqual([
      ["fail", 0, true, "not_found"],
      ["merge_needs", 0, false, "no_such_tool"],
      ["echo", 1, true, undefined],
    ]);
    expect(run.availableTools).toEqual(["echo", "fail"]);
  });

  test("loadAgent wires the Assistant with public Signal tools only, the Operator with all", async () => {
    const assistant = await loadAgent("assistant");
    const operator = await loadAgent("operator");
    expect(assistant.instructions).toContain("## Signal");
    expect(Object.keys(assistant.tools)).toEqual(
      expect.arrayContaining(["preview_signal", "submit_signal"]),
    );
    expect(Object.keys(assistant.tools).filter((name) => OPERATOR_TOOLS.includes(name))).toEqual(
      [],
    );
    expect(Object.keys(operator.tools)).toEqual(
      expect.arrayContaining([...OPERATOR_TOOLS, "submit_signal"]),
    );
    expect(toolJsonSchema(operator.tools.publish_decision?.inputSchema)).toMatchObject({
      required: ["id", "note", "status"],
    });
  });
});
