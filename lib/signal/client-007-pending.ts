// TEMPORARY (spec 007, UI slice): delete at integration, once `pnpm signal:client` generates
// `getStrategy`, `setStrategy`, and `listReadyNeeds` into `client.ts`. It only declares their
// types so the Operator "Decide" page type-checks before those operations land.
import type { SignalCallOptions, SignalResult } from "./client-runtime";
import type { Readiness, Strategy } from "./domain/strategy";

type DecisionStatus = "planned" | "in_progress" | "shipped" | "declined";

interface PendingOperations {
  get_strategy: {
    input: Record<string, never>;
    output: { defaults: Readiness; strategy: Strategy | null };
  };
  list_ready_needs: {
    input: { cursor?: string; limit?: number };
    output: {
      needs: {
        arrCents: number;
        brief: {
          recommendation: {
            capacityNote?: string;
            confidence?: number;
            note: string;
            status: DecisionStatus;
            strategyFit?: { inFocus: boolean; reason: string };
          };
          status: "pending" | "accepted" | "edited" | "rejected";
          suggestionId: string;
        } | null;
        needId: string;
        readyAt: string;
        statement: string;
        supporters: number;
      }[];
      nextCursor: string | null;
    };
  };
  set_strategy: {
    input: {
      capacityPerQuarter: number;
      focusThemeIds: string[];
      notes?: string;
      readinessArrCents: number;
      readinessSupporters: number;
      revenueFocus: string;
    };
    output: { newlyReady: number; strategy: Strategy };
  };
}

declare module "./client" {
  interface SignalOperations {
    get_strategy: PendingOperations["get_strategy"];
    list_ready_needs: PendingOperations["list_ready_needs"];
    set_strategy: PendingOperations["set_strategy"];
  }
  interface SignalClient {
    getStrategy: (
      input: PendingOperations["get_strategy"]["input"],
      call?: SignalCallOptions,
    ) => Promise<SignalResult<PendingOperations["get_strategy"]["output"]>>;
    listReadyNeeds: (
      input: PendingOperations["list_ready_needs"]["input"],
      call?: SignalCallOptions,
    ) => Promise<SignalResult<PendingOperations["list_ready_needs"]["output"]>>;
    setStrategy: (
      input: PendingOperations["set_strategy"]["input"],
      call?: SignalCallOptions,
    ) => Promise<SignalResult<PendingOperations["set_strategy"]["output"]>>;
  }
}
