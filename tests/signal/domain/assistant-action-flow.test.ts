import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";

import { GET, POST } from "../../../app/api/operator/assistant/actions/[id]/route";
import { assistantActions, events, needs } from "../../../lib/db/schema";
import { createFakeAi } from "../../../lib/signal/ai/fakes";
import type { SignalDb } from "../../../lib/signal/db";
import {
  confirmAction,
  getAction,
  proposeAction,
  rejectAction,
} from "../../../lib/signal/domain/assistant-actions";
import { ACTION_TTL_MS } from "../../../lib/signal/domain/assistant-action-contract";
import type { ActionContext } from "../../../lib/signal/domain/assistant-actions";
import type { ActionPreview } from "../../../lib/signal/domain/assistant-action-contract";
import {
  mergeNeeds as mergeNeedsInDb,
  undoMerge as undoMergeInDb,
} from "../../../lib/signal/domain/merges";
import { SignalError } from "../../../lib/signal/errors";
import { mergeNeeds } from "../../../lib/signal/operations/merge-needs";
import { defineOperation } from "../../../lib/signal/operations/types";
import type { AnyOperation } from "../../../lib/signal/operations/types";
import { insertNeed } from "../support/builders";
import { describeWithDatabase, resetDatabase, useTestDatabase } from "../support/database";

/**
 * Spec 014 task 03: propose, confirm, and reject (Testing Decisions → Actions), plus the action
 * routes. Previews here are test-only (task 02 adds the real ones), stubbed onto a copy of
 * `merge_needs` and onto small test operations.
 */

const SECRET = "assistant-actions-secret-0123456789";
const start = new Date("2026-10-30T09:00:00Z");

const mergePreview: NonNullable<AnyOperation["preview"]> = async (
  { id, intoNeedId }: { id: string; intoNeedId: string },
  { db },
) => {
  const rows = await db.select().from(needs);
  const from = rows.find((row) => row.id === id);
  const into = rows.find((row) => row.id === intoNeedId);
  if (!from || !into) throw new SignalError("not_found", "Need not found.");
  const merged = [from, into].filter((row) => row.status === "merged");
  return {
    blocks: merged.map((row) => ({ code: "conflict", message: `${row.id} is already merged.` })),
    editable: [],
    lines: [
      { label: "From", value: from.status },
      { label: "Into", value: into.status },
    ],
    needs: [
      { id: from.id, role: "source", statement: from.statement },
      { id: into.id, role: "target", statement: into.statement },
    ],
    notes: [],
    title: "Merge 2 needs",
  } satisfies ActionPreview;
};

/** `merge_needs` with a test preview: the real `run`, its event, and its errors. */
const mergeWithPreview: AnyOperation = { ...mergeNeeds, preview: mergePreview };

const runs = { note: 0 };

/** A write with an editable, re-checked note (stands in for `publish_decision`). */
const publishNote = defineOperation({
  access: "operator",
  description: "Test only: publish a note on a need; blocked while it names an account.",
  effects: "write",
  errors: ["not_found"],
  http: { method: "POST", path: "/api/test/notes" },
  input: z.object({ needId: z.uuid(), note: z.string().min(1) }),
  name: "publish_note",
  output: z.object({ note: z.string() }),
  preview: ({ note }) =>
    Promise.resolve({
      blocks: note.includes("Acme")
        ? [{ code: "public_text_flagged" as const, message: "The note names an account." }]
        : [],
      editable: [{ key: "note", kind: "longtext" as const, label: "Note" }],
      lines: [{ label: "Note", value: note }],
      needs: [],
      notes: [],
      title: "Publish note",
    }),
  run: ({ note }) => {
    runs.note += 1;
    return Promise.resolve({ note });
  },
});

/** A write whose preview is clean and whose run fails. */
const alwaysConflicts = defineOperation({
  access: "operator",
  description: "Test only: a write that always fails with conflict when run.",
  effects: "write",
  errors: ["conflict"],
  http: { method: "POST", path: "/api/test/conflict" },
  input: z.object({}),
  name: "always_conflicts",
  output: z.object({}),
  preview: () =>
    Promise.resolve({
      blocks: [],
      editable: [],
      lines: [],
      needs: [],
      notes: [],
      title: "Conflict",
    }),
  run: () => Promise.reject(new SignalError("conflict", "It conflicted.")),
});

