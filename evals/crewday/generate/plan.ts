import { isCounted } from "../checks";
import type { Account, Need, Persona, Recipe, SignalKind, WorldSignal } from "../format";
import { rngStream } from "../sim/rng";
import type { Rng } from "../sim/rng";

/**
 * The deterministic half of world generation (spec 004 → The worlds, steps 1–2): personas from the
 * recipe's persona mix, and a seeded schedule of signal slots with their hidden labels attached
 * by construction, before any text exists. Pure: the same recipe and seed give the same plan.
 */

export const WORLD_STARTS_AT = "2027-01-01T00:00:00Z";
const START = Date.parse(WORLD_STARTS_AT);
const MONTHS = 12;

/** Target sizes per world. */
const TARGET_SIGNALS = 600;
const RETRIES = 4;
const INVALID = 4;
const PII = 7;
const MULTI_ASK_SHARE = 0.05;
const USE_CASE_SHARE = 0.7;
/** Share of signals filed from one of the need's requester accounts. */
const REQUESTER_SHARE = 0.75;
const SAME_SOLUTION_SHARE = 0.45;
const NAMED_SOLUTION_SHARE = 0.2;
const INTERNAL_DOMAIN = "crewday.example";

/** Signal intent before labels: the label kind follows from it and the order (`labelSignals`). */
export type Intent = "plain" | "symptom" | "same_solution" | "multi_ask";
export type InvalidMode = "blank-body" | "blank-title";

export interface Slot {
  accountKey: string;
  actorKind: Persona["actorKind"];
  at: string;
  channel: Persona["channel"];
  intent: Intent;
  invalidMode?: InvalidMode;
  needKeys: string[];
  personaKey: string;
  pii?: string[];
  planted?: WorldSignal["planted"];
  /** `slot` of the original, for a planted retry. */
  retryOf?: number;
  /** One scenario per need key, in order. */
  scenarios: string[];
  /** Stable id of the slot across regeneration and drops. */
  slot: number;
  /** A solution the persona names (always set for `same_solution`). */
  solution?: string;
  urgency: WorldSignal["urgency"];
  useCase: boolean;
}

interface Plan {
  personas: Persona[];
  slots: Slot[];
}

// --- small seeded helpers ---------------------------------------------------------------------

const pickWeighted = <T>(rng: Rng, items: T[], weight: (item: T) => number): T => {
  const weights = items.map(weight);
  const total = weights.reduce((sum, w) => sum + w, 0);
  let roll = rng.next() * total;
  for (const [index, item] of items.entries()) {
    roll -= weights[index] ?? 0;
    if (roll < 0) return item;
  }
  const last = items.at(-1);
  if (last === undefined) throw new Error("pickWeighted: no items");
  return last;
};

const pick = <T>(rng: Rng, items: T[]): T => {
  const item = items[rng.int(items.length)];
  if (item === undefined) throw new Error("pick: no items");
  return item;
};

const shuffle = <T>(rng: Rng, items: T[]): T[] => {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = rng.int(index + 1);
    [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
  }
  return copy;
};

/** Largest-remainder rounding of `shares` (any scale) to integers summing to `total`. */
const apportion = (shares: number[], total: number) => {
  const sum = shares.reduce((a, b) => a + b, 0);
  const exact = shares.map((share) => (share / sum) * total);
  const counts = exact.map(Math.floor);
  const order = exact
    .map((value, index) => ({ index, rest: value - Math.floor(value) }))
    .toSorted((a, b) => b.rest - a.rest || a.index - b.index);
  let left = total - counts.reduce((a, b) => a + b, 0);
  for (const { index } of order) {
    if (left <= 0) break;
    counts[index] = (counts[index] ?? 0) + 1;
    left -= 1;
  }
  return counts;
};

// --- personas -------------------------------------------------------------------------------

