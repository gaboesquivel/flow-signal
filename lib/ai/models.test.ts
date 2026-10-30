import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_CHAT_MODEL, DEFAULT_GENUI_MODEL, directModelId, gatewayAvailable } from "./models";

const gatewayTypes = () => {
  const entry = createRequire(import.meta.url).resolve("@ai-sdk/gateway");
  return readFileSync(path.join(path.dirname(entry), "index.d.ts"), "utf-8");
};

describe("model defaults", () => {
  it("names models the installed AI Gateway lists", () => {
    const types = gatewayTypes();
    for (const id of [DEFAULT_CHAT_MODEL, DEFAULT_GENUI_MODEL])
      expect(types, id).toContain(`'${id}'`);
  });

  it("maps gateway ids to direct Anthropic ids", () => {
    expect(directModelId("anthropic/claude-sonnet-5.5")).toBe("claude-sonnet-5-5");
  });
});

describe("gatewayAvailable", () => {
  it("is on with a key or on Vercel, off otherwise", () => {
    expect(gatewayAvailable({})).toBe(false);
    expect(gatewayAvailable({ AI_GATEWAY_API_KEY: " " })).toBe(false);
    expect(gatewayAvailable({ AI_GATEWAY_API_KEY: "k" })).toBe(true);
    expect(gatewayAvailable({ VERCEL: "1" })).toBe(true);
  });
});
