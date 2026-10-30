import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { tokens } from "@/lib/signal/ai/fakes";

import { passesSubmitValidation } from "../checks";
import type { Manifest, Need, Recipe, RecipeWorldName, World, WorldSignal } from "../format";
import { recipeWorldNames } from "../format";
import { HELD_OUT } from "../held-out";
import { loadRecipe, parseWorld, worldDir } from "../world";
import { KEYWORD_FINDABLE_CEILING, keywordFindability, needText } from "./leakage";
import { callStructured, mapLimit, spendByModel } from "./llm";
import { buildPlan, labelSlots, WORLD_STARTS_AT } from "./plan";
import type { Slot } from "./plan";
import {
  batchPrompt,
  itemPrompt,
  promptsHash,
  STRICT_ADDENDUM,
  WRITER_INSTRUCTIONS,
  writtenSchema,
} from "./prompts";
import type { WriteContext, Written } from "./prompts";

/**
 * Generates and freezes `crewday-dev@v1` and `crewday-test@v1` from the hand-written recipe
 * (spec 004 → The worlds; task 02). Run once per world version, never during an eval:
 *
 *   pnpm crewday:generate            # both worlds
 *   pnpm crewday:generate dev        # one world
 *   pnpm exec oxfmt evals/crewday/worlds   # then format the JSON for pnpm lint
 *
 * Needs AI_GATEWAY_API_KEY. Model responses are cached under generate/.cache (gitignored), so a
 * crashed run resumes cheaply. This entry file is on the held-out guard's allowlist because it
 * must read the test recipe and write the test world; nothing it builds is used for tuning.
 */

const VERSION = "v1";
const SEED = 20_270_101;
const WRITER_MODEL = "google/gemini-3-flash";
const BATCH = 15;
const CONCURRENCY = 8;
/** Regenerate down to this share, a margin under the ceiling, in the single strict pass. */
const LEAKAGE_TARGET = 0.55;
const SPEND_CAP_USD = 5;

const log = (message: string) => process.stderr.write(`${message}\n`);

const prefixOf = (world: RecipeWorldName) => (world === "dev" ? "d" : "t");

const spentSoFar = () => [...spendByModel.values()].reduce((sum, spend) => sum + spend.newUsd, 0);

