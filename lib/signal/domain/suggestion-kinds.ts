import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { needs, suggestions, themes } from "@/lib/db/schema";

import type { SignalQueryable, SignalTx } from "../db";
import { SignalError } from "../errors";
import { applyDecisionBriefSuggestion, decisionBriefEditSchema } from "./decisions";
import { mergeNeeds, previewMerge } from "./merges";
import { applyPrioritySuggestion, priorityEditSchema } from "./priority";
import { previewSplit, splitNeed } from "./splits";
import { defineSuggestionKind } from "./suggestion-types";
import type { SuggestionKind, SuggestionKindHandler, SuggestionRow } from "./suggestion-types";

/**
 * What accepting, editing, or rejecting each suggestion kind does (see `suggestion-types.ts`).
 * Task 04 owns draft_need, merge, theme, public_summary, and split. Other kinds (task 05's
 * `priority` and `decision_brief`) plug in by adding one entry to `suggestionKindHandlers`.
 * Each kind's `preview` (spec 014) reads what `apply` would do and throws the codes it would.
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

type NeedRow = typeof needs.$inferSelect;

const liveNeed = (need: NeedRow | undefined, needId: string) => {
  if (!need) throw new SignalError("not_found", `No need with id ${needId}.`);
  if (need.status === "merged")
    throw new SignalError("conflict", `Need ${needId} was merged into ${need.mergedIntoId}.`);
  return need;
};

const lockLiveNeed = async (tx: SignalTx, needId: string) => {
  const [need] = await tx.select().from(needs).where(eq(needs.id, needId)).for("update");
  return liveNeed(need, needId);
};

/** Unlocked `lockLiveNeed` for previews. */
const readLiveNeed = async (db: SignalQueryable, needId: string) => {
  const [need] = await db.select().from(needs).where(eq(needs.id, needId));
  return liveNeed(need, needId);
};

const subjectRef = (need: { id: string; statement: string }) => ({
  id: need.id,
  role: "subject" as const,
  statement: need.statement,
});

const draftNeedPayload = z.object({ statement: z.string().optional() });

const stillDraft = (need: NeedRow) => {
  if (need.status !== "draft")
    throw new SignalError("conflict", `Need ${need.id} is not a draft any more.`);
  return need;
};

