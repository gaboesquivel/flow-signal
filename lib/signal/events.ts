import { events } from "@/lib/db/schema";

import type { Actor } from "./context";
import type { SignalQueryable } from "./db";

/**
 * Event types behind the MVP metrics (PRODUCT.md → Metrics; spec 001 → Metrics
 * instrumentation). Add a type here when an operation records a new one.
 *
 * Fields `lib/signal/metrics.ts` reads (record them, or the metric undercounts):
 * - `signal.created`: `signalId`, `needId` (the need filed on at submission), payload
 *   `{ attachedTo: "existing" | "draft", hasUseCase: boolean, previewId?, exposure }` (`exposure`
 *   from `domain/exposure.ts`, spec 012); `dedupeKey` from `idempotencyKey`.
 * - `need.created`: `needId`, at the need's first signal (also for a need created by a split).
 * - `need.merged`: `needId` (the need merged away), payload `{ mergeId, intoNeedId }`.
 * - `merge.undone`: `needId` (the need restored), payload `{ mergeId }` of the merge it reverts.
 * - `decision.published`: `needId`, payload `{ decisionId, status, recommendedStatus, briefSuggestionId }`
 *   (the need's latest accepted or edited brief, or nulls; spec 007); the actor is the publisher.
 * - `suggestion.created`: `suggestionId`, payload `{ kind }`.
 * - `need.ready`: `needId`, payload `{ arrCents, supporters, strategyVersion }`; once per need (spec 007).
 * - `preview.shown` (spec 012): payload `{ previewId, ai, matches: [{ needId, probability, rank }],
 *   additionalAsks }` (a count); no need or signal id, and never the submitted text.
 * - `report.saved` (spec 013): payload `{ reportId, created }`; `dedupeKey` from `idempotencyKey`.
 * - `report.viewed` (spec 013): payload `{ reportId, via: "console" | "link" }`.
 * - `report.shared` (spec 013): payload `{ reportId, action: "share" | "refresh" | "revoke" }`.
 * - `suggestion.accepted | edited | rejected`: `suggestionId`, payload `{ kind }`; the actor is
 *   the resolver.
 * - `assistant.action_proposed` (spec 014): payload `{ actionId, operation }`; the actor is the
 *   assistant agent (`client: "console:assistant"`).
 * - `assistant.action_confirmed` (spec 014): payload `{ actionId, operation, edited }`;
 *   `dedupeKey` from the action id; the actor is the PM. The write it ran records its own event
 *   with `client: "console:assistant"`.
 * - `assistant.action_rejected` (spec 014): payload `{ actionId, operation }`; the actor is the PM.
 * - `signal.decision_seen` (close-the-loop rate): `signalId`, `needId` (the need the decision is
 *   on), payload `{ decisionId, status }`; `dedupeKey` `signal.decision_seen:<signalId>:<decisionId>`.
 *   Recorded when `get_my_signals` returns a signal with a decision published after the signal
 *   was created; the actor is whoever read the link (`domain/my-signals.ts`).
 */
export type SignalEventType =
  | "assistant.action_confirmed"
  | "assistant.action_proposed"
  | "assistant.action_rejected"
  | "decision.published"
  | "merge.undone"
  | "need.created"
  | "need.merged"
  | "need.ready"
  | "need.split"
  | "preview.shown"
  | "report.saved"
  | "report.shared"
  | "report.viewed"
  | "signal.created"
  | "signal.decision_seen"
  | "suggestion.accepted"
  | "suggestion.created"
  | "suggestion.edited"
  | "suggestion.rejected";

export interface SignalEvent {
  actor: Actor;
  /** Makes retries count once: derive it from the request's `idempotencyKey`. */
  dedupeKey?: string;
  needId?: string | null;
  occurredAt?: Date;
  payload?: Record<string, unknown>;
  signalId?: string | null;
  suggestionId?: string | null;
  type: SignalEventType;
}

const eventRow = (event: SignalEvent) => ({
  actorKind: event.actor.kind,
  actorRef: event.actor.ref,
  dedupeKey: event.dedupeKey,
  needId: event.needId ?? null,
  occurredAt: event.occurredAt,
  payload: {
    ...event.payload,
    ...(event.actor.client ? { client: event.actor.client } : {}),
  },
  signalId: event.signalId ?? null,
  suggestionId: event.suggestionId ?? null,
  type: event.type,
});

/**
 * Appends an event. Call it with the transaction (`tx`) that makes the change it describes, so
 * a failed or rolled-back request writes no event. Returns false when `dedupeKey` was already
 * recorded (the retry is not counted again).
 */
export const recordEvent = async (db: SignalQueryable, event: SignalEvent) => {
  const rows = await db
    .insert(events)
    .values(eventRow(event))
    .onConflictDoNothing({ target: events.dedupeKey })
    .returning({ id: events.id });
  return rows.length > 0;
};

/** Appends several events in one statement; rows whose `dedupeKey` exists are skipped. */
export const recordEvents = async (db: SignalQueryable, batch: SignalEvent[]) => {
  if (batch.length === 0) return;
  await db
    .insert(events)
    .values(batch.map(eventRow))
    .onConflictDoNothing({ target: events.dedupeKey });
};