const FIRST_NAMES = [
  "Aisha",
  "Alejandro",
  "Amara",
  "Anh",
  "Bea",
  "Bogdan",
  "Camila",
  "Chidi",
  "Dara",
  "Dmitri",
  "Elena",
  "Emeka",
  "Farah",
  "Felipe",
  "Gemma",
  "Hamza",
  "Hana",
  "Ines",
  "Isaac",
  "Jalen",
  "Jana",
  "Joaquin",
  "Kalani",
  "Keiko",
  "Kwame",
  "Lars",
  "Leila",
  "Lucia",
  "Malik",
  "Mareike",
  "Mateo",
  "Mei",
  "Nadia",
  "Nikhil",
  "Noor",
  "Oksana",
  "Olu",
  "Paulo",
  "Priya",
  "Quinn",
  "Rafael",
  "Rania",
  "Rosa",
  "Sanjay",
  "Selin",
  "Sione",
  "Tamar",
  "Thanh",
  "Tomasz",
  "Uma",
  "Valeria",
  "Wendell",
  "Ximena",
  "Yusuf",
  "Zara",
  "Beatriz",
  "Callum",
  "Dalia",
  "Esteban",
  "Fiona",
  "Gideon",
  "Harper",
  "Imani",
  "Jonah",
  "Kenji",
  "Lorenzo",
  "Marisol",
  "Nico",
  "Odette",
  "Pilar",
  "Rohan",
  "Saoirse",
  "Teodoro",
  "Vivian",
  "Wanjiru",
  "Yara",
  "Ezra",
  "Ngozi",
  "Linh",
];
const LAST_NAMES = [
  "Abara",
  "Albrecht",
  "Bautista",
  "Bellamy",
  "Castellano",
  "Chau",
  "Dabrowski",
  "Delacroix",
  "Eklund",
  "Esposito",
  "Fairbanks",
  "Ferreira",
  "Galloway",
  "Gutierrez",
  "Halvorsen",
  "Hoang",
  "Ibarra",
  "Iwasaki",
  "Jaramillo",
  "Jovanovic",
  "Kowalczyk",
  "Kuznetsova",
  "Laurent",
  "Lindqvist",
  "Mbeki",
  "Montoya",
  "Nakashima",
  "Novak",
  "Obi",
  "Okonkwo",
  "Pacheco",
  "Petrakis",
  "Quintero",
  "Rasmussen",
  "Reyes",
  "Sandoval",
  "Sato",
  "Takahashi",
  "Toussaint",
  "Ueda",
  "Valdivia",
  "Vasquez",
  "Whitlock",
  "Wojcik",
  "Xiong",
  "Yilmaz",
  "Zamora",
  "Zielinski",
  "Achebe",
  "Brannigan",
  "Carvalho",
  "Desai",
  "Engstrom",
  "Fontaine",
  "Grabowski",
  "Haddad",
  "Kaur",
  "Mendoza",
  "Nguyen",
  "Osei",
  "Pereira",
  "Ramos",
  "Santana",
  "Tran",
  "Villanueva",
];

const emailLocal = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFD")
    .replaceAll(/[^a-z ]/gu, "")
    .trim()
    .replaceAll(/\s+/gu, ".");

const isCustomer = (account: Account) => account.arrCents > 0;

type RoleClass =
  | "copilot"
  | "sales"
  | "csm"
  | "owner"
  | "escalation"
  | "it"
  | "hr"
  | "frontline"
  | "manager"
  | "admin";

const roleClass = (role: string): RoleClass => {
  const lower = role.toLowerCase();
  if (lower.includes("copilot")) return "copilot";
  if (lower.includes("sales")) return "sales";
  if (lower.includes("csm")) return "csm";
  if (lower.includes("owner")) return "owner";
  if (lower.includes("escalation")) return "escalation";
  if (lower.includes("it or security")) return "it";
  if (lower.includes("hr") || lower.includes("payroll")) return "hr";
  if (lower.includes("frontline")) return "frontline";
  if (lower.includes("admin")) return "admin";
  return "manager";
};

const planWeight: Record<Account["plan"], number> = { Enterprise: 4, Growth: 2, Starter: 1 };

