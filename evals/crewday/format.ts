import { z } from "zod";

/**
 * The Crewday world format (spec 004 → The worlds, task 01). The recipe is hand-written under
 * `evals/crewday/recipe/`; a generated world is frozen under `evals/crewday/worlds/<name>/<version>/`
 * and carries the recipe's themes, accounts, needs, and backlog plus personas and labeled signals.
 * These schemas check shape only; cross-references and ordering are checked in `./checks`.
 */

const key = z.string().trim().min(1);
const month = z.number().int().min(0).max(11);

export const themeSchema = z.object({
  description: z.string().min(1),
  key,
  name: z.string().min(1),
  /** How much Crewday's strategy memo favours the theme, 0–1. */
  strategicWeight: z.number().min(0).max(1),
});
export type Theme = z.infer<typeof themeSchema>;

export const accountSchema = z.object({
  arrCents: z.number().int().nonnegative(),
  churnRisk: z.boolean(),
  domain: z.string().min(1),
  key,
  name: z.string().min(1),
  openDealCents: z.number().int().nonnegative(),
  plan: z.enum(["Starter", "Growth", "Enterprise"]),
});
export type Account = z.infer<typeof accountSchema>;

export const arrivalCurves = ["steady", "burst", "seasonal", "late"] as const;
export const trapKinds = ["shared_solution", "near_neighbour", "split", "symptom_only"] as const;
export type TrapKind = (typeof trapKinds)[number];

export const needSchema = z.object({
  /** When signals for the need arrive over the year (month 0 is the world's first month). */
  arrival: z.object({
    curve: z.enum(arrivalCurves),
    peakMonth: month.optional(),
    startMonth: month.optional(),
    weight: z.number().positive(),
  }),
  inBacklog: z.boolean(),
  key,
  outcome: z.string().min(1),
  problem: z.string().min(1),
  requesterAccounts: z.array(key),
  /** 3–6 concrete work situations the generator writes signals from; never the statement's wording. */
  scenarios: z.array(z.string().min(1)).min(3).max(6),
  solutions: z.array(z.string().min(1)),
  /** Child need keys, only on a `split` trap. */
  splitInto: z.array(key).optional(),
  statement: z.string().min(1),
  /** The decision Crewday's strategy memo implies, and the month it should be made by. */
  strategyDecision: z.object({ byMonth: month, status: z.enum(["planned", "declined"]) }),
  themeKey: key,
  /** Deliberate hard case; every need in a `group` belongs to one world. */
  trap: z.object({ group: key, kind: z.enum(trapKinds) }).optional(),
  /** 1 is the highest; unique within a world. */
  truePriority: z.number().int().positive(),
  who: z.string().min(1),
});
export type Need = z.infer<typeof needSchema>;

/** A row of Crewday's migrated spreadsheet backlog, loaded as an approved need on day 0. */
export const backlogRowSchema = z.object({
  body: z.string(),
  rowId: key,
  title: z.string().min(1),
  trueNeedKey: key,
});
export type BacklogRow = z.infer<typeof backlogRowSchema>;

export const channels = ["web", "mcp"] as const;
export type Channel = (typeof channels)[number];

export const personaMixSchema = z.object({
  count: z.number().int().positive(),
  roles: z
    .array(
      z.object({
        channel: z.enum(channels),
        role: z.string().min(1),
        share: z.number().min(0).max(1),
        writingStyle: z.string().min(1),
      }),
    )
    .min(1),
});
export type PersonaMix = z.infer<typeof personaMixSchema>;

export const personaSchema = z.object({
  accountKey: key,
  actorKind: z.enum(["human", "agent"]),
  channel: z.enum(channels),
  email: z.email(),
  key,
  name: z.string().min(1),
  role: z.string().min(1),
});
export type Persona = z.infer<typeof personaSchema>;