/** A write that takes an idempotency key: confirm passes the action id. */
const keyed = defineOperation({
  access: "operator",
  description: "Test only: echoes the idempotency key it ran with.",
  effects: "write",
  errors: [],
  http: { method: "POST", path: "/api/test/keyed" },
  input: z.object({ idempotencyKey: z.string().optional(), title: z.string() }),
  name: "keyed_write",
  output: z.object({ idempotencyKey: z.string().nullable() }),
  preview: ({ title }) =>
    Promise.resolve({ blocks: [], editable: [], lines: [], needs: [], notes: [], title }),
  run: ({ idempotencyKey }) => Promise.resolve({ idempotencyKey: idempotencyKey ?? null }),
});

/** A read: never proposable. */
const readOnly = defineOperation({
  ...keyed,
  effects: "read",
  name: "read_only",
});

/** A write with a nested editable field, like `resolve_suggestion`'s `edit.statement`. */
const nestedEdit = defineOperation({
  access: "operator",
  description: "Test only: echoes a nested statement.",
  effects: "write",
  errors: [],
  http: { method: "POST", path: "/api/test/nested" },
  input: z.object({ edit: z.object({ reason: z.string(), statement: z.string() }) }),
  name: "nested_edit",
  output: z.object({ statement: z.string() }),
  preview: ({ edit }) =>
    Promise.resolve({
      blocks: [],
      editable: [{ key: "edit.statement", kind: "text" as const, label: "Statement" }],
      lines: [{ label: "Statement", value: edit.statement }],
      needs: [],
      notes: [],
      title: "Nested edit",
    }),
  run: ({ edit }) => Promise.resolve({ statement: edit.statement }),
});

const testOperations = [
  mergeWithPreview,
  publishNote,
  alwaysConflicts,
  keyed,
  readOnly,
  nestedEdit,
];

const clock = { current: start, now: () => clock.current };
const ctx: ActionContext = { ai: createFakeAi(), clock, operations: testOperations };

const eventsOf = (db: SignalDb, type: string) =>
  db
    .select()
    .from(events)
    .where(eq(events.type, type as typeof events.$inferSelect.type));

const actionRow = async (db: SignalDb, id: string) => {
  const [row] = await db.select().from(assistantActions).where(eq(assistantActions.id, id));
  return row!;
};

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SignalError) return error.code;
    throw error;
  }
  throw new Error("Expected a SignalError.");
};

const twoNeeds = async (db: SignalDb) => {
  const { need: from } = await insertNeed(db, { signals: [{}] });
  const { need: into } = await insertNeed(db, { signals: [{}] });
  return { from, into };
};