/** Accounts a persona of `cls` can belong to, and how strongly each attracts one. */
const homeAccounts = (cls: RoleClass, accounts: Account[]): [Account, number][] => {
  const customers = accounts.filter(isCustomer);
  switch (cls) {
    case "sales": {
      return accounts
        .filter((account) => account.openDealCents > 0)
        .map((account) => [account, isCustomer(account) ? 1 : 2]);
    }
    case "csm":
    case "escalation": {
      return customers
        .filter((account) => account.plan !== "Starter")
        .map((account) => [account, planWeight[account.plan]]);
    }
    case "owner": {
      return customers
        .filter((account) => account.plan === "Starter")
        .map((account) => [account, 1]);
    }
    case "it": {
      return customers
        .filter((account) => account.plan !== "Starter")
        .map((account) => [account, planWeight[account.plan]]);
    }
    default: {
      return customers.map((account) => [account, planWeight[account.plan]]);
    }
  }
};

const buildPersonas = (recipe: Recipe, seed: number, prefix: string): Persona[] => {
  const rng = rngStream(seed, `${recipe.world}:personas`);
  const { accounts, personaMix } = recipe;
  const counts = apportion(
    personaMix.roles.map((role) => role.share),
    personaMix.count,
  );
  const names = shuffle(
    rng,
    FIRST_NAMES.flatMap((first) => LAST_NAMES.map((last) => `${first} ${last}`)),
  );
  let nameIndex = 0;
  const nextName = () => {
    const name = names[nameIndex];
    nameIndex += 1;
    if (!name) throw new Error("ran out of persona names");
    return name;
  };
  const drafts: Omit<Persona, "key">[] = [];
  const byRole = personaMix.roles.map((role, index) => ({ count: counts[index] ?? 0, role }));
  // Copilots, reps, and other account-bound roles first, so general roles can fill the gaps.
  const order = byRole.toSorted(
    (a, b) =>
      Number(roleClass(a.role.role) === "frontline" || roleClass(a.role.role) === "manager") -
      Number(roleClass(b.role.role) === "frontline" || roleClass(b.role.role) === "manager"),
  );
  for (const { count, role } of order) {
    const cls = roleClass(role.role);
    const homes = homeAccounts(cls, accounts);
    if (cls === "copilot") {
      const ranked = accounts.filter(isCustomer).toSorted((a, b) => b.arrCents - a.arrCents);
      for (let index = 0; index < count; index += 1) {
        const account = ranked[index % ranked.length];
        if (!account) break;
        const round = Math.floor(index / ranked.length);
        drafts.push({
          accountKey: account.key,
          actorKind: "agent",
          channel: role.channel,
          email: `copilot${round ? round + 1 : ""}@${account.domain}`,
          name: `${account.name} support copilot`,
          role: role.role,
        });
      }
      continue;
    }
    const ranked = homes.toSorted((a, b) => b[1] - a[1] || b[0].arrCents - a[0].arrCents);
    for (let index = 0; index < count; index += 1) {
      // Round-robin first so every eligible account gets one, then weighted.
      let home: [Account, number] | undefined;
      if (cls === "sales" || cls === "csm") home = ranked[index % ranked.length];
      else if (index < ranked.length && rng.chance(0.5)) home = ranked[index];
      else home = pickWeighted(rng, homes, ([, weight]) => weight);
      if (!home) continue;
      const [account] = home;
      const name = nextName();
      const internal = cls === "sales" || cls === "csm";
      drafts.push({
        accountKey: account.key,
        actorKind: "human",
        channel: role.channel,
        email: `${emailLocal(name)}@${internal ? INTERNAL_DOMAIN : account.domain}`,
        name,
        role: role.role,
      });
    }
  }
  // Every customer account gets at least one person of its own (not a copilot, CSM, or rep).
  const general = personaMix.roles.filter((role) =>
    ["frontline", "manager", "admin"].includes(roleClass(role.role)),
  );
  for (const account of accounts.filter(isCustomer)) {
    const own = drafts.some(
      (draft) =>
        draft.accountKey === account.key &&
        !["copilot", "csm", "sales"].includes(roleClass(draft.role)),
    );
    if (own) continue;
    const donorIndex = drafts.findLastIndex(
      (draft) =>
        ["frontline", "manager"].includes(roleClass(draft.role)) &&
        drafts.filter((d) => d.accountKey === draft.accountKey).length > 3,
    );
    const role = pick(rng, general);
    const name = nextName();
    const replacement = {
      accountKey: account.key,
      actorKind: "human" as const,
      channel: role.channel,
      email: `${emailLocal(name)}@${account.domain}`,
      name,
      role: role.role,
    };
    if (donorIndex === -1) drafts.push(replacement);
    else drafts[donorIndex] = replacement;
  }
  return drafts
    .toSorted((a, b) => a.accountKey.localeCompare(b.accountKey) || a.email.localeCompare(b.email))
    .map((draft, index) => ({
      key: `${prefix}-p-${String(index + 1).padStart(3, "0")}`,
      ...draft,
    }));
};

