import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET, POST } from "../../../app/api/[...path]/route";
import { POST as postOperatorMcp } from "../../../app/api/mcp/operator/route";
import { getNeedDetail } from "../../../lib/signal/operations/get-need-detail";
import { listSuggestions } from "../../../lib/signal/operations/list-suggestions";
import { mergeNeeds } from "../../../lib/signal/operations/merge-needs";
import { resolveSuggestion } from "../../../lib/signal/operations/resolve-suggestion";
import { splitNeed } from "../../../lib/signal/operations/split-need";
import { undoMerge } from "../../../lib/signal/operations/undo-merge";
import { OPERATOR_SECRET } from "../parity/harness";

/** Task 04's operations fail closed without the Operator secret on REST and Operator MCP. */
const triageOperations = [
  listSuggestions,
  resolveSuggestion,
  mergeNeeds,
  undoMerge,
  splitNeed,
  getNeedDetail,
];
const id = "00000000-0000-4000-8000-000000000000";

describe("triage operations without the Operator secret", () => {
  let prior: string | undefined;
  beforeAll(() => {
    prior = process.env.OPERATOR_SECRET;
    process.env.OPERATOR_SECRET = OPERATOR_SECRET;
  });
  afterAll(() => {
    if (prior === undefined) delete process.env.OPERATOR_SECRET;
    else process.env.OPERATOR_SECRET = prior;
  });

  for (const operation of triageOperations) {
    it(`${operation.name} returns unauthorized over REST`, async () => {
      const url = `http://signal.localhost${operation.http.path.replace(":id", id)}`;
      const response =
        operation.http.method === "GET"
          ? await GET(new Request(url))
          : await POST(
              new Request(url, {
                body: "{}",
                headers: { "content-type": "application/json" },
                method: "POST",
              }),
            );
      expect(response.status).toBe(401);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        "unauthorized",
      );
    });
  }

  it("refuses the Operator MCP without the secret", async () => {
    const response = await postOperatorMcp(
      new Request("http://signal.localhost/api/mcp/operator", {
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list", params: {} }),
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );
    expect(response.status).toBe(401);
  });
});