describeWithDatabase("assistant actions: propose, confirm, reject", () => {
  const harness = useTestDatabase();

  beforeEach(async () => {
    await resetDatabase(harness.db);
    clock.current = start;
    runs.note = 0;
  });

  it("propose stores one row and one event, and changes nothing else", async () => {
    const { from, into } = await twoNeeds(harness.db);
    const proposal = await proposeAction(
      harness.db,
      { input: { id: from.id, intoNeedId: into.id }, operation: "merge_needs" },
      ctx,
    );
    expect(proposal.preview.title).toBe("Merge 2 needs");
    const rows = await harness.db.select().from(assistantActions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      edited: false,
      id: proposal.actionId,
      operation: "merge_needs",
      status: "proposed",
    });
    expect(rows[0]!.expiresAt.getTime()).toBe(start.getTime() + ACTION_TTL_MS);
    const proposed = await eventsOf(harness.db, "assistant.action_proposed");
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.payload).toMatchObject({
      actionId: proposal.actionId,
      client: "console:assistant",
      operation: "merge_needs",
    });
    expect(proposed[0]!.actorKind).toBe("agent");
    expect(await eventsOf(harness.db, "need.merged")).toHaveLength(0);
  });

  it("a bad input, a throwing preview, or a read operation stores nothing", async () => {
    const { from } = await twoNeeds(harness.db);
    expect(
      await codeOf(
        proposeAction(harness.db, { input: { id: "nope" }, operation: "merge_needs" }, ctx),
      ),
    ).toBe("validation_failed");
    expect(
      await codeOf(
        proposeAction(
          harness.db,
          {
            input: { id: from.id, intoNeedId: "11111111-1111-4111-8111-111111111111" },
            operation: "merge_needs",
          },
          ctx,
        ),
      ),
    ).toBe("not_found");
    expect(
      await codeOf(
        proposeAction(harness.db, { input: { title: "x" }, operation: "read_only" }, ctx),
      ),
    ).toBe("validation_failed");
    expect(await harness.db.select().from(assistantActions)).toHaveLength(0);
    expect(await eventsOf(harness.db, "assistant.action_proposed")).toHaveLength(0);
  });

  it("confirm runs once as the PM through the assistant; a retry returns the stored result", async () => {
    const { from, into } = await twoNeeds(harness.db);
    const { actionId } = await proposeAction(
      harness.db,
      { input: { id: from.id, intoNeedId: into.id }, operation: "merge_needs" },
      ctx,
    );
    const first = await confirmAction(harness.db, { actionId }, ctx);
    expect(first.status).toBe("confirmed");
    const merged = await eventsOf(harness.db, "need.merged");
    expect(merged).toHaveLength(1);
    expect(merged[0]!.actorKind).toBe("human");
    expect(merged[0]!.payload).toMatchObject({ client: "console:assistant" });

    const retry = await confirmAction(harness.db, { actionId }, ctx);
    expect(retry).toEqual(first);
    expect(await eventsOf(harness.db, "need.merged")).toHaveLength(1);
    const confirmed = await eventsOf(harness.db, "assistant.action_confirmed");
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]!.payload).toMatchObject({ actionId, edited: false });
    expect(await actionRow(harness.db, actionId)).toMatchObject({ status: "confirmed" });
  });

  it("two concurrent confirms produce one operation event and one confirmed", async () => {
    const { from, into } = await twoNeeds(harness.db);
    const { actionId } = await proposeAction(
      harness.db,
      { input: { id: from.id, intoNeedId: into.id }, operation: "merge_needs" },
      ctx,
    );
    const settled = await Promise.allSettled([
      confirmAction(harness.db, { actionId }, ctx),
      confirmAction(harness.db, { actionId }, ctx),
    ]);
    const confirmed = settled.filter(
      (outcome) => outcome.status === "fulfilled" && outcome.value.status === "confirmed",
    );
    expect(confirmed.length).toBeGreaterThanOrEqual(1);
    for (const outcome of settled)
      if (outcome.status === "rejected")
        expect((outcome.reason as SignalError).code).toBe("action_closed");
    expect(await eventsOf(harness.db, "need.merged")).toHaveLength(1);
    expect(await eventsOf(harness.db, "assistant.action_confirmed")).toHaveLength(1);
    expect(await actionRow(harness.db, actionId)).toMatchObject({ status: "confirmed" });
  });

  it("a stale preview (merged elsewhere first) returns needs_review and runs nothing", async () => {
    const { from, into } = await twoNeeds(harness.db);
    const { actionId } = await proposeAction(
      harness.db,
      { input: { id: from.id, intoNeedId: into.id }, operation: "merge_needs" },
      ctx,
    );
    await harness.db.transaction((tx) =>
      mergeNeedsInDb(tx, {
        actor: { kind: "human", ref: "web" },
        fromNeedId: from.id,
        intoNeedId: into.id,
        now: start,
      }),
    );
    const outcome = await confirmAction(harness.db, { actionId }, ctx);
    expect(outcome.status).toBe("needs_review");
    if (outcome.status !== "needs_review") return;
    expect(outcome.preview.blocks[0]?.code).toBe("conflict");
    expect(await eventsOf(harness.db, "need.merged")).toHaveLength(1);
    const row = await actionRow(harness.db, actionId);
    expect(row.status).toBe("proposed");
    expect(row.preview).toEqual(outcome.preview);
  });

  it("editing a non-editable key is validation_failed", async () => {
    const { from, into } = await twoNeeds(harness.db);
    const { actionId } = await proposeAction(
      harness.db,
      { input: { id: from.id, intoNeedId: into.id }, operation: "merge_needs" },
      ctx,
    );
    expect(
      await codeOf(confirmAction(harness.db, { actionId, input: { intoNeedId: from.id } }, ctx)),
    ).toBe("validation_failed");
    const { need } = await insertNeed(harness.db);
    const note = await proposeAction(
      harness.db,
      { input: { needId: need.id, note: "Planned" }, operation: "publish_note" },
      ctx,
    );
    expect(
      await codeOf(
        confirmAction(harness.db, { actionId: note.actionId, input: { needId: from.id } }, ctx),
      ),
    ).toBe("validation_failed");
    expect(runs.note).toBe(0);
  });

  it("an edited note is re-checked, stays blocked while flagged, then runs once", async () => {
    const { need } = await insertNeed(harness.db);
    const { actionId, preview } = await proposeAction(
      harness.db,
      { input: { needId: need.id, note: "Acme asked first" }, operation: "publish_note" },
      ctx,
    );
    expect(preview.blocks).toHaveLength(1);

    const blocked = await confirmAction(harness.db, { actionId }, ctx);
    expect(blocked.status).toBe("needs_review");
    const stillFlagged = await confirmAction(
      harness.db,
      { actionId, input: { note: "Acme again" } },
      ctx,
    );
    expect(stillFlagged.status).toBe("needs_review");
    expect(runs.note).toBe(0);

    // An edit that changes the preview is shown for review first, then confirmed as shown.
    const edited = await confirmAction(
      harness.db,
      { actionId, input: { note: "Planned for next quarter" } },
      ctx,
    );
    expect(edited.status).toBe("needs_review");
    expect(runs.note).toBe(0);
    const done = await confirmAction(
      harness.db,
      { actionId, input: { note: "Planned for next quarter" } },
      ctx,
    );
    expect(done).toEqual({ result: { note: "Planned for next quarter" }, status: "confirmed" });
    expect(runs.note).toBe(1);
    expect(await actionRow(harness.db, actionId)).toMatchObject({
      edited: true,
      input: { needId: need.id, note: "Planned for next quarter" },
    });
    const [event] = await eventsOf(harness.db, "assistant.action_confirmed");
    expect(event!.payload).toMatchObject({ edited: true });
  });

  it("an expired action is action_closed and marked expired", async () => {
    const { from, into } = await twoNeeds(harness.db);
    const { actionId } = await proposeAction(
      harness.db,
      { input: { id: from.id, intoNeedId: into.id }, operation: "merge_needs" },
      ctx,
    );
    clock.current = new Date(start.getTime() + ACTION_TTL_MS);
    expect(await codeOf(confirmAction(harness.db, { actionId }, ctx))).toBe("action_closed");
    expect(await actionRow(harness.db, actionId)).toMatchObject({ status: "expired" });
    expect(await codeOf(rejectAction(harness.db, { actionId }, ctx))).toBe("action_closed");
    expect(await eventsOf(harness.db, "need.merged")).toHaveLength(0);
  });

  it("a failing operation leaves the action failed with no operation event", async () => {
    const { actionId } = await proposeAction(
      harness.db,
      { input: {}, operation: "always_conflicts" },
      ctx,
    );
    expect(await codeOf(confirmAction(harness.db, { actionId }, ctx))).toBe("conflict");
    expect(await actionRow(harness.db, actionId)).toMatchObject({
      errorCode: "conflict",
      status: "failed",
    });
    expect(await eventsOf(harness.db, "assistant.action_confirmed")).toHaveLength(0);
    expect(await codeOf(confirmAction(harness.db, { actionId }, ctx))).toBe("action_closed");
  });

  it("passes the action id as the idempotency key where the operation takes one", async () => {
    const { actionId } = await proposeAction(
      harness.db,
      { input: { idempotencyKey: "model-chosen", title: "Weekly" }, operation: "keyed_write" },
      ctx,
    );
    expect(await confirmAction(harness.db, { actionId }, ctx)).toEqual({
      result: { idempotencyKey: actionId },
      status: "confirmed",
    });
  });

  it("reject records assistant.action_rejected and closes the action", async () => {
    const { from, into } = await twoNeeds(harness.db);
    const { actionId } = await proposeAction(
      harness.db,
      { input: { id: from.id, intoNeedId: into.id }, operation: "merge_needs" },
      ctx,
    );
    expect(await rejectAction(harness.db, { actionId }, ctx)).toEqual({ status: "rejected" });
    expect(await rejectAction(harness.db, { actionId }, ctx)).toEqual({ status: "rejected" });
    const rejected = await eventsOf(harness.db, "assistant.action_rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.payload).toMatchObject({ actionId, operation: "merge_needs" });
    expect(rejected[0]!.actorKind).toBe("human");
    expect(await codeOf(confirmAction(harness.db, { actionId }, ctx))).toBe("action_closed");
    expect(await eventsOf(harness.db, "need.merged")).toHaveLength(0);
    expect((await getAction(harness.db, actionId)).status).toBe("rejected");
  });

  it("an unknown action is not_found", async () => {
    const missing = "22222222-2222-4222-8222-222222222222";
    expect(await codeOf(confirmAction(harness.db, { actionId: missing }, ctx))).toBe("not_found");
    expect(await codeOf(rejectAction(harness.db, { actionId: missing }, ctx))).toBe("not_found");
    expect(await codeOf(getAction(harness.db, "not-a-uuid"))).toBe("not_found");
  });
});

