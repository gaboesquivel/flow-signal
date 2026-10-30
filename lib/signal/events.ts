import { events } from "@/lib/db/schema";

import type { Actor } from "./context";
import type { SignalQueryable } from "./db";

/**
 * Event types behind the MVP metrics (PRODUCT.md → Metrics; spec 001 → Metrics
 * instrumentation). Add a type here when an operation records a new one.
 */
export type SignalEventType =
  | "decision.published"
  | "merge.undone"
  | "need.created"
  | "need.merged"
  | "need.split"
  | "signal.created"
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

/**
 * Appends an event. Call it with the transaction (`tx`) that makes the change it describes, so
 * a failed or rolled-back request writes no event. Returns false when `dedupeKey` was already
 * recorded (the retry is not counted again).
 */
export const recordEvent = async (db: SignalQueryable, event: SignalEvent) => {
  const rows = await db
    .insert(events)
    .values({
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
    })
    .onConflictDoNothing({ target: events.dedupeKey })
    .returning({ id: events.id });
  return rows.length > 0;
};
