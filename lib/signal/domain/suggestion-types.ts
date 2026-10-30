import type { z } from "zod";

import type { suggestions } from "@/lib/db/schema";

import type { SignalAi } from "../ai/ports";
import type { Actor } from "../context";
import type { SignalTx } from "../db";

/**
 * Per-kind behaviour for `resolve_suggestion` (spec 001 → PM triage). `resolveSuggestion`
 * is generic: it locks the suggestion, validates `edit` with the kind's `edit` schema, calls
 * `apply` (accept / edit) or `reject` inside the same transaction, then marks the suggestion
 * resolved and records `suggestion.<status>` with the resolver as actor. Register a kind in
 * `suggestion-kinds.ts`. A kind with no handler can still be accepted or rejected (the
 * decision is recorded, nothing else changes) but not edited.
 */

export type SuggestionRow = typeof suggestions.$inferSelect;
export type SuggestionKind = SuggestionRow["kind"];

export interface SuggestionApplyInput<E> {
  actor: Actor;
  ai: SignalAi;
  /** The validated edit for `action: edit`; undefined for `accept`. */
  edit: E | undefined;
  now: Date;
  suggestion: SuggestionRow;
  tx: SignalTx;
}

export interface SuggestionApplied {
  /** Needs whose statement was created or changed; embedded after the transaction commits. */
  embedNeedIds?: string[];
  /** Returned to the caller as `result` (plain JSON). */
  result: Record<string, unknown>;
}

export interface SuggestionKindHandler<E = unknown> {
  /** Applies an accepted or edited suggestion. Throw `SignalError` (conflict, not_found) to abort. */
  apply?: (input: SuggestionApplyInput<E>) => Promise<SuggestionApplied | undefined>;
  /** Validates `edit`; omit to make the kind accept/reject only. */
  edit?: z.ZodType<E>;
  /** Side effects of a rejection (for example, clearing a pending public summary). */
  reject?: (input: Omit<SuggestionApplyInput<E>, "edit">) => Promise<void>;
}

/** Keeps the edit type inside the handler while the registry holds handlers of every shape. */
export const defineSuggestionKind = <E>(handler: SuggestionKindHandler<E>) =>
  handler as SuggestionKindHandler<unknown>;
