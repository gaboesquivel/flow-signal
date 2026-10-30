import { eq } from "drizzle-orm";

import { signals } from "@/lib/db/schema";
import type { SignalDb } from "@/lib/signal/db";

import type { World } from "../format";
import type { SimClock } from "./clock";
import type { AiMeter } from "./meter";
import type { NearestNeed, WorldIndex } from "./oracle";
import type { PolicyParams } from "./policy";
import type { Rng } from "./rng";
import type { Surface, SurfaceRouter } from "./surfaces";

/** What the run records beside the database: the policies' own log (spec 004 → Metrics). */

export type Arm = "signal" | "board";

export type SubmitChoice = "attach_true" | "attach_wrong" | "new" | "retry" | "invalid";

export interface SubmissionRecord {
  attachedTo: "existing" | "draft";
  choice: SubmitChoice;
  needId: string;
  /** Needs the preview showed, in order (empty for retries and invalid signals). */
  shown: string[];
  signalId: string;
  surface: Surface;
  /** The private tracking token (last segment of `trackingUrl`). */
  token: string;
  worldSignalId: string;
}

export interface InvalidRecord {
  code: string;
  message: string;
  worldSignalId: string;
}

export type ActionClass = "organizing" | "deciding";

export interface PmAction {
  at: string;
  class: ActionClass;
  /** Operation name, `read` (one raw signal), or `hand_brief` (board arm brief). */
  what: string;
  week: number;
}

export interface VerdictRecord {
  /** What the PM did (after noise). */
  applied: "accept" | "edit" | "reject";
  kind: string;
  needId: string | null;
  /** Did resolve_suggestion succeed? A conflict (need changed) applies nothing. */
  resolved: boolean;
  suggestionId: string;
  /** What ground truth says. */
  truth: "accept" | "edit" | "reject";
  trueNeedKey: string | null;
}

export interface DecisionRecord {
  at: string;
  needId: string;
  needKey: string | null;
  /** When the PM first saw the need ready. */
  readyAt: string;
  status: "planned" | "declined";
  via: "brief" | "hand";
}

export interface SimLog {
  actions: PmAction[];
  decisions: DecisionRecord[];
  invalid: InvalidRecord[];
  previewLatencyMs: number[];
  submissions: SubmissionRecord[];
  verdicts: VerdictRecord[];
}

export interface SimState {
  arm: Arm;
  clock: SimClock;
  db: SignalDb;
  /** Database need id → true need key, for needs whose creator is known. */
  identity: Map<string, string>;
  index: WorldIndex;
  log: SimLog;
  meter: AiMeter;
  nearest: NearestNeed;
  pending: (() => Promise<unknown>)[];
  policy: PolicyParams;
  /** Draft or backlog needs the PM has not read yet, oldest first. */
  readQueue: string[];
  rng: { pm: Rng; submitter: Rng };
  router: SurfaceRouter;
  /** `submit_signal` requests sent, by world signal id, so a planted retry resends one exactly. */
  sent: Map<string, Record<string, unknown>>;
  /** Database signal id → world signal id. */
  signalOrigin: Map<string, string>;
  world: World;
}

/** The plurality main need of a need's current signals; ties by key. */
const pluralityKey = async (state: SimState, needId: string) => {
  const rows = await state.db
    .select({ id: signals.id })
    .from(signals)
    .where(eq(signals.needId, needId));
  const counts = new Map<string, number>();
  for (const row of rows) {
    const worldId = state.signalOrigin.get(row.id);
    const key = worldId ? state.index.signals.get(worldId)?.labels.needKeys[0] : undefined;
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
};

/**
 * A database need's true need: from its creator when known, else (a need `split_need` created)
 * the plurality of its signals' main needs, which is then remembered.
 */
export const identityOf = async (state: SimState, needId: string) => {
  const known = state.identity.get(needId);
  if (known) return known;
  const key = await pluralityKey(state, needId);
  if (key) state.identity.set(needId, key);
  return key;
};
