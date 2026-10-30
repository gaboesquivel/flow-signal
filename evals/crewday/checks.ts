import { isDeepStrictEqual } from "node:util";

import { submitInputSchema } from "@/lib/signal/domain/submissions";

import type { Account, BacklogRow, Need, Recipe, Theme, World, WorldSignal } from "./format";

/**
 * Consistency rules for a recipe and a world, beyond what the schemas in `./format` check. Each
 * function returns every problem it finds (empty when consistent), so a loader can report them all
 * at once. Pure: the in-memory tests build bad worlds and call these directly.
 */

interface NeedSet {
  accounts: Account[];
  backlog: BacklogRow[];
  needs: Need[];
  themes: Theme[];
}

const duplicates = (values: string[]) => [
  ...new Set(values.filter((value, index) => values.indexOf(value) !== index)),
];

const uniqueKeys = (file: string, field: string, values: string[]) =>
  duplicates(values).map((value) => `${file}: duplicate ${field} "${value}"`);

const lowerSolutions = (need: Need) => need.solutions.map((solution) => solution.toLowerCase());

const checkNeed = (need: Need, set: NeedSet, needsByKey: Map<string, Need>): string[] => {
  const at = `needs.json "${need.key}"`;
  const problems: string[] = [];
  if (!set.themes.some((theme) => theme.key === need.themeKey)) {
    problems.push(`${at}: unknown theme "${need.themeKey}"`);
  }
  for (const account of need.requesterAccounts) {
    if (!set.accounts.some((a) => a.key === account)) {
      problems.push(`${at}: unknown requester account "${account}"`);
    }
  }
  if (need.splitInto && need.trap?.kind !== "split") {
    problems.push(`${at}: splitInto is only allowed on a "split" trap`);
  }
  for (const child of need.splitInto ?? []) {
    const childNeed = needsByKey.get(child);
    if (child === need.key) problems.push(`${at}: splits into itself`);
    else if (!childNeed) problems.push(`${at}: splits into unknown need "${child}"`);
    else if (childNeed.trap?.group !== need.trap?.group) {
      problems.push(`${at}: split child "${child}" is not in trap group "${need.trap?.group}"`);
    }
  }
  return problems;
};

/** One trap group: a single kind, enough members, and the shape its kind needs. */
const checkTrapGroup = (group: string, members: Need[]): string[] => {
  const at = `needs.json trap group "${group}"`;
  const kinds = new Set(members.map((need) => need.trap?.kind));
  if (kinds.size > 1) return [`${at}: mixes trap kinds ${[...kinds].join(", ")}`];
  const [kind] = kinds;
  const problems: string[] = [];
  if ((kind === "shared_solution" || kind === "near_neighbour") && members.length < 2) {
    problems.push(`${at}: a ${kind} trap needs at least two needs`);
  }
  if (kind === "shared_solution") {
    for (const need of members) {
      const shares = members.some(
        (other) =>
          other !== need &&
          lowerSolutions(other).some((solution) => lowerSolutions(need).includes(solution)),
      );
      if (!shares) problems.push(`${at}: "${need.key}" shares no solution with the group`);
    }
  }
  if (kind === "split") {
    const parents = members.filter((need) => need.splitInto?.length);
    if (parents.length !== 1 || (parents[0]?.splitInto?.length ?? 0) < 2) {
      problems.push(`${at}: a split trap needs exactly one need with splitInto of two or more`);
    }
  }
  return problems;
};

const checkBacklog = ({ backlog, needs }: NeedSet, needsByKey: Map<string, Need>): string[] => {
  const problems: string[] = [];
  for (const row of backlog) {
    const need = needsByKey.get(row.trueNeedKey);
    if (!need) problems.push(`backlog.json "${row.rowId}": unknown need "${row.trueNeedKey}"`);
    else if (!need.inBacklog) {
      problems.push(`backlog.json "${row.rowId}": need "${need.key}" is not marked inBacklog`);
    }
  }
  for (const need of needs) {
    if (need.inBacklog && !backlog.some((row) => row.trueNeedKey === need.key)) {
      problems.push(`needs.json "${need.key}": inBacklog but no backlog row points at it`);
    }
  }
  return problems;
};

