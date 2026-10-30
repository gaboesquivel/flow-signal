import { randomBytes } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { accounts, needs, signals, submitters, trackingLinks } from "@/lib/db/schema";
import { resolveSiteOrigin } from "@/lib/site-url";

import type { OperationContext } from "../context";
import type { SignalQueryable } from "../db";
import { SignalError } from "../errors";
import { recordEvent } from "../events";
import { tryEmbed } from "./embeddings";
import { createTrackingLink, resolveTrackingLink, trackingTokenSchema } from "./tracking-links";

/**
 * Submitting a signal (spec 001 → submit_signal): attach it to an existing need ("add my
 * voice") or create a draft need ("none of these"). The submitter's words are stored verbatim.
 * The signal, a new need, and their events share one transaction; `idempotencyKey` makes a
 * retry return the first result and count once.
 */

const submitTargetSchema = z.union([
  z.object({ needId: z.uuid() }).strict(),
  z
    .object({
      newNeed: z
        .object({
          /** The draft need statement ("who needs to do what so that outcome"), e.g. from preview. */
          statement: z.string().trim().min(10).max(500),
        })
        .strict(),
    })
    .strict(),
]);

export const submitInputSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  company: z.string().trim().min(1).max(120).optional(),
  email: z.email().max(254),
  /** Required on every surface: a retry with the same key returns the same signal. */
  idempotencyKey: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[\w.:-]+$/u, "Use letters, digits, and . _ : - only."),
  name: z.string().trim().min(1).max(120).optional(),
  /** The `previewId` from `preview_signal`, when the submitter saw a preview. */
  previewId: z.string().max(64).optional(),
  target: submitTargetSchema,
  title: z.string().trim().min(1).max(200),
  /**
   * The token of a My signals link the submitter already holds (last segment of their
   * `trackingUrl`). The signal joins that link; an unknown token gets a new link. Pass it only
   * when the submitter gave it to you; never derive it from an email.
   */
  trackingToken: trackingTokenSchema.optional(),
  urgency: z.enum(["low", "medium", "high"]).optional(),
  useCase: z.string().trim().min(1).max(2000).optional(),
});
export type SubmitInput = z.infer<typeof submitInputSchema>;

export const submitOutputSchema = z.object({
  attachedTo: z.enum(["existing", "draft"]),
  /** True when the signal joined the link named by `trackingToken`; false when a new link was issued. */
  linkReused: z.boolean(),
  needId: z.uuid(),
  signalId: z.uuid(),
  /** Private, unguessable My signals link (`get_my_signals`) holding this signal. Share it only with them. */
  trackingUrl: z.url(),
});
type SubmitOutput = z.infer<typeof submitOutputSchema>;

const newTrackingToken = () => randomBytes(24).toString("base64url");

const trackingUrlFor = (token: string) => `${resolveSiteOrigin()}/my/${token}`;

const normalizeEmail = (email: string) => email.trim().toLowerCase();

const MAX_MERGE_HOPS = 10;

/** The live need for a target id: merged needs forward to the need they were merged into. */
const resolveLiveNeed = async (db: SignalQueryable, needId: string) => {
  let id = needId;
  for (let hop = 0; hop <= MAX_MERGE_HOPS; hop += 1) {
    // Each hop depends on the previous one.
    // oxlint-disable-next-line eslint/no-await-in-loop
    const [need] = await db
      .select({ id: needs.id, mergedIntoId: needs.mergedIntoId, status: needs.status })
      .from(needs)
      .where(eq(needs.id, id))
      .limit(1);
    if (!need) throw new SignalError("not_found", `No need with id ${needId}.`);
    if (need.status !== "merged" || !need.mergedIntoId) return need.id;
    id = need.mergedIntoId;
  }
  throw new SignalError("not_found", `Need ${needId} has no live need to attach to.`);
};

