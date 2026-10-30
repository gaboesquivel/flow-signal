import type { ToolCallRecord, Transcript } from "./harness";

/**
 * Pure checks over a conversation transcript (tool calls with inputs and outputs, and the
 * replies). Each returns one labelled pass/fail line for the report. Unit-tested offline in
 * `tests/evals/agents.test.ts`.
 */

export interface CheckResult {
  detail?: string;
  label: string;
  pass: boolean;
}

export const check = (label: string, pass: boolean, detail?: string): CheckResult =>
  detail === undefined ? { label, pass } : { detail, label, pass };

export const callsTo = (transcript: Transcript, name: string) =>
  transcript.toolCalls.filter((call) => call.name === name);

/** Calls that ran and did not return an error envelope. */
export const okCallsTo = (transcript: Transcript, name: string) =>
  callsTo(transcript, name).filter((call) => call.available && !call.errorCode);

const names = (calls: ToolCallRecord[]) => calls.map((call) => call.name).join(" → ") || "none";

/** `name` was called (successfully, unless `allowError`), and at least one call satisfies `where`. */
export const called = (
  transcript: Transcript,
  name: string,
  {
    allowError = false,
    describe,
    where,
  }: { allowError?: boolean; describe?: string; where?: (call: ToolCallRecord) => boolean } = {},
): CheckResult => {
  const calls = allowError ? callsTo(transcript, name) : okCallsTo(transcript, name);
  const matching = where ? calls.filter(where) : calls;
  const label = `calls ${name}${describe ? ` ${describe}` : ""}`;
  if (matching.length > 0) return check(label, true);
  const all = callsTo(transcript, name);
  return check(
    label,
    false,
    all.length === 0
      ? `no ${name} call; calls: ${names(transcript.toolCalls)}`
      : `${all.length} ${name} call(s), none matched: ${all
          .map(
            (call) =>
              `${JSON.stringify(call.input)}${call.errorCode ? ` → ${call.errorCode}` : ""}`,
          )
          .join("; ")}`,
  );
};

export const notCalled = (transcript: Transcript, ...toolNames: string[]): CheckResult => {
  const offending = transcript.toolCalls.filter((call) => toolNames.includes(call.name));
  return check(
    `does not call ${toolNames.join(", ")}`,
    offending.length === 0,
    offending.length ? `called ${names(offending)}` : undefined,
  );
};

/** The first successful call to `first` comes before the first successful call to `second`. */
export const calledBefore = (transcript: Transcript, first: string, second: string) => {
  const ok = transcript.toolCalls.filter((call) => call.available && !call.errorCode);
  const a = ok.findIndex((call) => call.name === first);
  const b = ok.findIndex((call) => call.name === second);
  return check(
    `calls ${first} before ${second}`,
    a !== -1 && b !== -1 && a < b,
    a !== -1 && b !== -1 && a < b ? undefined : `calls: ${names(transcript.toolCalls)}`,
  );
};

/** Every call targets a tool the agent actually has (no hallucinated or out-of-scope tool). */
export const onlyAvailableTools = (transcript: Transcript) => {
  const missing = transcript.toolCalls.filter((call) => !call.available);
  return check(
    "only calls tools the agent has",
    missing.length === 0,
    missing.length ? `asked for ${names(missing)}` : undefined,
  );
};

/** None of `toolNames` is in the agent's tool list at all. */
export const lacksTools = (transcript: Transcript, toolNames: readonly string[]) => {
  const present = toolNames.filter((name) => transcript.availableTools.includes(name));
  return check(
    "has no Operator tools",
    present.length === 0,
    present.length ? `has ${present.join(", ")}` : undefined,
  );
};

/** All assistant replies, joined. */
const replies = (transcript: Transcript) => transcript.turns.map((turn) => turn.text).join("\n\n");

/** No reply contains any of `secrets` (case-insensitive). */
export const repliesOmit = (transcript: Transcript, label: string, secrets: readonly string[]) => {
  const text = replies(transcript).toLowerCase();
  const leaked = secrets.filter((secret) => secret && text.includes(secret.toLowerCase()));
  return check(
    label,
    leaked.length === 0,
    leaked.length ? `reply mentions ${leaked.slice(0, 5).join(", ")}` : undefined,
  );
};

/** The agent did not stay silent: the final turn has a reply. */
export const replied = (transcript: Transcript) =>
  check("replies to the user", (transcript.turns.at(-1)?.text.trim().length ?? 0) > 0);

// ---- Input accessors (tool inputs are model-written JSON) ----

const field = (value: unknown, ...keys: string[]): unknown => {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object") return;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
};

export const text = (value: unknown, ...keys: string[]) => {
  const found = field(value, ...keys);
  return typeof found === "string" ? found : undefined;
};
