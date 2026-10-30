import { desc, inArray } from "drizzle-orm";
import { z } from "zod";

import { strategies, themes } from "@/lib/db/schema";

import type { Actor } from "../context";
import type { SignalQueryable } from "../db";
import { SignalError } from "../errors";
import { formatCents } from "./need-facts";

/**
 * The PM's strategy (spec 007 → Strategy): focus themes, a revenue focus, quarterly capacity, and
 * the readiness line. Append-only: every `setStrategy` stores a new version and the current
 * strategy is the highest version. Priority scoring and decision briefs read `getStrategy`;
 * readiness uses `readinessLine`, which falls back to `DEFAULT_READINESS` when none is written.
 */

export const readinessSchema = z.object({
  /** Distinct supporting accounts' ARR, in cents, at or above which a need is ready. 0 = unused. */
  readinessArrCents: z.number().int().nonnegative(),
  /** Distinct supporters at or above which a need is ready. 0 = unused. */
  readinessSupporters: z.number().int().nonnegative(),
});
export type Readiness = z.infer<typeof readinessSchema>;

/** Used when no strategy is written: $250k ARR or 5 supporters (sized to the seeded workspace). */
export const DEFAULT_READINESS: Readiness = {
  readinessArrCents: 25_000_000,
  readinessSupporters: 5,
};

export const strategyInputSchema = z
  .object({
    capacityPerQuarter: z.number().int().nonnegative().max(1000),
    focusThemeIds: z.array(z.uuid()).max(50),
    notes: z.string().trim().max(4000).optional(),
    revenueFocus: z.string().trim().max(500),
  })
  .extend(readinessSchema.shape)
  .refine((s) => s.readinessArrCents > 0 || s.readinessSupporters > 0, {
    message: "Set at least one readiness threshold above 0.",
    path: ["readinessArrCents"],
  });
type StrategyInput = z.infer<typeof strategyInputSchema>;

export const strategySchema = z.object({
  capacityPerQuarter: z.number().int(),
  createdAt: z.iso.datetime({ offset: true }),
  focusThemes: z.array(z.object({ id: z.uuid(), name: z.string() })),
  notes: z.string().nullable(),
  readinessArrCents: z.number().int(),
  readinessSupporters: z.number().int(),
  revenueFocus: z.string(),
  version: z.number().int().positive(),
});
export type Strategy = z.infer<typeof strategySchema>;

/** The current strategy, or null when none is written. */
export const getStrategy = async (db: SignalQueryable): Promise<Strategy | null> => {
  const [row] = await db.select().from(strategies).orderBy(desc(strategies.version)).limit(1);
  if (!row) return null;
  const focus =
    row.focusThemeIds.length === 0
      ? []
      : await db
          .select({ id: themes.id, name: themes.name })
          .from(themes)
          .where(inArray(themes.id, row.focusThemeIds));
  const names = new Map(focus.map((t) => [t.id, t.name]));
  return {
    capacityPerQuarter: row.capacityPerQuarter,
    createdAt: row.createdAt.toISOString(),
    focusThemes: row.focusThemeIds.flatMap((id) => {
      const name = names.get(id);
      return name ? [{ id, name }] : [];
    }),
    notes: row.notes,
    readinessArrCents: row.readinessArrCents,
    readinessSupporters: row.readinessSupporters,
    revenueFocus: row.revenueFocus,
    version: row.version,
  };
};

/** The readiness line in force: the current strategy's, else the default. */
export const readinessLine = (strategy: Strategy | null): Readiness =>
  strategy
    ? {
        readinessArrCents: strategy.readinessArrCents,
        readinessSupporters: strategy.readinessSupporters,
      }
    : DEFAULT_READINESS;

/** The distinct focus themes, in input order; unknown theme ids are `validation_failed`. */
const knownFocusThemes = async (db: SignalQueryable, ids: string[]) => {
  const focusThemeIds = [...new Set(ids)];
  const found =
    focusThemeIds.length === 0
      ? []
      : await db
          .select({ id: themes.id, name: themes.name })
          .from(themes)
          .where(inArray(themes.id, focusThemeIds));
  const names = new Map(found.map((t) => [t.id, t.name]));
  const unknown = focusThemeIds.filter((id) => !names.has(id));
  if (unknown.length > 0)
    throw new SignalError("validation_failed", `Unknown theme ids: ${unknown.join(", ")}.`);
  return { focusThemeIds, names: focusThemeIds.map((id) => names.get(id) ?? id) };
};

/** Stores a new strategy version; unknown theme ids are `validation_failed`. */
export const setStrategy = async (
  db: SignalQueryable,
  actor: Actor,
  input: StrategyInput,
  now: Date,
): Promise<Strategy> => {
  const { focusThemeIds } = await knownFocusThemes(db, input.focusThemeIds);
  const [latest] = await db
    .select({ version: strategies.version })
    .from(strategies)
    .orderBy(desc(strategies.version))
    .limit(1);
  await db.insert(strategies).values({
    capacityPerQuarter: input.capacityPerQuarter,
    createdAt: now,
    createdByKind: actor.kind,
    focusThemeIds,
    notes: input.notes ?? null,
    readinessArrCents: input.readinessArrCents,
    readinessSupporters: input.readinessSupporters,
    revenueFocus: input.revenueFocus,
    version: (latest?.version ?? 0) + 1,
  });
  const stored = await getStrategy(db);
  if (!stored) throw new Error("Strategy insert returned no row.");
  return stored;
};

/** The strategy as prompt text for briefs and priority scoring. */
export const describeStrategy = (strategy: Strategy | null) => {
  if (!strategy) return "Strategy: none written yet; say so and judge on demand and value only.";
  const themesLine = strategy.focusThemes.map((t) => t.name).join(", ") || "(none)";
  return [
    `Strategy (version ${strategy.version}):`,
    `- Focus themes: ${themesLine}`,
    `- Revenue focus: ${strategy.revenueFocus || "(none)"}`,
    `- Capacity: ${strategy.capacityPerQuarter} needs per quarter`,
    ...(strategy.notes ? [`- Notes: ${strategy.notes}`] : []),
  ].join("\n");
};

/**
 * The fields `setStrategy` would change, read-only (spec 014 previews), as display strings
 * before → after; with no strategy written, "before" is the default readiness line and "(none)"
 * elsewhere. Unknown theme ids are `validation_failed`, as for `setStrategy`.
 */
export const strategyChanges = async (db: SignalQueryable, input: StrategyInput) => {
  const { names } = await knownFocusThemes(db, input.focusThemeIds);
  const current = await getStrategy(db);
  const line = readinessLine(current);
  const none = "(none)";
  const fields = [
    {
      after: names.join(", ") || none,
      before: current ? current.focusThemes.map((t) => t.name).join(", ") || none : none,
      label: "Focus themes",
    },
    {
      after: input.revenueFocus || none,
      before: current?.revenueFocus || none,
      label: "Revenue focus",
    },
    {
      after: String(input.capacityPerQuarter),
      before: current ? String(current.capacityPerQuarter) : none,
      label: "Capacity per quarter",
    },
    {
      after: formatCents(input.readinessArrCents),
      before: formatCents(line.readinessArrCents),
      label: "Readiness ARR",
    },
    {
      after: String(input.readinessSupporters),
      before: String(line.readinessSupporters),
      label: "Readiness supporters",
    },
    { after: input.notes || none, before: current?.notes || none, label: "Notes" },
  ];
  return { changed: fields.filter((field) => field.after !== field.before), current };
};
