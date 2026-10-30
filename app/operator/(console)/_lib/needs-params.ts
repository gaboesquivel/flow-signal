import { createLoader, createParser, parseAsString, parseAsStringLiteral } from "nuqs/server";

/**
 * The Needs table's URL state (spec 006 → PM console): search, theme, status, and sort. Shared
 * by the server page (which calls `list_operator_needs` with them) and the client filters.
 * Values the API would reject parse as unset, so a hand-edited URL never errors.
 */

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

const parseAsUuid = createParser({
  parse: (value: string) => (UUID.test(value) ? value : null),
  serialize: (value: string) => value,
});

export const needsSorts = ["priority", "people", "accounts", "arr"] as const;
export const needsStatuses = [
  "draft",
  "open",
  "planned",
  "in_progress",
  "shipped",
  "declined",
] as const;

export const needsParsers = {
  q: parseAsString.withDefault(""),
  sort: parseAsStringLiteral(needsSorts).withDefault("priority"),
  status: parseAsStringLiteral(needsStatuses),
  theme: parseAsUuid,
};

export const loadNeedsSearchParams = createLoader(needsParsers);