// --- arrival curves -------------------------------------------------------------------------

const circular = (a: number, b: number) => {
  const d = Math.abs(a - b) % MONTHS;
  return Math.min(d, MONTHS - d);
};

const monthWeights = (need: Need): number[] => {
  const { curve, peakMonth, startMonth } = need.arrival;
  return Array.from({ length: MONTHS }, (_, month) => {
    switch (curve) {
      case "steady": {
        return month >= (startMonth ?? 0) ? 1 : 0;
      }
      case "late": {
        const start = startMonth ?? 6;
        return month >= start ? 1 + 0.25 * (month - start) : 0;
      }
      case "burst": {
        const start = startMonth ?? 0;
        const peak = peakMonth ?? start;
        if (month < start) return 0;
        if (month < peak) return 0.3;
        return 6 * 0.45 ** (month - peak) + 0.15;
      }
      case "seasonal": {
        const peak = peakMonth ?? 6;
        return 0.2 + 3 * Math.exp(-(circular(month, peak) ** 2) / 2);
      }
      default: {
        return 1;
      }
    }
  });
};

/** The month a split trap's parent hands over to its children. */
const splitMonths = (needs: Need[]) => {
  const result = new Map<string, { month: number; role: "parent" | "child" }>();
  for (const parent of needs.filter((need) => need.splitInto?.length)) {
    const children = (parent.splitInto ?? []).flatMap(
      (key) => needs.find((need) => need.key === key) ?? [],
    );
    const month = Math.max(2, Math.min(...children.map((child) => child.arrival.startMonth ?? 4)));
    result.set(parent.key, { month, role: "parent" });
    for (const child of children) result.set(child.key, { month, role: "child" });
  }
  return result;
};

const effectiveMonthWeights = (need: Need, splits: ReturnType<typeof splitMonths>) => {
  const weights = monthWeights(need);
  const split = splits.get(need.key);
  if (!split) return weights;
  return weights.map((weight, month) => {
    if (split.role === "parent") return month < split.month ? Math.max(weight, 0.5) : 0;
    return month >= split.month ? weight : 0;
  });
};

const monthStart = (month: number) => {
  const date = new Date(START);
  date.setUTCMonth(date.getUTCMonth() + month);
  return date.getTime();
};

/** A working-hours-ish instant inside `month`. */
const instantIn = (rng: Rng, month: number) => {
  const from = monthStart(month);
  const days = Math.round((monthStart(month + 1) - from) / 86_400_000);
  const hour = 6 + Math.floor(rng.next() * 16);
  return from + rng.int(days) * 86_400_000 + hour * 3_600_000 + rng.int(3600) * 1000;
};

// --- the schedule ----------------------------------------------------------------------------

