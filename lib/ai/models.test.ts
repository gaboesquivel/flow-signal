import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CHAT_MODEL,
  DEFAULT_GENUI_MODEL,
  DEFAULT_SIGNAL_DECISION_MODEL,
  DEFAULT_SIGNAL_EMBEDDING_MODEL,
  DEFAULT_SIGNAL_FAST_MODEL,
  DEFAULT_SIGNAL_REASONING_MODEL,
  anthropicByokOptions,
  directModelId,
  gatewayAvailable,
  signalDecisionModelId,
  signalEmbeddingModelId,
  signalFastModelId,
  signalReasoningModelId,
} from "./models";

const gatewayTypes = () => {
  const entry = createRequire(import.meta.url).resolve("@ai-sdk/gateway");
  return readFileSync(path.join(path.dirname(entry), "index.d.ts"), "utf-8");
};

describe("model defaults", () => {
  it("names models the installed AI Gateway lists", () => {
    const types = gatewayTypes();
    for (const id of [
      DEFAULT_CHAT_MODEL,
      DEFAULT_GENUI_MODEL,
      DEFAULT_SIGNAL_FAST_MODEL,
      DEFAULT_SIGNAL_REASONING_MODEL,
      DEFAULT_SIGNAL_DECISION_MODEL,
      DEFAULT_SIGNAL_EMBEDDING_MODEL,
    ])
      expect(types, id).toContain(`'${id}'`);
  });

  it("uses the Signal models spec 001 names, overridable by env", () => {
    expect(DEFAULT_SIGNAL_FAST_MODEL).toBe("anthropic/claude-haiku-5.5");
    expect(DEFAULT_SIGNAL_REASONING_MODEL).toBe("anthropic/claude-sonnet-5.5");
    expect(DEFAULT_SIGNAL_EMBEDDING_MODEL).toBe("openai/text-embedding-3-small");
    expect(signalFastModelId({})).toBe(DEFAULT_SIGNAL_FAST_MODEL);
    expect(signalFastModelId({ SIGNAL_FAST_MODEL: "x/fast" })).toBe("x/fast");
    expect(signalReasoningModelId({ SIGNAL_REASONING_MODEL: " x/reason " })).toBe("x/reason");
    expect(signalEmbeddingModelId({ SIGNAL_EMBEDDING_MODEL: "" })).toBe(
      DEFAULT_SIGNAL_EMBEDDING_MODEL,
    );
  });

  it("uses Claude Fable 5.1 for decision tasks (0006), overridable by env", () => {
    expect(DEFAULT_SIGNAL_DECISION_MODEL).toBe("anthropic/claude-fable-5.1");
    expect(signalDecisionModelId({})).toBe(DEFAULT_SIGNAL_DECISION_MODEL);
    expect(signalDecisionModelId({ SIGNAL_DECISION_MODEL: " anthropic/claude-sonnet-5.5 " })).toBe(
      "anthropic/claude-sonnet-5.5",
    );
  });

  it("maps gateway ids to direct Anthropic ids", () => {
    expect(directModelId("anthropic/claude-sonnet-5.5")).toBe("claude-sonnet-5-5");
  });
});

describe("anthropicByokOptions", () => {
  it("sends the trimmed Anthropic key as Gateway BYOK only when it is set", () => {
    expect(anthropicByokOptions({})).toEqual({});
    expect(anthropicByokOptions({ ANTHROPIC_API_KEY: "  " })).toEqual({});
    expect(anthropicByokOptions({ ANTHROPIC_API_KEY: " sk-ant-test " })).toEqual({
      gateway: { byok: { anthropic: [{ apiKey: "sk-ant-test" }] } },
    });
  });

  it("adds the workspace header to the BYOK credential when ANTHROPIC_WORKSPACE_ID is set", () => {
    expect(anthropicByokOptions({ ANTHROPIC_WORKSPACE_ID: "wrkspc_1" })).toEqual({});
    expect(
      anthropicByokOptions({
        ANTHROPIC_API_KEY: "sk-ant-test",
        ANTHROPIC_WORKSPACE_ID: " wrkspc_1 ",
      }),
    ).toEqual({
      gateway: {
        byok: {
          anthropic: [{ apiKey: "sk-ant-test", headers: { "anthropic-workspace-id": "wrkspc_1" } }],
        },
      },
    });
  });
});

describe("gatewayAvailable", () => {
  it("is on with a key or on Vercel, off otherwise", () => {
    expect(gatewayAvailable({})).toBe(false);
    expect(gatewayAvailable({ AI_GATEWAY_API_KEY: " " })).toBe(false);
    expect(gatewayAvailable({ AI_GATEWAY_API_KEY: "k" })).toBe(true);
    expect(gatewayAvailable({ VERCEL: "1" })).toBe(true);
    // Local Vercel OIDC from `vercel env pull`, with an empty key beside it.
    expect(gatewayAvailable({ AI_GATEWAY_API_KEY: "", VERCEL_OIDC_TOKEN: "t" })).toBe(true);
    expect(gatewayAvailable({ VERCEL_OIDC_TOKEN: " " })).toBe(false);
  });
});