/** The stored result for an idempotency key, or undefined. A different submission is a conflict. */
const findPrior = async (db: SignalQueryable, input: SubmitInput) => {
  const [prior] = await db
    .select({
      attachedTo: signals.attachedTo,
      body: signals.body,
      email: submitters.email,
      linkToken: trackingLinks.token,
      needId: signals.needId,
      signalId: signals.id,
      title: signals.title,
      trackingToken: signals.trackingToken,
    })
    .from(signals)
    .innerJoin(submitters, eq(submitters.id, signals.submitterId))
    .leftJoin(trackingLinks, eq(trackingLinks.id, signals.trackingLinkId))
    .where(eq(signals.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (!prior) return;
  if (
    prior.email !== normalizeEmail(input.email) ||
    prior.title !== input.title ||
    prior.body !== input.body
  )
    throw new SignalError(
      "conflict",
      "This idempotencyKey was already used for a different submission; use a new key.",
    );
  // A new link takes its first signal's token, so the link was reused exactly when the tokens
  // differ; a legacy signal (no link) was filed before links existed.
  return {
    attachedTo: prior.attachedTo,
    linkReused: prior.linkToken !== null && prior.linkToken !== prior.trackingToken,
    needId: prior.needId,
    signalId: prior.signalId,
    trackingUrl: trackingUrlFor(prior.linkToken ?? prior.trackingToken),
  } satisfies SubmitOutput;
};

const upsertSubmitter = async (
  tx: SignalQueryable,
  { company, email, name }: { company?: string; email: string; name?: string },
) => {
  let accountId: string | null = null;
  if (company) {
    const [existing] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(sql`lower(${accounts.name}) = lower(${company})`)
      .limit(1);
    if (existing) accountId = existing.id;
    else {
      // Unknown companies become an account with no revenue; a PM fills in plan and ARR.
      const [created] = await tx
        .insert(accounts)
        .values({ name: company, plan: "Unknown" })
        .returning({ id: accounts.id });
      accountId = created?.id ?? null;
    }
  }
  const [row] = await tx
    .insert(submitters)
    .values({ accountId, email, name: name ?? null })
    .onConflictDoUpdate({
      set: {
        accountId: sql`coalesce(${submitters.accountId}, excluded.account_id)`,
        name: sql`coalesce(${submitters.name}, excluded.name)`,
      },
      target: submitters.email,
    })
    .returning({ id: submitters.id });
  if (!row) throw new Error("Submitter upsert returned no row.");
  return row.id;
};

/** Raised inside the transaction when a concurrent request already stored this key. */
class DuplicateSubmissionError extends Error {
  constructor() {
    super("A concurrent request already stored this idempotencyKey.");
    this.name = "DuplicateSubmissionError";
  }
}

const createDraftNeed = async (
  tx: SignalQueryable,
  values: { createdAt: Date; embedding: number[] | null; statement: string },
) => {
  const [need] = await tx
    .insert(needs)
    .values({ ...values, status: "draft" })
    .returning({ id: needs.id });
  if (!need) throw new Error("Draft need insert returned no row.");
  return need.id;
};

const channelFor = (ref: string) => (ref.startsWith("mcp:") ? "mcp" : "web");

/**
 * `replayed` (internal, not in the output schema) is true when a reused `idempotencyKey`
 * returned the stored result, so callers skip side effects such as suggestion generation.
 */
type SubmitResult = SubmitOutput & { replayed: boolean };

export const submitSignal = async (
  { actor, ai, clock, db }: OperationContext,
  input: SubmitInput,
): Promise<SubmitResult> => {
  const prior = await findPrior(db, input);
  if (prior) return { ...prior, replayed: true };

  const email = normalizeEmail(input.email);
  const existingNeedId =
    "needId" in input.target ? await resolveLiveNeed(db, input.target.needId) : undefined;
  const newStatement = "newNeed" in input.target ? input.target.newNeed.statement : undefined;
  // Embed before the transaction (no network call while it is open); a down embedder leaves
  // the vector null for `pnpm db:embed` to backfill.
  const embedding = newStatement ? await tryEmbed(ai.embedder, newStatement) : null;

  const now = clock.now();
  const attachedTo = existingNeedId ? "existing" : "draft";
  const trackingToken = newTrackingToken();

  try {
    return await db.transaction(async (tx) => {
      const submitterId = await upsertSubmitter(tx, {
        company: input.company,
        email,
        name: input.name,
      });

      // The holder's link (adopting a legacy token on first use), or a new one. An unknown token
      // never names the new link: the caller gets a fresh, unguessable one.
      const held = input.trackingToken
        ? await resolveTrackingLink(tx, input.trackingToken, { inTransaction: true })
        : undefined;
      const link = held ?? (await createTrackingLink(tx, { createdAt: now, token: trackingToken }));

      const needId =
        existingNeedId ??
        (await createDraftNeed(tx, { createdAt: now, embedding, statement: newStatement ?? "" }));

      const [signal] = await tx
        .insert(signals)
        .values({
          actorKind: actor.kind,
          agentClient: actor.kind === "agent" ? (actor.client ?? null) : null,
          attachedTo,
          body: input.body,
          channel: channelFor(actor.ref),
          createdAt: now,
          idempotencyKey: input.idempotencyKey,
          needId,
          originalNeedId: needId,
          submitterId,
          title: input.title,
          trackingLinkId: link.id,
          trackingToken,
          urgency: input.urgency ?? null,
          useCase: input.useCase ?? null,
        })
        .onConflictDoNothing({ target: signals.idempotencyKey })
        .returning({ id: signals.id });
      if (!signal) throw new DuplicateSubmissionError();

      if (attachedTo === "draft")
        await recordEvent(tx, {
          actor,
          dedupeKey: `need.created:${input.idempotencyKey}`,
          needId,
          occurredAt: now,
          payload: { source: "submission" },
          signalId: signal.id,
          type: "need.created",
        });
      await recordEvent(tx, {
        actor,
        dedupeKey: `signal.created:${input.idempotencyKey}`,
        needId,
        occurredAt: now,
        payload: {
          attachedTo,
          hasUseCase: Boolean(input.useCase),
          ...(input.previewId ? { previewId: input.previewId } : {}),
        },
        signalId: signal.id,
        type: "signal.created",
      });

      return {
        attachedTo,
        linkReused: Boolean(held),
        needId,
        replayed: false,
        signalId: signal.id,
        trackingUrl: trackingUrlFor(link.token),
      } satisfies SubmitResult;
    });
  } catch (error) {
    if (!(error instanceof DuplicateSubmissionError)) throw error;
    const raced = await findPrior(db, input);
    if (!raced) throw error;
    return { ...raced, replayed: true };
  }
};