const AFFINITY: Record<string, Partial<Record<RoleClass, number>>> = {
  compliance: { admin: 2, frontline: 0.6, hr: 1.5, it: 0.4 },
  integrations: { admin: 2, frontline: 0.1, it: 4, manager: 0.5, owner: 0.6 },
  mobile: { frontline: 3, hr: 0.4, it: 0.6, manager: 1 },
  "payroll-exports": { admin: 1.5, frontline: 0.8, hr: 3, manager: 0.6 },
  scheduling: { admin: 1.5, frontline: 1.2, hr: 0.6, manager: 2.5 },
  "time-attendance": { frontline: 1.2, hr: 1.5, manager: 1.5 },
};
const ROLE_BASE: Partial<Record<RoleClass, number>> = {
  copilot: 2.2,
  csm: 1.6,
  escalation: 0.6,
  sales: 1.5,
};

const personaWeight = (persona: Persona, need: Need) => {
  const cls = roleClass(persona.role);
  return (ROLE_BASE[cls] ?? 1) * (AFFINITY[need.themeKey]?.[cls] ?? 1);
};

const lower = (values: string[]) => values.map((value) => value.toLowerCase());

/** Solutions this need lists that another need in the world also lists. */
const sharedSolutions = (need: Need, needs: Need[]) =>
  need.solutions.filter((solution) =>
    needs.some(
      (other) => other.key !== need.key && lower(other.solutions).includes(solution.toLowerCase()),
    ),
  );

const piiNames = [
  "Marta Ilescu",
  "Devon Achterberg",
  "Rosalind Ofori",
  "Tobias Kwiatkowski",
  "Graciela Muñoz",
  "Bernard Oyelaran",
  "Svetlana Rudnik",
  "Hector Villalobos",
  "Ingrid Solheim",
  "Darnell Pryce",
  "Yesenia Calderón",
  "Pham Thi Lan",
  "Ruben Okafor",
  "Agnieszka Nowicka",
  "Lionel Batiste",
  "Corazon Dimaculangan",
  "Teresa Ambrose",
  "Wilbert Langford",
];

const urgencyFor = (roll: number): Slot["urgency"] => {
  if (roll < 0.2) return "low";
  if (roll < 0.75) return "medium";
  return "high";
};

const plainKind = (existedAtTime: boolean): SignalKind => (existedAtTime ? "paraphrase" : "new");

