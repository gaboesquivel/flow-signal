import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { signals, trackingLinks } from "@/lib/db/schema";

import type { SignalQueryable } from "../db";

/**
 * My signals links (spec 006 → Implementation Decisions 1–2, decision 0005). A link is a
 * private token its holder files signals onto. Possession of the token is the proof: links are
 * never derived from, looked up by, or grouped by email.
 */

export const trackingTokenSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[\w-]+$/u, "Not a tracking token.");

interface TrackingLink {
  id: string;
  token: string;
}

const linkColumns = { id: trackingLinks.id, token: trackingLinks.token };

const findLink = async (db: SignalQueryable, token: string): Promise<TrackingLink | undefined> => {
  const [link] = await db
    .select(linkColumns)
    .from(trackingLinks)
    .where(eq(trackingLinks.token, token))
    .limit(1);
  return link;
};

/**
 * Adopts a legacy token (spec 001 issued one per signal, with no link): creates a link with that
 * same token and attaches the legacy signal, so old `/my/<token>` URLs keep working. Run inside a
 * transaction. Concurrent first uses converge on one link (the token is unique). Undefined when
 * no unlinked signal has this token.
 */
const adoptLegacyToken = async (
  tx: SignalQueryable,
  token: string,
): Promise<TrackingLink | undefined> => {
  const [legacy] = await tx
    .select({ id: signals.id })
    .from(signals)
    .where(and(eq(signals.trackingToken, token), isNull(signals.trackingLinkId)))
    .limit(1);
  if (!legacy) return;
  await tx.insert(trackingLinks).values({ token }).onConflictDoNothing({
    target: trackingLinks.token,
  });
  const link = await findLink(tx, token);
  if (!link) throw new Error("Adopted tracking link was not found.");
  await tx
    .update(signals)
    .set({ trackingLinkId: link.id })
    .where(and(eq(signals.id, legacy.id), isNull(signals.trackingLinkId)));
  return link;
};

/**
 * The link a holder's token names, adopting a legacy token on first use. A signal's own token
 * on a shared link is not a link: only link tokens are ever handed out.
 */
export const resolveTrackingLink = async (
  db: SignalQueryable,
  token: string,
  { inTransaction = false } = {},
): Promise<TrackingLink | undefined> =>
  (await findLink(db, token)) ??
  (inTransaction
    ? adoptLegacyToken(db, token)
    : db.transaction((tx) => adoptLegacyToken(tx, token)));

/** A new link; its token is the first signal's own token, so the two stay one URL. */
export const createTrackingLink = async (
  tx: SignalQueryable,
  { createdAt, token }: { createdAt: Date; token: string },
): Promise<TrackingLink> => {
  const [link] = await tx.insert(trackingLinks).values({ createdAt, token }).returning(linkColumns);
  if (!link) throw new Error("Tracking link insert returned no row.");
  return link;
};
