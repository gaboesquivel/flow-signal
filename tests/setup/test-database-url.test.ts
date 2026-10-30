import { describe, expect, it } from "vitest";

import { perWorktreeTestUrl } from "./test-database-url";

const shared = "postgres://postgres:postgres@localhost:5432/signal_test";

describe("perWorktreeTestUrl", () => {
  it("suffixes the shared test database in a linked worktree", () => {
    expect(perWorktreeTestUrl(shared, "/code/flow-signal-tooling", true)).toBe(
      "postgres://postgres:postgres@localhost:5432/signal_test_flow_signal_tooling",
    );
  });

  it("keeps the main checkout and explicit names", () => {
    expect(perWorktreeTestUrl(shared, "/code/flow-signal", false)).toBe(shared);
    const custom = "postgres://postgres:postgres@localhost:5432/signal_test_mine";
    expect(perWorktreeTestUrl(custom, "/code/flow-signal-tooling", true)).toBe(custom);
  });
});