// Builds the schedule in one seeded pass; splitting it would reorder the RNG draws.
// oxlint-disable-next-line eslint/complexity
export const buildPlan = (recipe: Recipe, seed: number, prefix: string): Plan => {
  const personas = buildPersonas(recipe, seed, prefix);
  const rng = rngStream(seed, `${recipe.world}:schedule`);
  const { accounts, needs } = recipe;
  const splits = splitMonths(needs);
  const months = new Map(needs.map((need) => [need.key, effectiveMonthWeights(need, splits)]));
  const personasByAccount = new Map<string, Persona[]>();
  for (const persona of personas) {
    personasByAccount.set(persona.accountKey, [
      ...(personasByAccount.get(persona.accountKey) ?? []),
      persona,
    ]);
  }
  const accountsWithPeople = accounts.filter((account) => personasByAccount.has(account.key));

  const baseCount = TARGET_SIGNALS - RETRIES;
  const counts = apportion(
    needs.map((need) => need.arrival.weight),
    baseCount,
  );
  const slots: Slot[] = [];
  const scenarioCursor = new Map<string, string[]>();
  const nextScenario = (need: Need) => {
    let queue = scenarioCursor.get(need.key) ?? [];
    if (queue.length === 0) queue = shuffle(rng, need.scenarios);
    const [scenario, ...rest] = queue;
    scenarioCursor.set(need.key, rest);
    return scenario ?? need.scenarios[0] ?? "";
  };

  for (const [index, need] of needs.entries()) {
    const weights = months.get(need.key) ?? [];
    const monthList = weights.map((_, month) => month);
    const shared = sharedSolutions(need, needs);
    const own = need.solutions.filter((solution) => !shared.includes(solution));
    for (let n = 0; n < (counts[index] ?? 0); n += 1) {
      const month = pickWeighted(rng, monthList, (m) => weights[m] ?? 0);
      const fromRequester = need.requesterAccounts.length > 0 && rng.chance(REQUESTER_SHARE);
      const candidates = fromRequester
        ? need.requesterAccounts.flatMap((key) => accounts.find((a) => a.key === key) ?? [])
        : accountsWithPeople;
      const account = pickWeighted(rng, candidates, (a) =>
        fromRequester ? 1 : Math.sqrt(personasByAccount.get(a.key)?.length ?? 0),
      );
      const pool = personasByAccount.get(account.key) ?? [];
      if (pool.length === 0) throw new Error(`account ${account.key} has no personas`);
      const persona = pickWeighted(rng, pool, (p) => personaWeight(p, need));
      let intent: Intent = "plain";
      let solution: string | undefined;
      if (need.trap?.kind === "symptom_only") intent = "symptom";
      else if (shared.length && rng.chance(SAME_SOLUTION_SHARE)) {
        intent = "same_solution";
        solution = pick(rng, shared);
      } else if (own.length && rng.chance(NAMED_SOLUTION_SHARE)) solution = pick(rng, own);
      const escalation = roleClass(persona.role) === "escalation";
      const urgencyRoll = rng.next();
      slots.push({
        accountKey: account.key,
        actorKind: persona.actorKind,
        at: new Date(instantIn(rng, month)).toISOString(),
        channel: persona.channel,
        intent,
        needKeys: [need.key],
        personaKey: persona.key,
        scenarios: [nextScenario(need)],
        slot: slots.length,
        ...(solution ? { solution } : {}),
        urgency: escalation ? "high" : urgencyFor(urgencyRoll),
        useCase: rng.chance(USE_CASE_SHARE),
      });
    }
  }

  const monthOf = (slot: Slot) =>
    new Date(slot.at).getUTCMonth() -
    new Date(START).getUTCMonth() +
    12 * (new Date(slot.at).getUTCFullYear() - new Date(START).getUTCFullYear());
  const needByKey = new Map(needs.map((need) => [need.key, need]));
  const needOf = (key: string | undefined) => {
    const need = needByKey.get(key ?? "");
    if (!need) throw new Error(`unknown need ${key}`);
    return need;
  };
  const plainSlots = () => slots.filter((slot) => slot.intent === "plain" && !slot.planted);

  // Multi-ask: a second need active in the same month, often one the same account asks for.
  const multiTarget = Math.round(baseCount * MULTI_ASK_SHARE);
  for (const slot of shuffle(rng, plainSlots()).slice(0, multiTarget)) {
    const month = monthOf(slot);
    const eligible = needs.filter(
      (need) =>
        need.key !== slot.needKeys[0] &&
        need.trap?.kind !== "symptom_only" &&
        (months.get(need.key)?.[month] ?? 0) > 0,
    );
    const sameAccount = eligible.filter((need) => need.requesterAccounts.includes(slot.accountKey));
    const second =
      sameAccount.length && rng.chance(0.5)
        ? pick(rng, sameAccount)
        : pickWeighted(rng, eligible, (need) => need.arrival.weight);
    slot.intent = "multi_ask";
    slot.needKeys = [...slot.needKeys, second.key];
    slot.scenarios = [...slot.scenarios, nextScenario(second)];
    delete slot.solution;
  }

  // Planted PII: mostly the support copilot copying details from a ticket.
  const piiCandidates = slots.filter((slot) => !slot.planted && slot.intent !== "multi_ask");
  const copilotSlots = shuffle(
    rng,
    piiCandidates.filter((slot) => slot.actorKind === "agent"),
  );
  const otherSlots = shuffle(
    rng,
    piiCandidates.filter((slot) =>
      ["hr", "manager", "csm"].includes(
        roleClass(personas.find((p) => p.key === slot.personaKey)?.role ?? ""),
      ),
    ),
  );
  const piiSlots = [...copilotSlots.slice(0, 4), ...otherSlots.slice(0, PII - 4)];
  for (const [index, slot] of piiSlots.entries()) {
    const name = piiNames[index % piiNames.length] ?? "Jordan Example";
    const phone = `(${pick(rng, ["312", "415", "646", "702", "713", "206"])}) 555-01${String(rng.int(100)).padStart(2, "0")}`;
    const employeeId = `EMP-${String(10_000 + rng.int(90_000))}`;
    slot.planted = "pii";
    slot.pii = rng.chance(0.5) ? [name, phone, employeeId] : [name, employeeId];
  }

  // Planted invalid submissions: an extra slot each, blank where submit_signal needs text.
  // Clamped inside the year (same RNG draws as before, so earlier plans are unchanged).
  const end = monthStart(MONTHS);
  for (let n = 0; n < INVALID; n += 1) {
    const base = pick(rng, plainSlots());
    const at = Math.min(Date.parse(base.at) + (1 + rng.int(240)) * 60_000, end - 60_000);
    slots.push({
      ...base,
      at: new Date(at).toISOString(),
      invalidMode: n % 3 === 2 ? "blank-title" : "blank-body",
      needKeys: [...base.needKeys],
      planted: "invalid",
      scenarios: [nextScenario(needOf(base.needKeys[0]))],
      slot: slots.length,
    });
  }

  // Planted retries: the same web persona sends the same submission again minutes later.
  const retryCandidates = shuffle(
    rng,
    slots.filter(
      (slot) =>
        !slot.planted && slot.actorKind === "human" && Date.parse(slot.at) < end - 3_600_000,
    ),
  ).slice(0, RETRIES);
  for (const original of retryCandidates) {
    slots.push({
      ...original,
      at: new Date(Date.parse(original.at) + (1 + rng.int(20)) * 60_000).toISOString(),
      needKeys: [...original.needKeys],
      planted: "retry",
      retryOf: original.slot,
      scenarios: [...original.scenarios],
      slot: slots.length,
    });
  }

  return { personas, slots: sortSlots(slots) };
};

