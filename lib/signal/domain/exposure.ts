import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { events } from "@/lib/db/schema";

import type { SignalQueryable } from "../db";

/**
 * Match exposure (spec 012): which needs a submitter was shown before submitting, and which one
 * they chose. `preview_signal` records `preview.shown`; `submit_signal` resolves its `previewId`
 * here and stamps the result on `signal.created` as `exposure`, which `get_metrics` reads.
 */

/** A preview this old or older at submit time no longer counts as what the submitter saw. */
export const EXPOSURE_WINDOW_MS = 24 * 60 * 60 * 1000;

export const shownMatchSchema = z.object({
  needId: z.string(),
  probability: z.number(),
  rank: z.number().int().min(1),
});

/** `preview.shown` payload; the submitted text is never stored. */
export const previewShownSchema = z.object({
  additionalAsks: z.number().int().nonnegative(),
  ai: z.enum(["ok", "unavailable"]),
  matches: z.array(shownMatchSchema),
  previewId: z.string(),
});

export const exposureSchema = z.discriminatedUnion("kind", [
  z.object({
    /** 1-based rank of the chosen need among `shownNeedIds`; null for a new need or one not shown. */
    chosenRank: z.number().int().min(1).nullable(),
    kind: z.literal("shown"),
    previewId: z.string(),
    shownNeedIds: z.array(z.string()).min(1),
  }),
  /** The preview was found and showed no match (none passed the threshold, or AI was down). */
  z.object({ kind: z.literal("none_shown"), previewId: z.string() }),
  /** No `previewId` was sent. */
  z.object({ kind: z.literal("skipped") }),
  /** A `previewId` Signal never issued, or one older than `EXPOSURE_WINDOW_MS`. */
  z.object({ kind: z.literal("unknown"), previewId: z.string() }),
]);
export type Exposure = z.infer<typeof exposureSchema>;

/**
 * What the submitter saw, from the `preview.shown` the `previewId` names. Never throws for an
 * unknown or expired id: the submission goes ahead and records `unknown`.
 */
export const resolveExposure = async (
  db: SignalQueryable,
  {
    chosenNeedIds,
    now,
    previewId,
  }: {
    /** The target the submitter picked, then the live need it resolves to after merges. */
    chosenNeedIds: string[];
    now: Date;
    previewId: string | undefined;
  },
): Promise<Exposure> => {
  if (!previewId) return { kind: "skipped" };
  const [row] = await db
    .select({ occurredAt: events.occurredAt, payload: events.payload })
    .from(events)
    .where(
      and(eq(events.dedupeKey, `preview.shown:${previewId}`), eq(events.type, "preview.shown")),
    )
    .limit(1);
  const shown = row ? previewShownSchema.safeParse(row.payload) : undefined;
  const age = row ? now.getTime() - row.occurredAt.getTime() : Number.POSITIVE_INFINITY;
  if (!shown?.success || age >= EXPOSURE_WINDOW_MS) return { kind: "unknown", previewId };

  const shownNeedIds = shown.data.matches
    .toSorted((a, b) => a.rank - b.rank)
    .map((match) => match.needId);
  if (shownNeedIds.length === 0) return { kind: "none_shown", previewId };
  const index =
    chosenNeedIds.map((id) => shownNeedIds.indexOf(id)).find((found) => found !== -1) ?? -1;
  return { chosenRank: index === -1 ? null : index + 1, kind: "shown", previewId, shownNeedIds };
};
