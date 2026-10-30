import { experimental_decide as decide } from "ai";

import { gatewayAvailable, gatewayDecisionModel, signalClassifierModelId } from "@/lib/ai/models";
import type { DecisionModel } from "@/lib/ai/models";

import { SignalError } from "../errors";
import type { MatchJudge } from "./ports";

/**
 * Closed-set classification on the classifier model (spec 008): Jev (`typesafe-ai/jev`) through
 * the AI Gateway, called with the AI SDK's `experimental_decide`. Jev answers typed questions with
 * calibrated probabilities; code turns them into decisions. Every question's wording lives here.
 */

/**
 * Match threshold for the Jev judge's `choice` design, tuned on the matching eval (spec 008): the
 * lowest threshold with false-match under 1% and new-need recall over 95%.
 */
export const JEV_MATCH_THRESHOLD = 0.65;

/** Jev answers in a few hundred ms (spec 008 probe); give up well before preview's budget. */
const CLASSIFIER_TIMEOUT_MS = 5000;

interface ClassifierOptions {
  /**
   * Match judge question design (spec 008): `choice` (default; won the eval) asks which
   * candidate is closest plus whether any is the same need, and gives each candidate
   * P(any) × P(that choice); `per_candidate` asks one boolean per candidate and has no tuned
   * threshold of its own.
   */
  design?: "choice" | "per_candidate";
  /** Injected in tests (`fakeDecisionModel`); defaults to `SIGNAL_CLASSIFIER_MODEL` on the Gateway. */
  model?: DecisionModel;
}

const unavailable = (what: string, cause: unknown) => {
  const error = new SignalError("ai_unavailable", `${what} is unavailable.`);
  error.cause = cause;
  return error;
};

const decideWith = async <Q extends Parameters<typeof decide>[0]["questions"]>(
  what: string,
  { model }: ClassifierOptions,
  state: Record<string, string | Record<string, string>>,
  questions: Q,
) => {
  if (!model && !gatewayAvailable())
    throw new SignalError("ai_unavailable", `${what} (no AI Gateway access) is unavailable.`);
  try {
    const { answers } = await decide({
      abortSignal: AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS),
      maxRetries: 1,
      model: model ?? gatewayDecisionModel(signalClassifierModelId()),
      questions,
      state,
    });
    return answers as Record<string, { probability?: number; type: string }>;
  } catch (error) {
    throw unavailable(what, error);
  }
};

const requestState = (
  { body, title }: { body: string; title: string },
  draftStatement?: string,
) => ({
  request: { body, title },
  ...(draftStatement ? { drafted_need: draftStatement } : {}),
});

const SAME_NEED = {
  false:
    "The outcome differs, even when both name the same feature: for example, both ask for PDF export, one to brief the board and one to archive records for an audit.",
  true: "The same kind of person wants the same outcome, even if the wording differs or a different feature is requested.",
} as const;

const sameNeedQuestion = (statement: string) =>
  ({
    criteria: SAME_NEED,
    instructions: `Does \`request\` ask for the same underlying need as this existing need: ${JSON.stringify(statement)}?`,
    type: "boolean",
  }) as const;

/** The reason shown with a judgement: Jev returns no prose, so code writes it from the probability. */
const reasonFor = (probability: number) => {
  if (probability >= 0.7) return "The same kind of person wants the same outcome.";
  if (probability >= 0.3) return "Possibly the same need; the outcome may be different.";
  return "A different outcome from this need.";
};

type JudgeInput = Parameters<MatchJudge["judge"]>[0];

/** The `choice` design: the request picks one candidate, and a companion boolean covers "none". */
const judgeByChoice = async (
  options: ClassifierOptions,
  { candidates, draft, submission }: JudgeInput,
) => {
  // Option names are sent to the model, so each option is named by its statement (deduplicated).
  const names = candidates.map((candidate, index) =>
    candidates.findIndex((other) => other.statement === candidate.statement) === index
      ? candidate.statement
      : `${candidate.statement} (${index + 1})`,
  );
  const answers = await decideWith(
    "Match judging",
    options,
    requestState(submission, draft?.statement),
    {
      any_same: {
        criteria: SAME_NEED,
        instructions: `Does \`request\` ask for the same underlying need as any of these existing needs: ${JSON.stringify(names)}?`,
        type: "boolean",
      },
      which: {
        criteria: Object.fromEntries(names.map((name) => [name, null])),
        instructions: "Which existing need is closest to the underlying need in `request`?",
        type: "choice",
      },
    },
  );
  const any = answers.any_same;
  const which = answers.which as
    | { probabilities?: Record<string, number>; type: string }
    | undefined;
  if (any?.type !== "boolean" || any.probability === undefined || which?.type !== "choice")
    return [];
  const anySame = any.probability;
  return candidates.map((candidate, index) => {
    const probability = Math.min(
      1,
      Math.max(0, anySame * (which.probabilities?.[names[index] ?? ""] ?? 0)),
    );
    return { needId: candidate.needId, probability, reason: reasonFor(probability) };
  });
};

/**
 * Judge step (decision 0012): one Jev call for all candidates, by the `choice` design unless
 * `per_candidate` is asked for. A refusal fails the whole call (`experimental_decide` returns no
 * partial answers), so preview degrades. Reasons are written in code from the probability.
 */
export const jevJudge = (options: ClassifierOptions = {}): MatchJudge => ({
  async judge({ candidates, draft, submission }) {
    if (candidates.length === 0) return [];
    if ((options.design ?? "choice") === "choice")
      return judgeByChoice(options, { candidates, draft, submission });
    const questions = Object.fromEntries(
      candidates.map((candidate, index) => [
        `candidate_${index + 1}`,
        sameNeedQuestion(candidate.statement),
      ]),
    );
    const answers = await decideWith(
      "Match judging",
      options,
      requestState(submission, draft?.statement),
      questions,
    );
    return candidates.flatMap((candidate, index) => {
      const answer = answers[`candidate_${index + 1}`];
      if (answer?.type !== "boolean" || answer.probability === undefined) return [];
      const probability = Math.min(1, Math.max(0, answer.probability));
      return [{ needId: candidate.needId, probability, reason: reasonFor(probability) }];
    });
  },
  get model() {
    return options.model?.modelId ?? signalClassifierModelId();
  },
  ...((options.design ?? "choice") === "choice" ? { threshold: JEV_MATCH_THRESHOLD } : {}),
});

/**
 * Multi-ask detection (spec 008, measured in the matching eval only): P(the submission asks for
 * more than one separate thing). The extractor still writes the additional asks' statements.
 */
export const jevMultiAskDetector = (options: ClassifierOptions = {}) => ({
  async detect(submission: { body: string; title: string }) {
    const answers = await decideWith("Multi-ask detection", options, requestState(submission), {
      multiple_asks: {
        criteria: {
          false:
            "Everything in it serves one outcome, even when it lists several details or steps of that one change.",
          true: "It asks for two or more separate changes that serve different outcomes, such as a report export and single sign-on.",
        },
        instructions: "Does `request` ask for more than one separate thing?",
        type: "boolean",
      },
    });
    const answer = answers.multiple_asks;
    if (answer?.type !== "boolean" || answer.probability === undefined)
      throw unavailable("Multi-ask detection", new Error("No boolean answer."));
    return answer.probability;
  },
});
