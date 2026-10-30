import { createHash } from "node:crypto";

import { z } from "zod";

import type { Actor } from "../context";
import type { SignalEventType } from "../events";
import { publicTextFindingSchema } from "./public-text";

/**
 * Operator assistant action contract (spec 014, decision 0011), kept apart from
 * `assistant-actions.ts` so operations and metrics can import it without a cycle through the
 * registry. Operator assistant actions (spec 014, decision 0011): the model only proposes a write; the
 * server previews it from the database, stores it as a pending action, and runs it once when the
 * PM confirms through an Operator route that never calls the model.
 */

/** Pending actions expire 30 minutes after they are proposed. */
export const ACTION_TTL_MS = 30 * 60 * 1000;

/** The `client` on events from writes the PM confirmed in the assistant. */
export const ASSISTANT_CLIENT = "console:assistant";

/** The actor a confirmed action runs as: the PM, through the assistant. */
export const assistantConfirmActor: Actor = { client: ASSISTANT_CLIENT, kind: "human", ref: "web" };

/** The actor the assistant's own reads and proposals run as. */
export const assistantAgentActor: Actor = {
  client: ASSISTANT_CLIENT,
  kind: "agent",
  ref: ASSISTANT_CLIENT,
};

export const actionStatuses = ["proposed", "confirmed", "rejected", "expired", "failed"] as const;
export type ActionStatus = (typeof actionStatuses)[number];

export const actionPreviewSchema = z.object({
  /** Blocking issues; Confirm is refused while any remain. */
  blocks: z.array(
    z.object({
      code: z.enum(["public_text_flagged", "conflict"]),
      flags: z.array(publicTextFindingSchema).optional(),
      message: z.string(),
    }),
  ),
  /** Fields the PM may edit on the card, by input key; validated again on confirm. */
  editable: z.array(
    z.object({
      key: z.string(),
      kind: z.enum(["text", "longtext", "select", "number"]),
      label: z.string(),
      options: z.array(z.string()).optional(),
    }),
  ),
  lines: z.array(z.object({ label: z.string(), value: z.string() })),
  needs: z.array(
    z.object({
      id: z.string(),
      role: z.enum(["source", "target", "subject"]),
      statement: z.string(),
    }),
  ),
  /** Non-blocking notes, shown in pencil. */
  notes: z.array(z.string()),
  title: z.string(),
});
export type ActionPreview = z.infer<typeof actionPreviewSchema>;

/**
 * Stable hash of what the PM saw (`title`, `lines`, `needs`, `blocks`); confirm refuses to run
 * when the recomputed preview's fingerprint differs.
 */
export const fingerprint = (preview: ActionPreview): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        preview.title,
        preview.lines.map(({ label, value }) => [label, value]),
        preview.needs.map(({ id, role, statement }) => [id, role, statement]),
        preview.blocks.map(({ code, flags, message }) => [
          code,
          message,
          (flags ?? []).map((flag) => JSON.stringify(flag)),
        ]),
      ]),
    )
    .digest("base64url");

/**
 * Event types recorded by `effects: "write"` operations: the denominator of the assistant action
 * share (PRODUCT.md → Diagnostics). `set_criteria` and `set_strategy` record no event today, so
 * their writes are not counted.
 */
export const writeEventTypes = [
  "decision.published",
  "merge.undone",
  "need.merged",
  "need.split",
  "report.saved",
  "report.shared",
  "suggestion.accepted",
  "suggestion.edited",
  "suggestion.rejected",
] as const satisfies readonly SignalEventType[];