/**
 * Hidden labels, attached by construction before the text exists.
 * - `paraphrase`: an existing need in other words.
 * - `multi_ask`: two asks in one signal (two `needKeys`, the main ask first).
 * - `new`: a need not yet in the workspace when the signal arrives.
 * - `symptom`: describes only what goes wrong, never the need or a solution.
 * - `same_solution`: names a solution another need also lists; the true need is the label.
 *
 * `firstOccurrence`: the first counted signal labeled with its main need. `existedAtTime`: the main
 * need was in the backlog or already raised by an earlier counted signal (for a `split` trap's
 * child, its parent counts). See `checkWorld` for the exact rules.
 */
export const signalKinds = ["paraphrase", "multi_ask", "new", "symptom", "same_solution"] as const;
export type SignalKind = (typeof signalKinds)[number];

/**
 * Planted cases: `pii` (identifying details listed in `pii` appear in the body and must never
 * reach a public summary), `retry` (the same submission sent again with the same idempotency key;
 * `retryOf` is the original), `invalid` (fails `submit_signal` validation and must not count).
 */
export const plantedKinds = ["pii", "retry", "invalid"] as const;

export const signalSchema = z.object({
  accountKey: key,
  actorKind: z.enum(["human", "agent"]),
  at: z.iso.datetime({ offset: true }),
  /** Unchecked here: a planted `invalid` signal may break `submit_signal`'s limits on purpose. */
  body: z.string(),
  channel: z.enum(channels),
  id: key,
  labels: z.object({
    existedAtTime: z.boolean(),
    firstOccurrence: z.boolean(),
    kind: z.enum(signalKinds),
    needKeys: z.array(key).min(1).max(2),
  }),
  personaKey: key,
  pii: z.array(z.string().min(1)).optional(),
  planted: z.enum(plantedKinds).optional(),
  retryOf: key.optional(),
  title: z.string(),
  urgency: z.enum(["low", "medium", "high"]),
  useCase: z.string().nullable(),
});
export type WorldSignal = z.infer<typeof signalSchema>;

export const manifestSchema = z.object({
  generatedAt: z.iso.datetime({ offset: true }),
  generator: z.object({
    models: z.record(z.string(), z.string()),
    promptsHash: z.string().optional(),
    seeds: z.record(z.string(), z.number()),
  }),
  /** Leakage check (spec 004 → Generation, step 3); null when not measured (the fixture world). */
  keywordFindableShare: z.number().min(0).max(1).nullable(),
  review: z
    .object({
      dropped: z.number().int().nonnegative(),
      fixed: z.number().int().nonnegative(),
      method: z.string().min(1),
      notes: z.string().optional(),
      reviewer: z.string().min(1),
      sampleSize: z.number().int().nonnegative(),
    })
    .nullable(),
  /**
   * First instant of the world's 12 months (month 0). Optional; defaults to the start of the UTC
   * month of the earliest signal.
   */
  startsAt: z.iso.datetime({ offset: true }).optional(),
  version: key,
  world: key,
});
export type Manifest = z.infer<typeof manifestSchema>;

export const recipeWorldNames = ["dev", "test"] as const;
export type RecipeWorldName = (typeof recipeWorldNames)[number];
export type WorldName = RecipeWorldName | "fixture";

export interface Recipe {
  accounts: Account[];
  backlog: BacklogRow[];
  /** `company.md`, prose. */
  company: string;
  needs: Need[];
  personaMix: PersonaMix;
  /** `strategy.md`, the hidden strategy memo. */
  strategy: string;
  themes: Theme[];
  world: RecipeWorldName;
}

export interface World {
  accounts: Account[];
  backlog: BacklogRow[];
  manifest: Manifest;
  needs: Need[];
  personas: Persona[];
  signals: WorldSignal[];
  themes: Theme[];
}

/** Each world file and the schema it must satisfy. */
export const worldFileSchemas = {
  accounts: z.array(accountSchema),
  backlog: z.array(backlogRowSchema),
  manifest: manifestSchema,
  needs: z.array(needSchema),
  personas: z.array(personaSchema),
  signals: z.array(signalSchema),
  themes: z.array(themeSchema),
} as const;

/** Each per-world recipe file (`themes.json` sits one level up, shared by both worlds). */
export const recipeFileSchemas = {
  accounts: z.array(accountSchema),
  backlog: z.array(backlogRowSchema),
  needs: z.array(needSchema),
  personaMix: personaMixSchema,
} as const;
