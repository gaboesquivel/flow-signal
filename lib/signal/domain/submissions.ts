import { randomBytes } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { accounts, needs, signals, submitters } from "@/lib/db/schema";
import { resolveSiteOrigin } from "@/lib/site-url";

import type { OperationContext } from "../context";
import type { SignalQueryable } from "../db";
import { SignalError } from "../errors";
import { recordEvent } from "../events";
import { tryEmbed } from "./embeddings";

/**
 * Submitting a signal (spec 001 → submit_signal): attach it to an existing need ("add my
 * voice") or create a draft need ("none of these"). The submitter's words are stored verbatim.
 * The signal, a new need, and their events share one transaction; `idempotencyKey` makes a
 * retry return the first result and count once.
 */

export const submitTargetSchema = z.union([
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
  urgency: z.enum(["low", "medium", "high"]).optional(),
  useCase: z.string().trim().min(1).max(2000).optional(),
});
export type SubmitInput = z.infer<typeof submitInputSchema>;

export const submitOutputSchema = z.object({
  attachedTo: z.enum(["existing", "draft"]),
  needId: z.uuid(),
  signalId: z.uuid(),
  /** Private, unguessable link to the submitter's signal (`get_my_signals`). Share it only with them. */
  trackingUrl: z.url(),
});
export type SubmitOutput = z.infer<typeof submitOutputSchema>;

export const newTrackingToken = () => randomBytes(24).toString("base64url");

export const trackingUrlFor = (token: string) => `${resolveSiteOrigin()}/my/${token}`;

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
      needId: signals.needId,
      signalId: signals.id,
      title: signals.title,
      trackingToken: signals.trackingToken,
    })
    .from(signals)
    .innerJoin(submitters, eq(submitters.id, signals.submitterId))
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
  return {
    attachedTo: prior.attachedTo,
    needId: prior.needId,
    signalId: prior.signalId,
    trackingUrl: trackingUrlFor(prior.trackingToken),
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

export const submitSignal = async (
  { actor, ai, clock, db }: OperationContext,
  input: SubmitInput,
): Promise<SubmitOutput> => {
  const prior = await findPrior(db, input);
  if (prior) return prior;

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
        needId,
        signalId: signal.id,
        trackingUrl: trackingUrlFor(trackingToken),
      } satisfies SubmitOutput;
    });
  } catch (error) {
    if (!(error instanceof DuplicateSubmissionError)) throw error;
    const raced = await findPrior(db, input);
    if (!raced) throw error;
    return raced;
  }
};