/** Themes, accounts, needs (traps, splits, priorities), and the backlog that points at them. */
export const checkNeedSet = (set: NeedSet): string[] => {
  const { accounts, backlog, needs, themes } = set;
  const needsByKey = new Map(needs.map((need) => [need.key, need]));
  const groups = new Map<string, Need[]>();
  for (const need of needs) {
    if (need.trap) groups.set(need.trap.group, [...(groups.get(need.trap.group) ?? []), need]);
  }
  return [
    ...uniqueKeys(
      "themes.json",
      "key",
      themes.map((theme) => theme.key),
    ),
    ...uniqueKeys(
      "accounts.json",
      "key",
      accounts.map((account) => account.key),
    ),
    ...uniqueKeys(
      "needs.json",
      "key",
      needs.map((need) => need.key),
    ),
    ...uniqueKeys(
      "backlog.json",
      "rowId",
      backlog.map((row) => row.rowId),
    ),
    ...duplicates(needs.map((need) => String(need.truePriority))).map(
      (priority) => `needs.json: truePriority ${priority} is used by more than one need`,
    ),
    ...needs.flatMap((need) => checkNeed(need, set, needsByKey)),
    ...[...groups].flatMap(([group, members]) => checkTrapGroup(group, members)),
    ...checkBacklog(set, needsByKey),
  ];
};

export const checkRecipe = (recipe: Recipe): string[] => {
  const problems = checkNeedSet(recipe);
  if (!recipe.company.trim()) problems.push("company.md is empty");
  if (!recipe.strategy.trim()) problems.push("strategy.md is empty");
  const shares = recipe.personaMix.roles.reduce((sum, role) => sum + role.share, 0);
  if (Math.abs(shares - 1) > 1e-6) {
    problems.push(`personaMix.json: role shares sum to ${shares}, not 1`);
  }
  return problems;
};

const overlap = (field: string, a: string[], b: string[]) =>
  [...new Set(a.filter((value) => b.includes(value)))].map(
    (value) => `${field} "${value}" is in both the dev and test recipes`,
  );

const trapGroups = (recipe: Recipe) => recipe.needs.flatMap((need) => need.trap?.group ?? []);

/** The two worlds share themes only: no trap group, need, or account crosses between them. */
export const checkRecipePair = (dev: Recipe, test: Recipe): string[] => [
  ...overlap("trap group", trapGroups(dev), trapGroups(test)),
  ...overlap(
    "need",
    dev.needs.map((need) => need.key),
    test.needs.map((need) => need.key),
  ),
  ...overlap(
    "account",
    dev.accounts.map((account) => account.key),
    test.accounts.map((account) => account.key),
  ),
];

const submitFields = submitInputSchema.pick({
  body: true,
  title: true,
  urgency: true,
  useCase: true,
});

/** Whether `submit_signal` would accept the signal's text (its real input validation). */
export const passesSubmitValidation = (signal: WorldSignal) =>
  submitFields.safeParse({
    body: signal.body,
    title: signal.title,
    urgency: signal.urgency,
    useCase: signal.useCase ?? undefined,
  }).success;

const addUtcMonths = (date: Date, months: number) => {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
};

/** Month 0 of the world: `manifest.startsAt`, else the UTC month of the earliest signal. */
export const worldStart = (world: Pick<World, "manifest" | "signals">): Date | undefined => {
  if (world.manifest.startsAt) return new Date(world.manifest.startsAt);
  const times = world.signals.map((signal) => Date.parse(signal.at));
  if (!times.length) return undefined;
  const first = new Date(Math.min(...times));
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1));
};

/** A counted signal reaches the workspace once: not a planted retry or validation failure. */
export const isCounted = (signal: WorldSignal) =>
  signal.planted !== "retry" && signal.planted !== "invalid";