const writeSlots = async (
  slots: Slot[],
  context: WriteContext,
  options: { avoid?: (slot: Slot) => string[]; salt?: string } = {},
) => {
  const byNeed = new Map<string, Slot[]>();
  for (const slot of slots) {
    const key = slot.needKeys[0] ?? "";
    byNeed.set(key, [...(byNeed.get(key) ?? []), slot]);
  }
  const batches = [...byNeed.values()].flatMap((group) =>
    Array.from({ length: Math.ceil(group.length / BATCH) }, (_, index) =>
      group.slice(index * BATCH, (index + 1) * BATCH),
    ),
  );
  const strict = Boolean(options.avoid);
  const written = new Map<number, Written>();
  let done = 0;
  await mapLimit(batches, CONCURRENCY, async (batch) => {
    if (spentSoFar() > SPEND_CAP_USD) throw new Error(`spend cap $${SPEND_CAP_USD} reached`);
    const items = batch.map((slot) => itemPrompt(slot, context, options.avoid?.(slot)));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Each attempt depends on whether the last returned every item.
      // oxlint-disable-next-line eslint/no-await-in-loop
      const output = await callStructured({
        instructions: strict ? `${WRITER_INSTRUCTIONS}\n${STRICT_ADDENDUM}` : WRITER_INSTRUCTIONS,
        modelId: WRITER_MODEL,
        prompt: batchPrompt(items),
        salt: `${options.salt ?? ""}${attempt ? `#${attempt}` : ""}`,
        schema: writtenSchema,
        temperature: 1,
      });
      const missing = batch.filter(
        (slot) =>
          !output.items.some(
            (item) => item.id === String(slot.slot) && item.title.trim() && item.body.trim(),
          ),
      );
      for (const item of output.items) {
        if (batch.some((slot) => String(slot.slot) === item.id)) written.set(Number(item.id), item);
      }
      if (missing.length === 0) break;
      if (attempt === 2)
        throw new Error(`writer left out slots ${missing.map((s) => s.slot).join(", ")}`);
    }
    done += 1;
    if (done % 10 === 0)
      log(`  ${done}/${batches.length} batches, $${spentSoFar().toFixed(3)} new spend`);
  });
  return written;
};

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/** Slots plus their text → signals in time order, with labels, planted cases, and final ids. */
const assemble = (slots: Slot[], texts: Map<number, Written>, recipe: Recipe, prefix: string) => {
  const labels = labelSlots(slots, recipe.needs);
  const ids = new Map(
    slots.map((slot, index) => [slot.slot, `${prefix}-s${String(index + 1).padStart(4, "0")}`]),
  );
  const signals: WorldSignal[] = [];
  for (const slot of slots) {
    const source = slot.planted === "retry" ? slot.retryOf : slot.slot;
    const text = texts.get(source ?? -1);
    const label = labels.get(slot.slot);
    if (!text || !label) throw new Error(`slot ${slot.slot} has no text or labels`);
    let title = clip(text.title.trim(), 200);
    let body = clip(text.body.trim(), 5000);
    const useCase = slot.useCase && text.useCase?.trim() ? clip(text.useCase.trim(), 2000) : null;
    const pii = slot.planted === "pii" ? slot.pii : undefined;
    if (pii) {
      // The writer was asked to include each detail verbatim; append any it left out.
      const missing = pii.filter((detail) => !`${title}\n${body}`.includes(detail));
      if (missing.length) body = `${body}\n\nFrom the ticket: ${missing.join(", ")}.`;
    }
    if (slot.planted === "invalid") {
      if (slot.invalidMode === "blank-title") title = "   ";
      else body = " \n\t ";
    }
    signals.push({
      accountKey: slot.accountKey,
      actorKind: slot.actorKind,
      at: slot.at,
      body,
      channel: slot.channel,
      id: ids.get(slot.slot) ?? "",
      labels: label,
      personaKey: slot.personaKey,
      ...(pii ? { pii } : {}),
      ...(slot.planted ? { planted: slot.planted } : {}),
      ...(slot.planted === "retry" ? { retryOf: ids.get(slot.retryOf ?? -1) ?? "" } : {}),
      title,
      urgency: slot.urgency,
      useCase,
    });
  }
  return signals;
};

/** Query words that point at one need: in its public text and in at most two other needs'. */
const distinctiveWords = (need: Need, recipe: Recipe) => {
  const others = recipe.needs
    .filter((n) => n.key !== need.key)
    .map((n) => needText(n, recipe.themes));
  return [...new Set(tokens(needText(need, recipe.themes)))].filter(
    (word) => others.filter((text) => text.includes(word)).length <= 2,
  );
};

