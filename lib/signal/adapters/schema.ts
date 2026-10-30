import type { z } from "zod";

/**
 * A Standard Schema that advertises the operation's JSON Schema but accepts any value, so
 * MCP and Eve list the real input shape while `executeOperation` does the validation and
 * returns the same `validation_failed` envelope on every surface.
 */
export const passthroughSchema = (schema: z.ZodObject) => ({
  "~standard": {
    jsonSchema: {
      input: (options: { target: string }) =>
        schema["~standard"].jsonSchema.input(options as never),
      output: (options: { target: string }) =>
        schema["~standard"].jsonSchema.output(options as never),
    },
    validate: (value: unknown) => ({ value: value ?? {} }),
    vendor: "signal",
    version: 1 as const,
  },
});

/** The JSON Schema every surface advertises for an operation's input. */
export const inputJsonSchema = (schema: z.ZodObject) =>
  schema["~standard"].jsonSchema.input({ target: "draft-2020-12" }) as Record<string, unknown>;
