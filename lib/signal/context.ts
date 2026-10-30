import { z } from "zod";

import type { SignalAi } from "./ai/ports";
import type { SignalDb } from "./db";

export const actorSchema = z.object({
  /** Agent client: MCP client name, or `eve:<agent>` for Eve agent tools. */
  client: z.string().optional(),
  kind: z.enum(["human", "agent"]),
  /** Who acted, for the event log: an MCP client, an Eve session, or `web`. Never PII. */
  ref: z.string(),
});
export type Actor = z.infer<typeof actorSchema>;

export interface Clock {
  now: () => Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** What every operation's `run` receives. Adapters build it; operations never read env. */
export interface OperationContext {
  actor: Actor;
  /** AI ports; fakes in tests (`lib/signal/ai/fakes.ts`). */
  ai: SignalAi;
  clock: Clock;
  /** Drizzle on Neon (the spec's `repo`); wrap writes and `recordEvent` in `db.transaction`. */
  db: SignalDb;
}
