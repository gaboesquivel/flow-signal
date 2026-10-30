import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { needs, suggestions, themes } from "@/lib/db/schema";

import type { SignalTx } from "../db";
import { SignalError } from "../errors";
import { mergeNeeds } from "./merges";
import { splitNeed } from "./splits";
import { defineSuggestionKind } from "./suggestion-types";
import type { SuggestionKind, SuggestionKindHandler, SuggestionRow } from "./suggestion-types";

/**
 * What accepting, editing, or rejecting each suggestion kind does (see `suggestion-types.ts`).
 * Task 04 owns draft_need, merge, theme, public_summary, and split. Other kinds (task 05's
 * `priority` and `decision_brief`) plug in by adding one entry to `suggestionKindHandlers`.
 */

const statement = z.string().trim().min(10).max(500);

/** Reads a kind's payload; a malformed one cannot be applied. */
const payloadOf = <T>(schema: z.ZodType<T>, suggestion: SuggestionRow) => {
  const parsed = schema.safeParse(suggestion.payload);
  if (!parsed.success)
    throw new SignalError("conflict", `Suggestion ${suggestion.id} has an invalid payload.`);
  return parsed.data;
};

const subjectNeedId = (suggestion: SuggestionRow) => {
  if (!suggestion.needId)
    throw new SignalError("conflict", `Suggestion ${suggestion.id} has no need.`);
  return suggestion.needId;
};

const lockLiveNeed = async (tx: SignalTx, needId: string) => {
  const [need] = await tx.select().from(needs).where(eq(needs.id, needId)).for("update");
  if (!need) throw new SignalError("not_found", `No need with id ${needId}.`);
  if (need.status === "merged")
    throw new SignalError("conflict", `Need ${needId} was merged into ${need.mergedIntoId}.`);
  return need;
};

/** Approve a draft need, optionally rewording it. */
const draftNeed = defineSuggestionKind({
  async apply({ edit, now, suggestion, tx }) {
    const payload = payloadOf(z.object({ statement: z.string().optional() }), suggestion);
    const need = await lockLiveNeed(tx, subjectNeedId(suggestion));
    if (need.status !== "draft")
      throw new SignalError("conflict", `Need ${need.id} is not a draft any more.`);
    const text = edit?.statement ?? payload.statement?.trim() ?? need.statement;
    await tx
      .update(needs)
      .set({ approvedAt: now, statement: text, status: "open" })
      .where(eq(needs.id, need.id));
    return {
      embedNeedIds: text === need.statement ? [] : [need.id],
      result: { needId: need.id, statement: text, status: "open" },
    };
  },
  edit: z.object({ statement }),
});

/** Merge the subject need into the proposed (or edited) target. */
const merge = defineSuggestionKind({
  async apply({ actor, edit, now, suggestion, tx }) {
    const payload = payloadOf(z.object({ intoNeedId: z.uuid().optional() }), suggestion);
    const intoNeedId = edit?.intoNeedId ?? payload.intoNeedId ?? suggestion.relatedNeedId;
    if (!intoNeedId)
      throw new SignalError("conflict", `Suggestion ${suggestion.id} has no merge target.`);
    const result = await mergeNeeds(tx, {
      actor,
      fromNeedId: subjectNeedId(suggestion),
      intoNeedId,
      now,
    });
    return { result };
  },
  edit: z.object({ intoNeedId: z.uuid() }),
});

const themeEdit = z
  .object({
    themeDescription: z.string().trim().max(500).optional(),
    themeId: z.uuid().optional(),
    themeName: z.string().trim().min(2).max(80).optional(),
  })
  .refine((edit) => Boolean(edit.themeId) !== Boolean(edit.themeName), {
    message: "Give either themeId or themeName.",
  });

