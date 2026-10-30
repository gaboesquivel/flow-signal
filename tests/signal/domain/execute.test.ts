import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { SignalError } from "../../../lib/signal/errors";
import { executeOperation } from "../../../lib/signal/operations/execute";
import { defineOperation } from "../../../lib/signal/operations/types";

const human = { kind: "human" as const, ref: "web" };

const probe = (run: () => Promise<unknown>, errors: ("not_found" | "conflict")[] = ["not_found"]) =>
  defineOperation({
    access: "public",
    description: "Test-only operation for the shared execution path.",
    errors,
    http: { method: "GET", path: "/api/probe" },
    input: z.object({ n: z.coerce.number().int().optional() }),
    name: "probe",
    output: z.object({ at: z.string(), n: z.number() }),
    run: run as never,
  });

const withFakeDatabase = () => {
  process.env.DATABASE_URL = "postgres://user:pass@db.invalid/signal";
};

describe("executeOperation", () => {
  const prior = process.env.DATABASE_URL;
  afterEach(() => {
    if (prior === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prior;
  });

  it("validates input before anything else", async () => {
    delete process.env.DATABASE_URL;
    const result = await executeOperation(
      probe(() => Promise.resolve({})),
      { n: "x" },
      human,
    );
    expect(result).toMatchObject({
      error: { code: "validation_failed", retryable: false },
      ok: false,
    });
  });

  it("returns database_unavailable without DATABASE_URL", async () => {
    delete process.env.DATABASE_URL;
    const result = await executeOperation(
      probe(() => Promise.resolve({})),
      {},
      human,
    );
    expect(result).toMatchObject({
      error: { code: "database_unavailable", retryable: true },
      ok: false,
    });
  });

  it("returns declared SignalErrors as the envelope", async () => {
    withFakeDatabase();
    const result = await executeOperation(
      probe(() => Promise.reject(new SignalError("not_found", "gone"))),
      {},
      human,
    );
    expect(result).toEqual({
      error: { code: "not_found", message: "gone", retryable: false },
      ok: false,
    });
  });

  it("refuses undeclared error codes", async () => {
    withFakeDatabase();
    await expect(
      executeOperation(
        probe(() => Promise.reject(new SignalError("conflict", "no"))),
        {},
        human,
      ),
    ).rejects.toThrow(/undeclared error code conflict/u);
  });

  it("maps unreachable-database errors to database_unavailable", async () => {
    withFakeDatabase();
    const error = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const result = await executeOperation(
      probe(() => Promise.reject(new Error("query failed", { cause: error }))),
      {},
      human,
    );
    expect(result).toMatchObject({ error: { code: "database_unavailable" }, ok: false });
  });

  it("parses the output and returns plain JSON", async () => {
    withFakeDatabase();
    const result = await executeOperation(
      probe(() => Promise.resolve({ at: "2026-01-01T00:00:00.000Z", extra: 1, n: 2 })),
      { n: "2" },
      human,
    );
    expect(result).toEqual({ data: { at: "2026-01-01T00:00:00.000Z", n: 2 }, ok: true });
  });
});
