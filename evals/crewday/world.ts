import { readFile } from "node:fs/promises";
import path from "node:path";

import type { z } from "zod";

import { checkRecipe, checkRecipePair, checkWorld } from "./checks";
import { recipeFileSchemas, themeSchema, worldFileSchemas } from "./format";
import type { Recipe, RecipeWorldName, World, WorldName } from "./format";
import { HELD_OUT } from "./held-out";
import type { HeldOut } from "./held-out";

/**
 * Loading a Crewday recipe or world from disk (spec 004 → task 01). Every file is parsed with its
 * schema and the result checked with `./checks`; anything wrong throws one `WorldFormatError`
 * listing every problem. The test world and its recipe need the held-out capability
 * (`./held-out`), which tuning code never has.
 */

export const crewdayRoot = import.meta.dirname;

export class WorldFormatError extends Error {
  readonly problems: string[];

  constructor(subject: string, problems: string[]) {
    super(
      `${subject} is invalid (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    );
    this.name = "WorldFormatError";
    this.problems = problems;
  }
}

export interface HeldOutOptions {
  /** Required to read the test world; only tagged and acceptance runs pass it. */
  heldOut?: HeldOut;
}

const assertReadable = (name: WorldName, options: HeldOutOptions) => {
  if (name === "test" && options.heldOut !== HELD_OUT) {
    throw new Error(
      "The crewday test world is held out: only tagged and acceptance runs may read it. Tune on the dev world.",
    );
  }
};

const readJson = async (file: string, problems: string[]): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(file, "utf-8"));
  } catch (error) {
    problems.push(`${path.relative(crewdayRoot, file)}: ${(error as Error).message}`);
    return undefined;
  }
};

const readText = async (file: string, problems: string[]) => {
  try {
    return await readFile(file, "utf-8");
  } catch (error) {
    problems.push(`${path.relative(crewdayRoot, file)}: ${(error as Error).message}`);
    return "";
  }
};

/** Parses raw file contents with their schemas, collecting every issue as `file[path]: message`. */
const parseFiles = <Schemas extends Record<string, z.ZodType>>(
  schemas: Schemas,
  raw: Record<keyof Schemas, unknown>,
  problems: string[],
) => {
  const parsed: Partial<{ [K in keyof Schemas]: z.infer<Schemas[K]> }> = {};
  for (const [name, schema] of Object.entries(schemas) as [keyof Schemas & string, z.ZodType][]) {
    if (raw[name] === undefined) {
      problems.push(`${name}.json: missing`);
      continue;
    }
    const result = schema.safeParse(raw[name]);
    if (result.success) parsed[name] = result.data as z.infer<Schemas[typeof name]>;
    else {
      for (const issue of result.error.issues) {
        problems.push(
          `${name}.json${issue.path.map((p) => `[${String(p)}]`).join("")}: ${issue.message}`,
        );
      }
    }
  }
  return parsed as { [K in keyof Schemas]: z.infer<Schemas[K]> };
};

/** Validates in-memory world files (one value per JSON file); throws listing every problem. */
export const parseWorld = (
  raw: Record<keyof typeof worldFileSchemas, unknown>,
  subject = "world",
): World => {
  const problems: string[] = [];
  const world = parseFiles(worldFileSchemas, raw, problems);
  if (problems.length) throw new WorldFormatError(subject, problems);
  const consistency = checkWorld(world);
  if (consistency.length) throw new WorldFormatError(subject, consistency);
  return world;
};

const worldDir = (name: WorldName, version: string) =>
  path.join(crewdayRoot, "worlds", name, version);

/** Where the generator writes a world; the test world needs the held-out token, as for reads. */
export const worldOutputDir = (name: WorldName, version: string, options: HeldOutOptions = {}) => {
  assertReadable(name, options);
  return worldDir(name, version);
};

/** Loads and validates `evals/crewday/worlds/<name>/<version>/`. */
export const loadWorld = async (
  name: WorldName,
  version: string,
  options: HeldOutOptions = {},
): Promise<World> => {
  assertReadable(name, options);
  const dir = worldDir(name, version);
  const problems: string[] = [];
  const entries = await Promise.all(
    Object.keys(worldFileSchemas).map(
      async (file) => [file, await readJson(path.join(dir, `${file}.json`), problems)] as const,
    ),
  );
  if (problems.length) throw new WorldFormatError(`world ${name}/${version}`, problems);
  const world = parseWorld(
    Object.fromEntries(entries) as Record<keyof typeof worldFileSchemas, unknown>,
    `world ${name}/${version}`,
  );
  if (world.manifest.world !== name || world.manifest.version !== version) {
    throw new WorldFormatError(`world ${name}/${version}`, [
      `manifest.json names ${world.manifest.world}/${world.manifest.version}`,
    ]);
  }
  return world;
};

/** Validates an in-memory recipe; throws listing every problem. */
export const parseRecipe = (
  raw: Record<keyof typeof recipeFileSchemas | "themes", unknown> & {
    company: string;
    strategy: string;
  },
  world: RecipeWorldName,
): Recipe => {
  const problems: string[] = [];
  const files = parseFiles({ ...recipeFileSchemas, themes: themeSchema.array() }, raw, problems);
  const subject = `recipe ${world}`;
  if (problems.length) throw new WorldFormatError(subject, problems);
  const recipe: Recipe = { ...files, company: raw.company, strategy: raw.strategy, world };
  const consistency = checkRecipe(recipe);
  if (consistency.length) throw new WorldFormatError(subject, consistency);
  return recipe;
};

/** Loads and validates the shared recipe files plus `evals/crewday/recipe/<world>/`. */
export const loadRecipe = async (
  world: RecipeWorldName,
  options: HeldOutOptions = {},
): Promise<Recipe> => {
  assertReadable(world, options);
  const root = path.join(crewdayRoot, "recipe");
  const dir = path.join(root, world);
  const problems: string[] = [];
  const [themes, company, strategy, ...perWorld] = await Promise.all([
    readJson(path.join(root, "themes.json"), problems),
    readText(path.join(root, "company.md"), problems),
    readText(path.join(root, "strategy.md"), problems),
    ...Object.keys(recipeFileSchemas).map((file) =>
      readJson(path.join(dir, `${file}.json`), problems),
    ),
  ]);
  if (problems.length) throw new WorldFormatError(`recipe ${world}`, problems);
  const files = Object.fromEntries(
    Object.keys(recipeFileSchemas).map((file, index) => [file, perWorld[index]]),
  ) as Record<keyof typeof recipeFileSchemas, unknown>;
  return parseRecipe(
    { ...files, company: company as string, strategy: strategy as string, themes },
    world,
  );
};

/** Loads both recipes and checks that nothing (trap groups, needs, accounts) crosses worlds. */
export const checkRecipes = async (options: HeldOutOptions) => {
  const [dev, test] = await Promise.all([loadRecipe("dev"), loadRecipe("test", options)]);
  const problems = checkRecipePair(dev, test);
  if (problems.length) throw new WorldFormatError("recipes dev + test", problems);
  return { dev, test };
};