const uuidIn = /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/iu;

describeWithDatabase("assistant actions: stale cards with the real previews", () => {
  const harness = useTestDatabase();
  /** The registry's own `merge_needs` and `undo_merge`, whose previews throw once stale. */
  const realCtx: ActionContext = { ai: createFakeAi(), clock };

  beforeEach(async () => {
    await resetDatabase(harness.db);
    clock.current = start;
  });

  const expectStale = async (actionId: string, message: RegExp) => {
    const outcome = await confirmAction(harness.db, { actionId }, realCtx);
    expect(outcome.status).toBe("needs_review");
    if (outcome.status !== "needs_review") return;
    const [block] = outcome.preview.blocks;
    expect(block?.code).toBe("conflict");
    expect(block?.message).toMatch(message);
    expect(block?.message).not.toMatch(uuidIn);
    const row = await actionRow(harness.db, actionId);
    expect(row.status).toBe("proposed");
    expect(row.preview).toEqual(outcome.preview);
    // Still blocked on a second confirm; nothing runs.
    expect((await confirmAction(harness.db, { actionId }, realCtx)).status).toBe("needs_review");
    expect(await eventsOf(harness.db, "assistant.action_confirmed")).toHaveLength(0);
  };

  it("a merge undone elsewhere returns needs_review with a conflict block, not a raw error", async () => {
    const { from, into } = await twoNeeds(harness.db);
    const { mergeId } = await harness.db.transaction((tx) =>
      mergeNeedsInDb(tx, {
        actor: { kind: "human", ref: "web" },
        fromNeedId: from.id,
        intoNeedId: into.id,
        now: start,
      }),
    );
    const { actionId } = await proposeAction(
      harness.db,
      { input: { id: mergeId }, operation: "undo_merge" },
      realCtx,
    );
    await harness.db.transaction((tx) =>
      undoMergeInDb(tx, { actor: { kind: "human", ref: "web" }, mergeId, now: start }),
    );
    await expectStale(actionId, /already undone/u);
    expect(await eventsOf(harness.db, "merge.undone")).toHaveLength(1);
  });

  it("a need merged elsewhere first names the need by its statement, not its id", async () => {
    const { from, into } = await twoNeeds(harness.db);
    const { actionId } = await proposeAction(
      harness.db,
      { input: { id: from.id, intoNeedId: into.id }, operation: "merge_needs" },
      realCtx,
    );
    await harness.db.transaction((tx) =>
      mergeNeedsInDb(tx, {
        actor: { kind: "human", ref: "web" },
        fromNeedId: from.id,
        intoNeedId: into.id,
        now: start,
      }),
    );
    await expectStale(actionId, new RegExp(`“${from.statement}” is already merged`, "u"));
    expect(await eventsOf(harness.db, "need.merged")).toHaveLength(1);
  });
});

