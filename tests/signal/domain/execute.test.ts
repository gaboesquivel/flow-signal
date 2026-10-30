import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("hides unexpected errors behind a generic internal envelope and logs one sanitized line", async () => {
    withFakeDatabase();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // What drizzle throws for a failed statement: the SQL and its params (PII) in the message.
      const cause = Object.assign(new Error("duplicate key value violates unique constraint"), {
        code: "23505",
      });
      class DrizzleQueryError extends Error {
        constructor(message: string, options: ErrorOptions) {
          super(message, options);
          this.name = "DrizzleQueryError";
        }
      }
      const error = new DrizzleQueryError(
        'Failed query: insert into "submitters" ("email", "name") values ($1, $2)\nparams: maya@acme.example,Maya Lin',
        { cause },
      );
      const result = await executeOperation(
        probe(() => Promise.reject(error)),
        {},
        human,
      );
      expect(result).toEqual({
        error: { code: "internal", message: "Something went wrong.", retryable: true },
        ok: false,
      });
      expect(log).toHaveBeenCalledTimes(1);
      const line = log.mock.calls[0]!.map(String).join(" ");
      expect(line).toContain("probe");
      expect(line).toContain("DrizzleQueryError");
      expect(line).toContain("23505");
      expect(line).not.toMatch(/maya|Failed query|insert into|params/iu);
    } finally {
      log.mockRestore();
    }
  });

  it("returns internal when the output does not match the contract", async () => {
    withFakeDatabase();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await executeOperation(
        probe(() => Promise.resolve({ at: "x", n: "maya@acme.example" })),
        {},
        human,
      );
      expect(result).toMatchObject({ error: { code: "internal" }, ok: false });
      expect(log.mock.calls.flat().map(String).join(" ")).not.toContain("maya");
    } finally {
      log.mockRestore();
    }
  });

  it("maps a statement timeout (SQLSTATE 57014) to database_unavailable", async () => {
    withFakeDatabase();
    const cause = Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014",
    });
    const result = await executeOperation(
      probe(() => Promise.reject(new Error("Failed query: select 1", { cause }))),
      {},
      human,
    );
    expect(result).toMatchObject({
      error: { code: "database_unavailable", retryable: true },
      ok: false,
    });
  });
});
