import { createGatewayAi } from "./ai/gateway";
import type { SignalAi } from "./ai/ports";
import { systemClock } from "./context";
import type { Actor, Clock, OperationContext } from "./context";
import { signalDbFor } from "./db";
import type { SignalDb } from "./db";
import { SignalError } from "./errors";

/**
 * Process-wide dependencies the adapters use to build an `OperationContext`.
 * Production reads `DATABASE_URL` and uses the AI Gateway. Tests swap the database (PGlite or
 * the local Docker database), AI, and the clock with `configureSignalRuntime`.
 */
interface RuntimeOverrides {
  ai?: SignalAi;
  clock?: Clock;
  db?: SignalDb;
}

let overrides: RuntimeOverrides = {};

export const configureSignalRuntime = (next: RuntimeOverrides) => {
  overrides = { ...overrides, ...next };
};

export const resetSignalRuntime = () => {
  overrides = {};
};

export const signalDatabaseUrl = () => process.env.DATABASE_URL?.trim() || undefined;

export const createOperationContext = (actor: Actor): OperationContext => {
  const databaseUrl = signalDatabaseUrl();
  const db = overrides.db ?? (databaseUrl ? signalDbFor(databaseUrl) : undefined);
  if (!db) throw new SignalError("database_unavailable", "The Signal database is not configured.");
  return {
    actor,
    ai: overrides.ai ?? createGatewayAi(),
    clock: overrides.clock ?? systemClock,
    db,
  };
};
