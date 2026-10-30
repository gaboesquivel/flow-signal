import { z } from "zod";

import { errorCodes, errorEnvelopeSchema, errorStatus } from "../errors";
import { publicOperations } from "../operations/registry";
import { implicitErrors } from "./../operations/types";
import type { AnyOperation } from "./../operations/types";
import { inputJsonSchema } from "./schema";

/**
 * OpenAPI paths and MCP tool schemas generated from the registry. Public discovery lists
 * `access: "public"` operations only; pass other operations explicitly for private docs.
 */

const stripDialect = (schema: Record<string, unknown>) => {
  const { $schema: _dialect, ...rest } = schema;
  return rest;
};

const outputJsonSchema = (schema: z.ZodType) =>
  stripDialect(
    z.toJSONSchema(schema, { io: "output", target: "draft-2020-12" }) as Record<string, unknown>,
  );

const openApiPath = (path: string) => path.replaceAll(/:(?<name>[a-zA-Z]+)/gu, "{$<name>}");

const pathParams = (path: string) =>
  [...path.matchAll(/:(?<name>[a-zA-Z]+)/gu)].map((match) => match.groups?.name ?? "");

const camel = (name: string) =>
  name.replaceAll(/_(?<letter>[a-z])/gu, (_match, letter: string) => letter.toUpperCase());

const operationObject = (operation: AnyOperation) => {
  const input = stripDialect(inputJsonSchema(operation.input)) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  const params = pathParams(operation.http.path);
  const properties = Object.entries(input.properties ?? {});
  const required = new Set(input.required);
  const parameters = [
    ...params.map((name) => ({
      in: "path",
      name,
      required: true,
      schema: input.properties?.[name] ?? { type: "string" },
    })),
    ...(operation.http.method === "GET"
      ? properties
          .filter(([name]) => !params.includes(name))
          .map(([name, schema]) => ({ in: "query", name, required: required.has(name), schema }))
      : []),
  ];
  const bodyProperties = Object.fromEntries(properties.filter(([name]) => !params.includes(name)));
  const errors = [...new Set([...operation.errors, ...implicitErrors(operation.access)])];
  return {
    description: operation.description,
    operationId: camel(operation.name),
    parameters,
    ...(operation.http.method === "GET"
      ? {}
      : {
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  ...input,
                  properties: bodyProperties,
                  required: (input.required ?? []).filter((name) => !params.includes(name)),
                },
              },
            },
            required: true,
          },
        }),
    responses: {
      "200": {
        content: { "application/json": { schema: outputJsonSchema(operation.output) } },
        description: "Success",
      },
      ...Object.fromEntries(
        [...new Set(errors.map((code) => errorStatus[code]))].map((status) => [
          String(status),
          {
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/SignalError" } },
            },
            description: errors.filter((code) => errorStatus[code] === status).join(", "),
          },
        ]),
      ),
    },
    summary: operation.description.split(". ")[0],
    tags: ["signal"],
    "x-mcp-tool": operation.name,
  };
};

export const signalOpenApiPaths = (ops: readonly AnyOperation[] = publicOperations) => {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of ops) {
    const path = openApiPath(operation.http.path);
    paths[path] = {
      ...paths[path],
      [operation.http.method.toLowerCase()]: operationObject(operation),
    };
  }
  return paths;
};

export const signalOpenApiSchemas = (ops: readonly AnyOperation[] = publicOperations) => ({
  SignalError: {
    ...stripDialect(z.toJSONSchema(errorEnvelopeSchema) as Record<string, unknown>),
    description: `Signal error envelope. Codes: ${errorCodes.join(", ")}.`,
  },
  ...Object.fromEntries(
    ops.map((operation) => [
      `McpTool_${operation.name}`,
      {
        ...stripDialect(inputJsonSchema(operation.input)),
        description: operation.description,
        "x-mcp-tool": operation.name,
      },
    ]),
  ),
});
