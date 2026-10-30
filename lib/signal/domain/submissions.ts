import { randomBytes } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { accounts, events, needs, signals, submitters, trackingLinks } from "@/lib/db/schema";
import { resolveSiteOrigin } from "@/lib/site-url";

import type { OperationContext } from "../context";
import type { SignalQueryable } from "../db";
import { SignalError } from "../errors";
import { recordEvent } from "../events";
import { tryEmbed } from "./embeddings";
import { resolveExposure } from "./exposure";
import type { Exposure } from "./exposure";
import { CANDIDATE_LIMIT, chooseMatches, MATCH_THRESHOLD } from "./matching";
import { getPublicNeed, publicNeedStatusSchema } from "./public-needs";
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

const possibleDuplicateSchema = z.object({
  needId: z.uuid(),
  /** The match judge's probability that it is the same underlying need. */
  probability: z.number().min(0).max(1),
  statement: z.string(),
  status: publicNeedStatusSchema,
  supporterCount: z.number().int().nonnegative(),
});

export const submitOutputSchema = z.object({
  attachedTo: z.enum(["existing", "draft"]),
  /** True when the signal joined the link named by `trackingToken`; false when a new link was issued. */
  linkReused: z.boolean(),
  needId: z.uuid(),
  /**
   * Existing needs this new need may duplicate (spec 009), found by Signal's own check when the
   * submission created a new need without a usable `previewId`; empty otherwise. Ask the
   * submitter: they can add their voice to one from My signals (`answer_suggested_match`).
   */
  possibleDuplicates: z.array(possibleDuplicateSchema),
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

/** What `signal.created` records of the server check: need ids and probabilities only. */
const recordedDuplicatesSchema = z.array(z.object({ needId: z.string(), probability: z.number() }));
type RecordedDuplicates = z.infer<typeof recordedDuplicatesSchema>;

/** The recorded matches as the needs are now; merged-away needs drop out. */
const renderDuplicates = async (db: SignalQueryable, recorded: RecordedDuplicates) => {
  const views = await Promise.all(recorded.map((match) => getPublicNeed(db, match.needId)));
  return recorded.flatMap((match, index) => {
    const need = views[index];
    if (!need || need.status === "merged") return [];
    return [
      {
        needId: need.id,
        probability: match.probability,
        statement: need.statement,
        status: need.status,
        supporterCount: need.supporterCount,
      },
    ];
  });
};

/**
 * Signal's own duplicate check (spec 009) for a new need filed without a usable preview: the
 * preview's retrieve and judge steps, on the draft statement's embedding. Runs before the
 * transaction; AI being down means no matches, never a failed submission.
 */
const checkSkippedPreview = async (
  { ai, db }: Pick<OperationContext, "ai" | "db">,
  {
    embedding,
    exposure,
    input,
  }: { embedding: number[] | null; exposure: Exposure; input: SubmitInput },
): Promise<RecordedDuplicates> => {
  if (!("newNeed" in input.target) || !embedding) return [];
  if (exposure.kind !== "skipped" && exposure.kind !== "unknown") return [];
  const candidates = await ai.retriever.retrieve({ db, embedding, limit: CANDIDATE_LIMIT });
  if (candidates.length === 0) return [];
  try {
    const judgements = await ai.judge.judge({
      candidates: candidates.map(({ needId, statement }) => ({ needId, statement })),
      draft: { additionalAsks: [], statement: input.target.newNeed.statement },
      submission: { body: input.body, title: input.title },
    });
    return chooseMatches({
      candidates,
      judgements,
      threshold: ai.judge.threshold ?? MATCH_THRESHOLD,
    }).map((j) => ({
      needId: j.needId,
      probability: Math.round(j.probability * 1000) / 1000,
    }));
  } catch (error) {
    if (error instanceof SignalError && error.code === "ai_unavailable") return [];
    throw error;
  }
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
  const [created] = await db
    .select({ payload: events.payload })
    .from(events)
    .where(eq(events.dedupeKey, `signal.created:${input.idempotencyKey}`))
    .limit(1);
  const recorded = recordedDuplicatesSchema.safeParse(created?.payload.possibleDuplicates);
  // A new link takes its first signal's token, so the link was reused exactly when the tokens
  // differ; a legacy signal (no link) was filed before links existed.
  return {
    attachedTo: prior.attachedTo,
    linkReused: prior.linkToken !== null && prior.linkToken !== prior.trackingToken,
    needId: prior.needId,
    possibleDuplicates: await renderDuplicates(db, recorded.success ? recorded.data : []),
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
  // What the submitter was shown (spec 012), read before the transaction like the embedding.
  const exposure = await resolveExposure(db, {
    chosenNeedIds:
      "needId" in input.target && existingNeedId ? [input.target.needId, existingNeedId] : [],
    now,
    previewId: input.previewId,
  });
  const attachedTo = existingNeedId ? "existing" : "draft";
  const trackingToken = newTrackingToken();
  const possibleDuplicates = await checkSkippedPreview({ ai, db }, { embedding, exposure, input });

  try {
    const stored = await db.transaction(async (tx) => {
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
          exposure,
          hasUseCase: Boolean(input.useCase),
          ...(possibleDuplicates.length > 0 ? { possibleDuplicates } : {}),
          ...(input.previewId ? { previewId: input.previewId } : {}),
        },
        signalId: signal.id,
        type: "signal.created",
      });

      return {
        attachedTo,
        linkReused: Boolean(held),
        needId,
        possibleDuplicates: [],
        replayed: false,
        signalId: signal.id,
        trackingUrl: trackingUrlFor(link.token),
      } satisfies SubmitResult;
    });
    return { ...stored, possibleDuplicates: await renderDuplicates(db, possibleDuplicates) };
  } catch (error) {
    if (!(error instanceof DuplicateSubmissionError)) throw error;
    const raced = await findPrior(db, input);
    if (!raced) throw error;
    return { ...raced, replayed: true };
  }
};