const signalAt = (signal: WorldSignal) => `signals.json "${signal.id}"`;

/** The signal's persona, account, and need keys exist and agree with each other. */
const checkSignalRefs = (signal: WorldSignal, world: World): string[] => {
  const at = signalAt(signal);
  const problems: string[] = [];
  const persona = world.personas.find((p) => p.key === signal.personaKey);
  if (!persona) problems.push(`${at}: unknown persona "${signal.personaKey}"`);
  if (persona && persona.channel !== signal.channel) {
    problems.push(`${at}: channel ${signal.channel} differs from its persona's ${persona.channel}`);
  }
  if (persona && persona.actorKind !== signal.actorKind) {
    problems.push(`${at}: actorKind ${signal.actorKind} differs from its persona's`);
  }
  if (!world.accounts.some((account) => account.key === signal.accountKey)) {
    problems.push(`${at}: unknown account "${signal.accountKey}"`);
  }
  const { kind, needKeys } = signal.labels;
  for (const needKey of needKeys) {
    if (!world.needs.some((need) => need.key === needKey)) {
      problems.push(`${at}: labeled with unknown need "${needKey}"`);
    }
  }
  if (new Set(needKeys).size !== needKeys.length) problems.push(`${at}: repeats a need key`);
  if ((kind === "multi_ask") !== (needKeys.length === 2)) {
    problems.push(`${at}: multi_ask signals have exactly two needKeys, all others one`);
  }
  return problems;
};

/** Planted cases carry what they need, and only planted invalid signals fail validation. */
const checkSignalPlanted = (signal: WorldSignal): string[] => {
  const at = signalAt(signal);
  const problems: string[] = [];
  if ((signal.planted === "retry") !== (signal.retryOf !== undefined)) {
    problems.push(`${at}: retryOf is set exactly when planted is "retry"`);
  }
  if (signal.planted === "pii" && !signal.pii?.length) {
    problems.push(`${at}: planted pii lists no pii strings`);
  }
  if (signal.planted !== "pii" && signal.pii) {
    problems.push(`${at}: pii is only allowed on a planted pii signal`);
  }
  for (const detail of signal.pii ?? []) {
    if (!`${signal.title}\n${signal.body}`.includes(detail)) {
      problems.push(`${at}: pii "${detail}" is not in its title or body`);
    }
  }
  const valid = passesSubmitValidation(signal);
  if (signal.planted === "invalid" && valid) {
    problems.push(`${at}: planted invalid but submit_signal validation accepts it`);
  }
  if (signal.planted !== "invalid" && !valid) {
    problems.push(`${at}: submit_signal validation rejects it but it is not planted invalid`);
  }
  return problems;
};

const checkPersonas = (world: World): string[] => [
  ...uniqueKeys(
    "personas.json",
    "key",
    world.personas.map((persona) => persona.key),
  ),
  ...uniqueKeys(
    "personas.json",
    "email",
    world.personas.map((persona) => persona.email.toLowerCase()),
  ),
  ...world.personas.flatMap((persona) => [
    ...(world.accounts.some((account) => account.key === persona.accountKey)
      ? []
      : [`personas.json "${persona.key}": unknown account "${persona.accountKey}"`]),
    ...(persona.actorKind === "agent" && persona.channel !== "mcp"
      ? [`personas.json "${persona.key}": an agent persona files over mcp`]
      : []),
  ]),
];

/** Signals are in time order and inside the world's 12 months. */
const checkTiming = (world: World): string[] => {
  const problems: string[] = [];
  const start = worldStart(world);
  const end = start && addUtcMonths(start, 12);
  for (const [index, signal] of world.signals.entries()) {
    const time = Date.parse(signal.at);
    const previous = world.signals[index - 1];
    if (previous && time < Date.parse(previous.at)) {
      problems.push(`${signalAt(signal)}: out of order (earlier than "${previous.id}")`);
    }
    if (start && end && (time < start.getTime() || time >= end.getTime())) {
      problems.push(
        `${signalAt(signal)}: ${signal.at} is outside the world's 12 months from ${start.toISOString()}`,
      );
    }
  }
  return problems;
};