const sortSlots = (slots: Slot[]) =>
  slots.toSorted(
    (a, b) =>
      Date.parse(a.at) - Date.parse(b.at) ||
      Number(a.planted === "retry") - Number(b.planted === "retry") ||
      a.slot - b.slot,
  );

// --- labels ---------------------------------------------------------------------------------

/**
 * Labels for slots in time order, exactly as `checkWorld` replays them: `firstOccurrence`,
 * `existedAtTime`, and the kind (`new` or `paraphrase` for plain intents). Retries copy their
 * original's labels. Run again after any drop.
 */
export const labelSlots = (slots: Slot[], needs: Need[]): Map<number, WorldSignal["labels"]> => {
  const needsByKey = new Map(needs.map((need) => [need.key, need]));
  const parentOf = new Map(
    needs.flatMap((need) => (need.splitInto ?? []).map((child) => [child, need.key] as const)),
  );
  const mentioned = new Set<string>();
  /** Main needs of earlier counted signals: only these created a need (as `checkOrderLabels`). */
  const created = new Set<string>();
  const known = (key: string | undefined): boolean =>
    key !== undefined &&
    (Boolean(needsByKey.get(key)?.inBacklog) || created.has(key) || known(parentOf.get(key)));
  const labels = new Map<number, WorldSignal["labels"]>();
  for (const slot of slots) {
    if (slot.planted === "retry") {
      const original = labels.get(slot.retryOf ?? -1);
      if (original) labels.set(slot.slot, structuredClone(original));
      continue;
    }
    const counted = isCounted({ planted: slot.planted } as WorldSignal);
    const [main] = slot.needKeys;
    const existedAtTime = known(main);
    const kind: SignalKind = slot.intent === "plain" ? plainKind(existedAtTime) : slot.intent;
    labels.set(slot.slot, {
      existedAtTime,
      firstOccurrence: counted && main !== undefined && !mentioned.has(main),
      kind,
      needKeys: [...slot.needKeys],
    });
    if (counted) {
      for (const key of slot.needKeys) mentioned.add(key);
      if (main !== undefined) created.add(main);
    }
  }
  return labels;
};