/** An existing theme by id, or one found (case-insensitively) or created by name. */
const resolveTheme = async (
  tx: SignalTx,
  choice: { themeDescription?: string | null; themeId?: string | null; themeName?: string | null },
) => {
  if (choice.themeId) {
    const [theme] = await tx.select().from(themes).where(eq(themes.id, choice.themeId));
    if (!theme) throw new SignalError("not_found", `No theme with id ${choice.themeId}.`);
    return theme;
  }
  const name = choice.themeName?.trim();
  if (!name) throw new SignalError("conflict", "The theme suggestion names no theme.");
  const [existing] = await tx
    .select()
    .from(themes)
    .where(sql`lower(${themes.name}) = lower(${name})`);
  if (existing) return existing;
  const [created] = await tx
    .insert(themes)
    .values({ description: choice.themeDescription?.trim() ?? "", name })
    .returning();
  if (!created) throw new Error("Theme insert returned no row.");
  return created;
};

/** Put the need in a theme (existing, or a new one the model or PM named). */
const theme = defineSuggestionKind({
  async apply({ edit, suggestion, tx }) {
    const payload = payloadOf(
      z.object({
        themeDescription: z.string().nullish(),
        themeId: z.uuid().nullish(),
        themeName: z.string().nullish(),
      }),
      suggestion,
    );
    const need = await lockLiveNeed(tx, subjectNeedId(suggestion));
    const chosen = await resolveTheme(
      tx,
      edit ?? { ...payload, themeId: payload.themeId ?? suggestion.themeId },
    );
    await tx.update(needs).set({ themeId: chosen.id }).where(eq(needs.id, need.id));
    return { result: { needId: need.id, themeId: chosen.id, themeName: chosen.name } };
  },
  edit: themeEdit,
});

/** Approve (possibly edited) anonymized text; only approved summaries are ever public. */
const publicSummary = defineSuggestionKind({
  async apply({ edit, suggestion, tx }) {
    const payload = payloadOf(z.object({ summary: z.string().trim().min(1) }), suggestion);
    const need = await lockLiveNeed(tx, subjectNeedId(suggestion));
    const text = edit?.summary ?? payload.summary;
    await tx
      .update(needs)
      .set({ publicSummary: text, publicSummaryStatus: "approved" })
      .where(eq(needs.id, need.id));
    return { result: { needId: need.id, publicSummary: text, publicSummaryStatus: "approved" } };
  },
  edit: z.object({ summary: z.string().trim().min(1).max(1000) }),
  async reject({ suggestion, tx }) {
    const needId = subjectNeedId(suggestion);
    const [need] = await tx.select().from(needs).where(eq(needs.id, needId)).for("update");
    if (need?.publicSummaryStatus !== "pending") return;
    const [other] = await tx
      .select({ id: suggestions.id })
      .from(suggestions)
      .where(
        and(
          eq(suggestions.needId, needId),
          eq(suggestions.kind, "public_summary"),
          eq(suggestions.status, "pending"),
          ne(suggestions.id, suggestion.id),
        ),
      )
      .limit(1);
    if (other) return;
    await tx
      .update(needs)
      .set({ publicSummary: null, publicSummaryStatus: "none" })
      .where(eq(needs.id, needId));
  },
});

/** Split the proposed signals into a new need. */
const split = defineSuggestionKind({
  async apply({ actor, edit, now, suggestion, tx }) {
    const payload = payloadOf(
      z.object({ signalIds: z.array(z.uuid()).optional(), statement: z.string().optional() }),
      suggestion,
    );
    const text = edit?.statement ?? payload.statement;
    if (!text) throw new SignalError("conflict", `Suggestion ${suggestion.id} has no statement.`);
    const result = await splitNeed(tx, {
      actor,
      needId: subjectNeedId(suggestion),
      now,
      signalIds: edit?.signalIds ?? payload.signalIds ?? suggestion.signalIds,
      statement: text,
    });
    return { embedNeedIds: [result.needId], result };
  },
  edit: z.object({ signalIds: z.array(z.uuid()).min(1).optional(), statement }),
});

/** Handlers by kind. Task 05: add `priority` and `decision_brief` here. */
export const suggestionKindHandlers: Partial<Record<SuggestionKind, SuggestionKindHandler>> = {
  draft_need: draftNeed,
  merge,
  public_summary: publicSummary,
  split,
  theme,
};
