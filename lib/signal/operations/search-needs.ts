import { z } from "zod";

import {
  livePublicNeedStatuses,
  publicNeedSchema,
  searchPublicNeeds,
} from "../domain/public-needs";
import { defineOperation } from "./types";

/** Cursors are opaque to clients: base64url JSON of the next offset. */
export const encodeCursor = (offset: number) =>
  Buffer.from(JSON.stringify({ o: offset })).toString("base64url");

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const decodeCursor = (cursor: string) => {
  const parsed = parseJson(Buffer.from(cursor, "base64url").toString("utf-8"));
  const offset = (parsed as { o?: unknown } | null)?.o;
  return typeof offset === "number" && Number.isInteger(offset) && offset >= 0 ? offset : undefined;
};

const searchNeedsInput = z.object({
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor: z
    .string()
    .max(200)
    .refine((cursor) => decodeCursor(cursor) !== undefined, "Invalid cursor.")
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** Words to find in need statements, proposed solutions, themes, and approved summaries. */
  q: z.string().trim().max(200).optional(),
  status: z.enum(livePublicNeedStatuses).optional(),
  /** Theme id or theme name. */
  theme: z.string().trim().max(120).optional(),
});

const searchNeedsOutput = z.object({
  needs: z.array(publicNeedSchema),
  nextCursor: z.string().nullable(),
});

export const searchNeeds = defineOperation({
  access: "public",
  description:
    "Search and browse public needs (the underlying problems customers asked about) by words, theme, and status. Returns each need's statement, status, theme, proposed solutions, supporter count, demand band, approved use-case summary, and decision note; never who asked.",
  errors: ["validation_failed"],
  http: { method: "GET", path: "/api/needs" },
  input: searchNeedsInput,
  name: "search_needs",
  output: searchNeedsOutput,
  async run({ cursor, limit, q, status, theme }, { db }) {
    const offset = cursor ? (decodeCursor(cursor) ?? 0) : 0;
    const page = await searchPublicNeeds(db, { limit, offset, q, status, theme });
    return { needs: page.needs, nextCursor: page.hasMore ? encodeCursor(offset + limit) : null };
  },
});
