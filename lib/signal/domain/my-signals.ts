import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { decisions, signals } from "@/lib/db/schema";

import type { SignalQueryable } from "../db";
import { getPublicNeed, publicNeedSchema } from "./public-needs";
import { resolveTrackingLink } from "./tracking-links";

/**
 * My signals (spec 001 → get_my_signals, spec 006 → tracking links): what a My signals link
 * shows its holder: every signal filed onto that link, newest first. A legacy per-signal token
 * is adopted as a link on first use. Never other signals with the same email: emails are not
 * verified, so linking by email would let anyone read another person's verbatim words by
 * submitting with their address (decision 0005).
 */

export { trackingTokenSchema } from "./tracking-links";

const decisionSchema = z.object({
  note: z.string(),
  publishedAt: z.iso.datetime({ offset: true }),
  status: z.enum(["planned", "in_progress", "shipped", "declined"]),
});

export const mySignalSchema = z.object({
  attachedTo: z.enum(["existing", "draft"]),
  /** The holder's own words, verbatim. */
  body: z.string(),
  /** Every decision published on the need, oldest first; the last one is current. */
  decisions: z.array(decisionSchema),
  /** The public view of the need the signal is on now (after any merge). */
  need: publicNeedSchema,
  signalId: z.uuid(),
  submittedAt: z.iso.datetime({ offset: true }),
  title: z.string(),
  urgency: z.enum(["low", "medium", "high"]).nullable(),
  useCase: z.string().nullable(),
});

export const mySignalsOutputSchema = z.object({ signals: z.array(mySignalSchema) });
export type MySignalsOutput = z.infer<typeof mySignalsOutputSchema>;

export const getMySignals = async (db: SignalQueryable, token: string) => {
  const link = await resolveTrackingLink(db, token);
  if (!link) return;
  const rows = await db
    .select()
    .from(signals)
    .where(eq(signals.trackingLinkId, link.id))
    .orderBy(desc(signals.createdAt), asc(signals.id));
  if (rows.length === 0) return;

  const details = await Promise.all(
    rows.map(async (row) => ({
      history: await db
        .select({
          note: decisions.note,
          publishedAt: decisions.publishedAt,
          status: decisions.status,
        })
        .from(decisions)
        .where(eq(decisions.needId, row.needId))
        .orderBy(asc(decisions.publishedAt), asc(decisions.id)),
      need: await getPublicNeed(db, row.needId),
      row,
    })),
  );
  const result: MySignalsOutput["signals"] = [];
  for (const { history, need, row } of details) {
    if (!need) continue;
    result.push({
      attachedTo: row.attachedTo,
      body: row.body,
      decisions: history.map((decision) => ({
        ...decision,
        publishedAt: decision.publishedAt.toISOString(),
      })),
      need,
      signalId: row.id,
      submittedAt: row.createdAt.toISOString(),
      title: row.title,
      urgency: row.urgency,
      useCase: row.useCase,
    });
  }
  return { signals: result } satisfies MySignalsOutput;
};