const generateWorld = async (name: RecipeWorldName) => {
  const recipe = await loadRecipe(name, name === "test" ? { heldOut: HELD_OUT } : {});
  const prefix = prefixOf(name);
  const plan = buildPlan(recipe, SEED, prefix);
  const context: WriteContext = {
    accounts: recipe.accounts,
    needs: recipe.needs,
    personas: plan.personas,
    recipe,
  };
  const toWrite = plan.slots.filter((slot) => slot.planted !== "retry");
  log(
    `[crewday:generate] ${name}: ${plan.personas.length} personas, ${plan.slots.length} signals; writing with ${WRITER_MODEL}`,
  );
  const texts = await writeSlots(toWrite, context);

  let signals = assemble(plan.slots, texts, recipe, prefix);
  const before = keywordFindability({ needs: recipe.needs, signals, themes: recipe.themes });
  log(
    `  keyword-findable share ${before.share.toFixed(3)} (${before.findable}/${before.considered})`,
  );
  let regenerated = 0;
  if (before.share > LEAKAGE_TARGET) {
    // One strict pass over the most keyword-findable signals.
    const excess = before.findable - Math.floor(LEAKAGE_TARGET * before.considered);
    const slotById = new Map(
      signals.map((signal, index) => [signal.id, plan.slots[index] as Slot]),
    );
    const worst = [...before.bySignal]
      .filter(([, value]) => value.findable)
      .toSorted((a, b) => b[1].trueShare - a[1].trueShare)
      .slice(0, Math.ceil(excess * 1.6))
      .flatMap(([id]) => slotById.get(id) ?? []);
    for (const slot of worst) {
      if (slot.intent !== "same_solution") delete slot.solution;
    }
    const needByKey = new Map(recipe.needs.map((need) => [need.key, need]));
    const rewritten = await writeSlots(worst, context, {
      avoid: (slot) => {
        const need = needByKey.get(slot.needKeys[0] ?? "");
        return need ? distinctiveWords(need, recipe) : [];
      },
      salt: "strict",
    });
    for (const [slot, text] of rewritten) texts.set(slot, text);
    regenerated = rewritten.size;
    signals = assemble(plan.slots, texts, recipe, prefix);
  }
  const after = keywordFindability({ needs: recipe.needs, signals, themes: recipe.themes });
  log(`  after one strict pass over ${regenerated} signals: ${after.share.toFixed(3)}`);
  if (after.share > KEYWORD_FINDABLE_CEILING) {
    throw new Error(
      `${name}: keyword-findable share ${after.share} is above ${KEYWORD_FINDABLE_CEILING}`,
    );
  }
  const unexpected = signals.filter((s) => s.planted !== "invalid" && !passesSubmitValidation(s));
  if (unexpected.length)
    throw new Error(`${name}: ${unexpected.length} signals fail submit validation`);

  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    generator: {
      models: { writer: WRITER_MODEL },
      promptsHash: promptsHash(),
      seeds: { plan: SEED },
    },
    keywordFindableShare: Number(after.share.toFixed(4)),
    review: {
      dropped: 0,
      fixed: 0,
      method: "none (deferred)",
      notes: `Review deferred for speed. Leakage: keyword-findable share ${before.share.toFixed(4)} before and ${after.share.toFixed(4)} after one strict regeneration pass over ${regenerated} signals.`,
      reviewer: "none",
      sampleSize: 0,
    },
    startsAt: WORLD_STARTS_AT,
    version: VERSION,
    world: name,
  };
  const world: World = {
    accounts: recipe.accounts,
    backlog: recipe.backlog,
    manifest,
    needs: recipe.needs,
    personas: plan.personas,
    signals,
    themes: recipe.themes,
  };
  parseWorld(world, `generated world ${name}`);
  const dir = worldDir(name, VERSION);
  await mkdir(dir, { recursive: true });
  await Promise.all(
    Object.entries(world).map(([file, value]) =>
      writeFile(path.join(dir, `${file}.json`), `${JSON.stringify(value, null, 2)}\n`),
    ),
  );
  log(`  wrote ${path.relative(process.cwd(), dir)}`);
};

const requested = process.argv
  .slice(2)
  .filter((arg): arg is RecipeWorldName => (recipeWorldNames as readonly string[]).includes(arg));
for (const name of requested.length ? requested : recipeWorldNames) {
  // Worlds are generated one after the other to keep the spend readable per world.
  // oxlint-disable-next-line eslint/no-await-in-loop
  await generateWorld(name);
}
for (const [model, spend] of spendByModel) {
  log(
    `[crewday:generate] ${model}: ${spend.calls} calls (${spend.cachedCalls} cached), $${spend.totalUsd.toFixed(4)} total, $${spend.newUsd.toFixed(4)} new this run`,
  );
}