/** Approve a draft need, optionally rewording it. */
const draftNeed = defineSuggestionKind({
  async apply({ edit, now, suggestion, tx }) {
    const payload = payloadOf(draftNeedPayload, suggestion);
    const need = stillDraft(await lockLiveNeed(tx, subjectNeedId(suggestion)));
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
  async preview({ db, edit, suggestion }) {
    const payload = payloadOf(draftNeedPayload, suggestion);
    const need = stillDraft(await readLiveNeed(db, subjectNeedId(suggestion)));
    return {
      lines: [{ label: "Need status after", value: "open" }],
      needs: [subjectRef(need)],
      text: edit?.statement ?? payload.statement?.trim() ?? need.statement,
    };
  },
});

const mergeTarget = (suggestion: SuggestionRow, edit: { intoNeedId: string } | undefined) => {
  const payload = payloadOf(z.object({ intoNeedId: z.uuid().optional() }), suggestion);
  const intoNeedId = edit?.intoNeedId ?? payload.intoNeedId ?? suggestion.relatedNeedId;
  if (!intoNeedId)
    throw new SignalError("conflict", `Suggestion ${suggestion.id} has no merge target.`);
  return intoNeedId;
};

/** Merge the subject need into the proposed (or edited) target. */
const merge = defineSuggestionKind({
  async apply({ actor, edit, now, suggestion, tx }) {
    const result = await mergeNeeds(tx, {
      actor,
      fromNeedId: subjectNeedId(suggestion),
      intoNeedId: mergeTarget(suggestion, edit),
      now,
    });
    return { result };
  },
  edit: z.object({ intoNeedId: z.uuid() }),
  async preview({ db, edit, suggestion }) {
    const effect = await previewMerge(db, {
      fromNeedId: subjectNeedId(suggestion),
      intoNeedId: mergeTarget(suggestion, edit),
    });
    return {
      lines: [
        { label: "Signals moving", value: String(effect.signalsMoving) },
        { label: "People after", value: String(effect.peopleAfter) },
      ],
      needs: [
        { id: effect.from.id, role: "source", statement: effect.from.statement },
        { id: effect.into.id, role: "target", statement: effect.into.statement },
      ],
      text: `Merge into: ${effect.into.statement}`,
    };
  },
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
interface ThemeChoice {
  themeDescription?: string | null;
  themeId?: string | null;
  themeName?: string | null;
}

/** The theme an accept (the payload) or an edit chooses. */
const themeChoice = (suggestion: SuggestionRow, edit: ThemeChoice | undefined): ThemeChoice => {
  if (edit) return edit;
  const payload = payloadOf(
    z.object({
      themeDescription: z.string().nullish(),
      themeId: z.uuid().nullish(),
      themeName: z.string().nullish(),
    }),
    suggestion,
  );
  return { ...payload, themeId: payload.themeId ?? suggestion.themeId };
};

const themeById = async (db: SignalQueryable, themeId: string) => {
  const [found] = await db.select().from(themes).where(eq(themes.id, themeId));
  if (!found) throw new SignalError("not_found", `No theme with id ${themeId}.`);
  return found;
};

const themeByName = async (db: SignalQueryable, name: string) => {
  const [existing] = await db
    .select()
    .from(themes)
    .where(sql`lower(${themes.name}) = lower(${name})`);
  return existing;
};

const choiceName = (choice: ThemeChoice) => {
  const name = choice.themeName?.trim();
  if (!name) throw new SignalError("conflict", "The theme suggestion names no theme.");
  return name;
};

/** An existing theme by id, or one found (case-insensitively) or created by name. */
const resolveTheme = async (tx: SignalTx, choice: ThemeChoice) => {
  if (choice.themeId) return themeById(tx, choice.themeId);
  const name = choiceName(choice);
  const existing = await themeByName(tx, name);
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
    const choice = themeChoice(suggestion, edit);
    const need = await lockLiveNeed(tx, subjectNeedId(suggestion));
    const chosen = await resolveTheme(tx, choice);
    await tx.update(needs).set({ themeId: chosen.id }).where(eq(needs.id, need.id));
    return { result: { needId: need.id, themeId: chosen.id, themeName: chosen.name } };
  },
  edit: themeEdit,
  async preview({ db, edit, suggestion }) {
    const choice = themeChoice(suggestion, edit);
    const need = await readLiveNeed(db, subjectNeedId(suggestion));
    if (choice.themeId) {
      const found = await themeById(db, choice.themeId);
      return { lines: [], needs: [subjectRef(need)], text: `Theme: ${found.name}` };
    }
    const name = choiceName(choice);
    const existing = await themeByName(db, name);
    return {
      lines: existing ? [] : [{ label: "New theme", value: name }],
      needs: [subjectRef(need)],
      text: `Theme: ${existing?.name ?? name}`,
    };
  },
});

const summaryPayload = z.object({ summary: z.string().trim().min(1) });

/** Approve (possibly edited) anonymized text; only approved summaries are ever public. */
const publicSummary = defineSuggestionKind({
  async apply({ edit, suggestion, tx }) {
    const payload = payloadOf(summaryPayload, suggestion);
    const need = await lockLiveNeed(tx, subjectNeedId(suggestion));
    const text = edit?.summary ?? payload.summary;
    await tx
      .update(needs)
      .set({ publicSummary: text, publicSummaryStatus: "approved" })
      .where(eq(needs.id, need.id));
    return { result: { needId: need.id, publicSummary: text, publicSummaryStatus: "approved" } };
  },
  edit: z.object({ summary: z.string().trim().min(1).max(1000) }),
  async preview({ db, edit, suggestion }) {
    const payload = payloadOf(summaryPayload, suggestion);
    const need = await readLiveNeed(db, subjectNeedId(suggestion));
    return {
      lines: [{ label: "Public summary", value: "approved" }],
      needs: [subjectRef(need)],
      text: edit?.summary ?? payload.summary,
    };
  },
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

/** The split an accept (the payload) or an edit would perform. */
const splitPlan = (
  suggestion: SuggestionRow,
  edit: { signalIds?: string[]; statement: string } | undefined,
) => {
  const payload = payloadOf(
    z.object({ signalIds: z.array(z.uuid()).optional(), statement: z.string().optional() }),
    suggestion,
  );
  const text = edit?.statement ?? payload.statement;
  if (!text) throw new SignalError("conflict", `Suggestion ${suggestion.id} has no statement.`);
  return {
    needId: subjectNeedId(suggestion),
    signalIds: edit?.signalIds ?? payload.signalIds ?? suggestion.signalIds,
    statement: text,
  };
};

/** Split the proposed signals into a new need. */
const split = defineSuggestionKind({
  async apply({ actor, edit, now, suggestion, tx }) {
    const result = await splitNeed(tx, { actor, now, ...splitPlan(suggestion, edit) });
    return { embedNeedIds: [result.needId], result };
  },
  edit: z.object({ signalIds: z.array(z.uuid()).min(1).optional(), statement }),
  async preview({ db, edit, suggestion }) {
    const effect = await previewSplit(db, splitPlan(suggestion, edit));
    return {
      lines: [{ label: "Signals leaving", value: String(effect.leaving) }],
      needs: [subjectRef(effect.source)],
      text: effect.statement,
    };
  },
});

/** Task 05: store the scores (PM-set ones with source `pm`). */
const priority = defineSuggestionKind({
  async apply({ edit, now, suggestion, tx }) {
    return { result: await applyPrioritySuggestion(tx, { edit, now, suggestion }) };
  },
  edit: priorityEditSchema,
  async preview({ db, edit, suggestion }) {
    const need = await readLiveNeed(db, subjectNeedId(suggestion));
    const proposed = z
      .object({ scores: z.record(z.string(), z.number()) })
      .safeParse(suggestion.payload);
    const scores = { ...(proposed.success ? proposed.data.scores : {}), ...edit?.scores };
    return {
      lines: [],
      needs: [subjectRef(need)],
      text: Object.entries(scores)
        .map(([criterion, score]) => `${criterion} ${score}`)
        .join(", "),
    };
  },
});

/** Task 05: a brief is advice; an edit replaces its markdown. `publish_decision` publishes. */
const decisionBrief = defineSuggestionKind({
  async apply({ edit, suggestion, tx }) {
    return { result: await applyDecisionBriefSuggestion(tx, { edit, suggestion }) };
  },
  edit: decisionBriefEditSchema,
  async preview({ db, edit, suggestion }) {
    const [need] = await db
      .select()
      .from(needs)
      .where(eq(needs.id, subjectNeedId(suggestion)));
    const { markdown } = suggestion.payload;
    return {
      lines: [],
      needs: need ? [subjectRef(need)] : [],
      text: edit?.markdown ?? (typeof markdown === "string" ? markdown : ""),
    };
  },
});

/** Handlers by kind; a new kind adds one entry. */
export const suggestionKindHandlers: Partial<Record<SuggestionKind, SuggestionKindHandler>> = {
  decision_brief: decisionBrief,
  draft_need: draftNeed,
  merge,
  priority,
  public_summary: publicSummary,
  split,
  theme,
};

/**
 * The free-text field an `edit` changes, by kind (a dotted path into the `resolve_suggestion`
 * input); the assistant's action card shows it as editable.
 */
export const suggestionEditableText: Partial<
  Record<SuggestionKind, { key: string; kind: "text" | "longtext"; label: string }>
> = {
  decision_brief: { key: "edit.markdown", kind: "longtext", label: "Brief" },
  draft_need: { key: "edit.statement", kind: "text", label: "Statement" },
  public_summary: { key: "edit.summary", kind: "longtext", label: "Public summary" },
  split: { key: "edit.statement", kind: "text", label: "New need statement" },
};
