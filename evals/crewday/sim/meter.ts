import type { SignalAi } from "@/lib/signal/ai/ports";

/**
 * Counts every AI port call a run makes and attributes it to who caused it: an operation a policy
 * called (`op:<name>`), suggestion generation after a submit (`generation`), the day-0 backlog
 * load (`setup`), or anything else (`outside`). The PM policy has no AI port, so its own logic
 * can only reach a model "outside" an operation; the engine keeps that count at zero
 * (spec 004 → PM policy: "The policy never consults a model").
 */

export type AiPort = "embedder" | "extractor" | "judge" | "reasoner" | "retriever";
export type MeterPhase = "submitter" | "pm" | "generation" | "setup" | "score";

export interface AiCall {
  /** `op:<operation>` while an operation runs, else the phase itself. */
  cause: string;
  phase: MeterPhase;
  port: AiPort;
}

export interface AiMeter {
  calls: AiCall[];
  /** Model calls (not retrieval, which is a database query) in a phase outside any operation. */
  outsideOperations: (phase: MeterPhase) => number;
  /** Records one call on `port` (used by `meterAi`). */
  record: (port: AiPort) => void;
  /** Model calls attributed to a phase. */
  count: (filter?: { phase?: MeterPhase; port?: AiPort }) => number;
  setPhase: (phase: MeterPhase) => void;
  /** Runs `body` with calls attributed to `op:<name>`. */
  withOperation: <T>(name: string, body: () => Promise<T>) => Promise<T>;
}

export const createAiMeter = (): AiMeter => {
  const calls: AiCall[] = [];
  let phase: MeterPhase = "setup";
  let operation: string | undefined;
  const isModel = (call: AiCall) => call.port !== "retriever";
  return {
    calls,
    count: (filter = {}) =>
      calls.filter(
        (call) =>
          isModel(call) &&
          (!filter.phase || call.phase === filter.phase) &&
          (!filter.port || call.port === filter.port),
      ).length,
    outsideOperations: (target) =>
      calls.filter(
        (call) => isModel(call) && call.phase === target && !call.cause.startsWith("op:"),
      ).length,
    record: (port) => {
      calls.push({ cause: operation ? `op:${operation}` : phase, phase, port });
    },
    setPhase: (next) => {
      phase = next;
    },
    async withOperation(name, body) {
      const previous = operation;
      operation = name;
      try {
        return await body();
      } finally {
        operation = previous;
      }
    },
  };
};

/** Wraps every port of `ai` so each call is recorded on `meter`. */
export const meterAi = (ai: SignalAi, meter: AiMeter): SignalAi => {
  const { record } = meter;
  return {
    embedder: {
      embed: (texts) => {
        record("embedder");
        return ai.embedder.embed(texts);
      },
      model: ai.embedder.model,
    },
    extractor: {
      extract: (input) => {
        record("extractor");
        return ai.extractor.extract(input);
      },
    },
    judge: {
      judge: (input) => {
        record("judge");
        return ai.judge.judge(input);
      },
      model: ai.judge.model,
    },
    reasoner: {
      generate: (input) => {
        record("reasoner");
        return ai.reasoner.generate(input);
      },
    },
    retriever: {
      retrieve: (input) => {
        record("retriever");
        return ai.retriever.retrieve(input);
      },
    },
  };
};