const request = (id: string, body?: unknown, authorized = true) =>
  new Request(`http://localhost/api/operator/assistant/actions/${id}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: authorized ? { authorization: `Bearer ${SECRET}` } : {},
    method: body === undefined ? "GET" : "POST",
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describeWithDatabase("assistant action routes", () => {
  const harness = useTestDatabase();
  // The routes use the registry; stub the test preview onto the real `merge_needs` (task 02
  // adds its own) and restore it after.
  const originalPreview = mergeNeeds.preview;

  beforeEach(async () => {
    await resetDatabase(harness.db);
    clock.current = new Date();
    vi.stubEnv("OPERATOR_SECRET", SECRET);
    vi.stubEnv("OPERATOR_ASSISTANT", "on");
    (mergeNeeds as AnyOperation).preview = mergePreview;
  });

  afterEach(() => {
    (mergeNeeds as AnyOperation).preview = originalPreview;
    vi.unstubAllEnvs();
  });

  const propose = async () => {
    const { from, into } = await twoNeeds(harness.db);
    const routeCtx: ActionContext = { ai: createFakeAi(), clock };
    return proposeAction(
      harness.db,
      { input: { id: from.id, intoNeedId: into.id }, operation: "merge_needs" },
      routeCtx,
    );
  };

  it("is unauthorized without Operator access", async () => {
    const { actionId } = await propose();
    expect((await GET(request(actionId, undefined, false), params(actionId))).status).toBe(401);
    const post = await POST(request(actionId, { decision: "confirm" }, false), params(actionId));
    expect(post.status).toBe(401);
    expect((await actionRow(harness.db, actionId)).status).toBe("proposed");
  });

  it("is not_found with the flag off", async () => {
    const { actionId } = await propose();
    vi.stubEnv("OPERATOR_ASSISTANT", "");
    const get = await GET(request(actionId), params(actionId));
    expect(get.status).toBe(404);
    expect(await get.json()).toMatchObject({ error: { code: "not_found" } });
    const post = await POST(request(actionId, { decision: "confirm" }), params(actionId));
    expect(post.status).toBe(404);
    expect((await actionRow(harness.db, actionId)).status).toBe("proposed");
  });

  it("GET shows the action; confirm runs it; a second confirm returns the stored result", async () => {
    const { actionId } = await propose();
    const get = await GET(request(actionId), params(actionId));
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({
      action: { edited: false, id: actionId, operation: "merge_needs", status: "proposed" },
    });

    const confirm = await POST(request(actionId, { decision: "confirm" }), params(actionId));
    expect(confirm.status).toBe(200);
    const body = (await confirm.json()) as { result: unknown; status: string };
    expect(body.status).toBe("confirmed");
    const again = await POST(request(actionId, { decision: "confirm" }), params(actionId));
    expect(await again.json()).toEqual(body);
    const merged = await harness.db
      .select()
      .from(events)
      .where(and(eq(events.type, "need.merged")));
    expect(merged).toHaveLength(1);
    expect(merged[0]!.payload).toMatchObject({ client: "console:assistant" });
  });

  it("reject answers rejected; then confirm is action_closed (409)", async () => {
    const { actionId } = await propose();
    const reject = await POST(request(actionId, { decision: "reject" }), params(actionId));
    expect(reject.status).toBe(200);
    expect(await reject.json()).toEqual({ status: "rejected" });
    const confirm = await POST(request(actionId, { decision: "confirm" }), params(actionId));
    expect(confirm.status).toBe(409);
    expect(await confirm.json()).toMatchObject({ error: { code: "action_closed" } });
  });

  it("rejects a malformed body and an unknown id with the error envelope", async () => {
    const { actionId } = await propose();
    const bad = await POST(request(actionId, { decision: "approve" }), params(actionId));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "validation_failed" } });
    const missing = "33333333-3333-4333-8333-333333333333";
    const notFound = await POST(request(missing, { decision: "confirm" }), params(missing));
    expect(notFound.status).toBe(404);
  });

  it("edits nested fields by their dotted editable path, and only those", async () => {
    const proposal = await proposeAction(
      harness.db,
      { input: { edit: { reason: "dupes", statement: "Old" } }, operation: "nested_edit" },
      ctx,
    );
    expect(
      await codeOf(
        confirmAction(
          harness.db,
          { actionId: proposal.actionId, input: { "edit.reason": "other" } },
          ctx,
        ),
      ),
    ).toBe("validation_failed");
    expect(
      await codeOf(
        confirmAction(
          harness.db,
          { actionId: proposal.actionId, input: { edit: { reason: "dupes", statement: "New" } } },
          ctx,
        ),
      ),
    ).toBe("validation_failed");
    const edited = { actionId: proposal.actionId, input: { "edit.statement": "New" } };
    expect(await confirmAction(harness.db, edited, ctx)).toMatchObject({ status: "needs_review" });
    expect(await confirmAction(harness.db, { actionId: proposal.actionId }, ctx)).toMatchObject({
      result: { statement: "New" },
      status: "confirmed",
    });
    expect((await actionRow(harness.db, proposal.actionId)).input).toEqual({
      edit: { reason: "dupes", statement: "New" },
    });
  });
});
