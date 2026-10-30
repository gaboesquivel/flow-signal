import { describe, expect, it } from "vitest";

import { isDatabaseUnavailable } from "../lib/signal/errors";

/** Spec 001 → Exposure: an unreachable database is `database_unavailable`, not a 500. */
describe("isDatabaseUnavailable", () => {
  it("recognizes a failed WebSocket connection from the Neon driver (an error Event cause)", () => {
    // What drizzle throws when the Neon Pool's WebSocket cannot connect (seen with an unresolvable host).
    const error = new Error("Failed query: select 1", { cause: new Event("error") });
    expect(isDatabaseUnavailable(error)).toBe(true);
  });

  it("recognizes network error codes and leaves query bugs alone", () => {
    expect(
      isDatabaseUnavailable(Object.assign(new Error("connect"), { code: "ECONNREFUSED" })),
    ).toBe(true);
    expect(isDatabaseUnavailable(Object.assign(new Error("syntax error"), { code: "42601" }))).toBe(
      false,
    );
    expect(isDatabaseUnavailable(new Error("Failed query", { cause: new Event("message") }))).toBe(
      false,
    );
  });
});
