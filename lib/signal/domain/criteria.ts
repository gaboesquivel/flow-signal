import { asc, sql } from "drizzle-orm";
import { z } from "zod";

import { priorityCriteria } from "@/lib/db/schema";

import type { SignalQueryable } from "../db";

/**
 * Priority criteria (spec 001 → get_criteria / set_criteria). A need's priority score is the
 * weighted sum of its per-criterion scores (0–5) with weights that sum to 1, so it is 0–5 too.
 */

export const criterionKeys = ["demand", "business_value", "strategic_fit", "effort"] as const;
export const criterionKeySchema = z.enum(criterionKeys);
export type CriterionKey = z.infer<typeof criterionKeySchema>;

/** Used when no criteria were set yet (and for descriptions the table lacks). */
export const defaultCriteria: readonly {
  description: string;
  key: CriterionKey;
  weight: number;
}[] = [
  { description: "Supporters, weighted by account.", key: "demand", weight: 0.35 },
  {
    description: "Revenue of requesting accounts and open deals.",
    key: "business_value",
    weight: 0.3,
  },
  { description: "Match to PM-set themes.", key: "strategic_fit", weight: 0.2 },
  { description: "Rough effort estimate (5 = small).", key: "effort", weight: 0.15 },
];

/** Weights are stored as `real`; report them rounded so 0.35 reads back as 0.35. */
const roundWeight = (value: number) => Math.round(value * 1e6) / 1e6;
const SUM_TOLERANCE = 1e-6;

const weightSchema = z.number().min(0).max(1);

/** Every criterion key, each weight 0–1, summing to 1; unknown keys are rejected. */
export const criteriaWeightsSchema = z
  .strictObject({
    business_value: weightSchema,
    demand: weightSchema,
    effort: weightSchema,
    strategic_fit: weightSchema,
  })
  .refine(
    (weights) =>
      Math.abs(Object.values(weights).reduce((sum, weight) => sum + weight, 0) - 1) <=
      SUM_TOLERANCE,
    { message: "Weights must sum to 1." },
  );
type CriteriaWeights = z.infer<typeof criteriaWeightsSchema>;

export const criteriaOutputSchema = z.object({
  criteria: z.array(
    z.object({
      description: z.string(),
      key: criterionKeySchema,
      weight: z.number().min(0).max(1),
    }),
  ),
});
type CriteriaOutput = z.infer<typeof criteriaOutputSchema>;

const order = (key: CriterionKey) => criterionKeys.indexOf(key);

export const readCriteria = async (db: SignalQueryable): Promise<CriteriaOutput> => {
  const rows = await db.select().from(priorityCriteria).orderBy(asc(priorityCriteria.key));
  if (rows.length === 0) return { criteria: defaultCriteria.map((row) => ({ ...row })) };
  const defaults = new Map(defaultCriteria.map((row) => [row.key, row]));
  return {
    criteria: rows
      .map((row) => ({
        description: row.description || defaults.get(row.key)?.description || "",
        key: row.key,
        weight: roundWeight(row.weight),
      }))
      .toSorted((left, right) => order(left.key) - order(right.key)),
  };
};

/** Replaces every weight (the caller validated them with `criteriaWeightsSchema`). */
export const writeCriteria = async (db: SignalQueryable, weights: CriteriaWeights) => {
  const { criteria } = await readCriteria(db);
  const current = new Map(criteria.map((row) => [row.key, row]));
  await db
    .insert(priorityCriteria)
    .values(
      criterionKeys.map((key) => ({
        description: current.get(key)?.description ?? "",
        key,
        weight: weights[key],
      })),
    )
    .onConflictDoUpdate({
      set: { weight: sql`excluded.weight` },
      target: priorityCriteria.key,
    });
  return readCriteria(db);
};
