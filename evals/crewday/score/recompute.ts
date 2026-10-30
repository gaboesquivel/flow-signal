import type { RunSnapshot } from "../sim/engine";

/**
 * The scorer's own prevention rate, recomputed from the event log with `get_metrics`' rules
 * (lib/signal/metrics.ts) so the two can be cross-checked: signals created in [from, to)
 * (each signal once) attached to an existing need, over those plus signals whose draft need was
 * merged before `to` by a merge no `merge.undone` reverted before `to`; split by actor kind.
 */

type SnapshotEvent = RunSnapshot["events"][number];

export interface PreventionCounts {
  attachedToExisting: number;
  mergedDrafts: number;
  rate: number | null;
}

export interface PreventionSplit {
  agent: PreventionCounts;
  all: PreventionCounts;
  human: PreventionCounts;
}

const rate = (attached: number, merged: number) =>
  attached + merged === 0 ? null : Math.round((attached / (attached + merged)) * 10_000) / 10_000;

const counts = (attached: number, merged: number): PreventionCounts => ({
  attachedToExisting: attached,
  mergedDrafts: merged,
  rate: rate(attached, merged),
});

export const recomputePrevention = (
  events: SnapshotEvent[],
  { from, to }: { from: Date; to: Date },
): PreventionSplit => {
  const before = (event: SnapshotEvent) => Date.parse(event.occurredAt) < to.getTime();
  const undone = new Set(
    events
      .filter((e) => e.type === "merge.undone" && before(e))
      .map((e) => String(e.payload.mergeId)),
  );
  const mergedAway = new Set(
    events
      .filter(
        (e) =>
          e.type === "need.merged" &&
          e.needId &&
          before(e) &&
          !undone.has(String(e.payload.mergeId)),
      )
      .map((e) => e.needId),
  );
  const seen = new Set<string>();
  const tally = { agent: [0, 0], human: [0, 0] } as Record<"agent" | "human", [number, number]>;
  const created = events
    .filter(
      (e) =>
        e.type === "signal.created" &&
        Date.parse(e.occurredAt) >= from.getTime() &&
        Date.parse(e.occurredAt) < to.getTime(),
    )
    .toSorted((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  for (const event of created) {
    const id = event.signalId ?? "";
    if (seen.has(id)) continue;
    seen.add(id);
    const kind = event.actorKind === "agent" ? "agent" : "human";
    if (event.payload.attachedTo === "existing") tally[kind][0] += 1;
    else if (event.payload.attachedTo === "draft" && mergedAway.has(event.needId))
      tally[kind][1] += 1;
  }
  return {
    agent: counts(...tally.agent),
    all: counts(tally.agent[0] + tally.human[0], tally.agent[1] + tally.human[1]),
    human: counts(...tally.human),
  };
};