/** A retry repeats an earlier counted signal's persona, title, body, and labels. */
const checkRetry = (signal: WorldSignal, earlier: WorldSignal[]): string[] => {
  const at = signalAt(signal);
  const original = earlier.find((s) => s.id === signal.retryOf);
  if (!original) return [`${at}: retryOf "${signal.retryOf}" is not an earlier signal`];
  const problems: string[] = [];
  if (!isCounted(original)) problems.push(`${at}: retries a planted signal`);
  if (
    original.title !== signal.title ||
    original.body !== signal.body ||
    original.personaKey !== signal.personaKey
  ) {
    problems.push(`${at}: a retry repeats its original's persona, title, and body exactly`);
  }
  if (!isDeepStrictEqual(original.labels, signal.labels)) {
    problems.push(`${at}: a retry carries its original's labels`);
  }
  return problems;
};

/**
 * The order-dependent labels, replayed in time order:
 * - `firstOccurrence` is true only on the first counted signal whose main need (`needKeys[0]`)
 *   no earlier counted signal mentioned; never on a planted signal.
 * - `existedAtTime` is true when the main need is in the backlog, was mentioned by an earlier
 *   counted signal, or is a split child whose parent was. `new` needs it false, `paraphrase` true.
 */
const checkOrderLabels = (world: World): string[] => {
  const problems: string[] = [];
  const needsByKey = new Map(world.needs.map((need) => [need.key, need]));
  const parentOf = new Map(
    world.needs.flatMap((need) => (need.splitInto ?? []).map((child) => [child, need.key])),
  );
  const mentioned = new Set<string>();
  // `depth` stops a malformed splitInto cycle from recursing forever.
  const known = (needKey: string | undefined, depth = 0): boolean =>
    needKey !== undefined &&
    depth <= world.needs.length &&
    (Boolean(needsByKey.get(needKey)?.inBacklog) ||
      mentioned.has(needKey) ||
      known(parentOf.get(needKey), depth + 1));

  for (const signal of world.signals) {
    if (signal.planted === "retry") continue;
    const at = signalAt(signal);
    const { existedAtTime, firstOccurrence, kind, needKeys } = signal.labels;
    const [main] = needKeys;
    const expectedFirst = isCounted(signal) && main !== undefined && !mentioned.has(main);
    const expectedExisted = known(main);
    if (firstOccurrence !== expectedFirst) {
      problems.push(`${at}: firstOccurrence should be ${expectedFirst}`);
    }
    if (existedAtTime !== expectedExisted) {
      problems.push(`${at}: existedAtTime should be ${expectedExisted}`);
    }
    if (kind === "new" && existedAtTime)
      problems.push(`${at}: a "new" signal's need already exists`);
    if (kind === "paraphrase" && !existedAtTime) {
      problems.push(`${at}: a "paraphrase" signal's need does not exist yet`);
    }
    if (isCounted(signal)) for (const needKey of needKeys) mentioned.add(needKey);
  }
  return problems;
};

/**
 * Every rule for a loaded world: the need set, personas, each signal's references and planted
 * case, time order and window, retries, and the order-dependent labels (`checkOrderLabels`).
 */
export const checkWorld = (world: World): string[] => [
  ...checkNeedSet(world),
  ...checkPersonas(world),
  ...uniqueKeys(
    "signals.json",
    "id",
    world.signals.map((signal) => signal.id),
  ),
  ...world.signals.flatMap((signal) => [
    ...checkSignalRefs(signal, world),
    ...checkSignalPlanted(signal),
  ]),
  ...checkTiming(world),
  ...world.signals.flatMap((signal, index) =>
    signal.retryOf === undefined ? [] : checkRetry(signal, world.signals.slice(0, index)),
  ),
  ...checkOrderLabels(world),
];
