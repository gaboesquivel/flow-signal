import { performance } from "node:perf_hooks";

import type { WorldSignal } from "../format";
import { trueKeys } from "./oracle";
import { draw, identityOf } from "./state";
import type { SimState, SubmissionRecord, SubmitChoice } from "./state";
import type { Surface } from "./surfaces";

/**
 * The submitter policy (spec 004 → Simulation, oracle + noise), one world signal at a time:
 *
 * 1. `preview_signal` with the title and body.
 * 2. A shown match is a true need (either need of a multi-ask) → attach with `pAttach`, else new.
 * 3. Only wrong matches shown → attach to the top one with `pWrong`, else new.
 * 4. `submit_signal` with the target, the world's use case, and an idempotency key. A planted
 *    retry resends its original's exact request (same key); a planted invalid signal is sent as
 *    written and its validation error recorded.
 */

const MIN_STATEMENT = 10;
const MAX_STATEMENT = 500;

export const idempotencyKeyFor = (world: string, signal: WorldSignal) =>
  `crewday:${world}:${signal.retryOf ?? signal.id}`;

/** A statement `submit_signal` accepts: the drafted one, padded with the body when too short. */
const statementFor = (drafted: string, signal: WorldSignal) => {
  const candidates = [drafted, signal.title, `${signal.title}: ${signal.body}`];
  const usable = candidates.map((text) => text.trim()).find((text) => text.length >= MIN_STATEMENT);
  return (usable ?? `${signal.title.trim()} (customer request)`).slice(0, MAX_STATEMENT);
};

const surfaceFor = (state: SimState, signal: WorldSignal): Surface => {
  const persona = state.world.personas.find((p) => p.key === signal.personaKey);
  return (persona?.channel ?? signal.channel) === "mcp" ? "public_mcp" : "rest";
};

const submitInput = (state: SimState, signal: WorldSignal, target: Record<string, unknown>) => {
  const persona = state.world.personas.find((p) => p.key === signal.personaKey);
  const account = state.world.accounts.find((a) => a.key === signal.accountKey);
  return {
    body: signal.body,
    company: account?.name,
    email: persona?.email,
    idempotencyKey: idempotencyKeyFor(state.world.manifest.world, signal),
    name: persona?.name,
    target,
    title: signal.title,
    urgency: signal.urgency,
    useCase: signal.useCase ?? undefined,
  };
};

const tokenOf = (trackingUrl: string) => trackingUrl.split("/").pop() ?? "";

interface Planned {
  choice: SubmitChoice;
  input: Record<string, unknown>;
  shown: string[];
}

/** Steps 1–3: preview, then attach to a shown need or ask for a new one. */
const previewAndChoose = async (
  state: SimState,
  signal: WorldSignal,
  surface: Surface,
): Promise<Planned> => {
  const started = performance.now();
  const preview = await state.router.call(surface, "preview_signal", {
    body: signal.body,
    title: signal.title,
  });
  state.log.previewLatencyMs.push(performance.now() - started);
  const data = preview.ok
    ? (preview.data as {
        draftNeed: { statement: string };
        matches: { needId: string }[];
        previewId: string;
      })
    : undefined;
  const shown = data?.matches.map((match) => match.needId) ?? [];
  const keys = trueKeys(signal);
  const identities = await Promise.all(shown.map((needId) => identityOf(state, needId)));
  const correct = shown.find((_id, i) => keys.includes(identities[i] ?? ""));
  let choice: SubmitChoice = "new";
  let target: Record<string, unknown> = {
    newNeed: { statement: statementFor(data?.draftNeed.statement ?? signal.title, signal) },
  };
  const rng = draw(state, `submitter:${signal.id}`);
  if (correct && rng.chance(state.policy.pAttach)) {
    choice = "attach_true";
    target = { needId: correct };
  } else if (!correct && shown[0] && rng.chance(state.policy.pWrong)) {
    choice = "attach_wrong";
    target = { needId: shown[0] };
  }
  return {
    choice,
    input: { ...submitInput(state, signal, target), previewId: data?.previewId },
    shown,
  };
};

const plan = (state: SimState, signal: WorldSignal, surface: Surface): Promise<Planned> => {
  if (signal.planted === "invalid")
    return Promise.resolve({
      choice: "invalid",
      input: submitInput(state, signal, {
        newNeed: { statement: statementFor(signal.title, signal) },
      }),
      shown: [],
    });
  const original = signal.retryOf ? state.sent.get(signal.retryOf) : undefined;
  if (signal.planted === "retry" && original)
    return Promise.resolve({ choice: "retry", input: original, shown: [] });
  return previewAndChoose(state, signal, surface);
};

/** Replays one world signal on its persona's surface and records what happened. */
export const replaySignal = async (state: SimState, signal: WorldSignal) => {
  const surface = surfaceFor(state, signal);
  const { choice, input, shown } = await plan(state, signal, surface);
  const result = await state.router.call(surface, "submit_signal", input);
  if (!result.ok) {
    state.log.invalid.push({
      code: result.code,
      message: result.message,
      worldSignalId: signal.id,
    });
    return;
  }
  const data = result.data as {
    attachedTo: "existing" | "draft";
    needId: string;
    signalId: string;
    trackingUrl: string;
  };
  const record: SubmissionRecord = {
    attachedTo: data.attachedTo,
    choice,
    needId: data.needId,
    shown,
    signalId: data.signalId,
    surface,
    token: tokenOf(data.trackingUrl),
    worldSignalId: signal.id,
  };
  state.log.submissions.push(record);
  if (choice === "retry") return;
  state.sent.set(signal.id, input);
  state.signalOrigin.set(data.signalId, signal.id);
  if (data.attachedTo === "draft") {
    state.identity.set(data.needId, signal.labels.needKeys[0] ?? "");
    state.readQueue.push(data.needId);
  }
};
