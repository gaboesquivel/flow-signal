/**
 * Behaviour parameters for the scripted submitter and PM (spec 004 → Simulation). The defaults
 * are the spec's hypotheses; the sweep (task 05) varies them. Every probability is per decision
 * and drawn from the run's seeded streams.
 */
export interface PolicyParams {
  /** Submitter: attach when the preview shows the signal's true need. */
  pAttach: number;
  /** Submitter: attach to the top wrong match when only wrong matches are shown. */
  pWrong: number;
  /** PM: actions per simulated week (operation calls and raw-signal reads cost one each). */
  pmActions: number;
  /** PM: chance that a triage verdict or a decision flips against ground truth. */
  pPmError: number;
  /** PM: chance per raw-signal read of spotting a duplicate the AI did not propose. */
  pManualFind: number;
  /** PM: at most this many triage actions (listing and resolving suggestions) per week. */
  triageActionCap: number;
  /**
   * PM: a need is ready for a decision when its distinct supporting accounts' ARR (in cents)
   * reaches this line (spec 004 → "the policy's readiness line").
   */
  readinessArrCents: number;
  /** PM: actions to write a decision brief by hand (the vote-board arm has no drafted brief). */
  handBriefActions: number;
  /** Scorer: a ready need's decision counts for revenue coverage within this many days. */
  coverageWindowDays: number;
}

export const defaultPolicy: PolicyParams = {
  coverageWindowDays: 60,
  handBriefActions: 5,
  pAttach: 0.8,
  pManualFind: 0.3,
  pPmError: 0.05,
  pWrong: 0.1,
  pmActions: 60,
  readinessArrCents: 10_000_000,
  triageActionCap: 30,
};

export const resolvePolicy = (overrides: Partial<PolicyParams> = {}): PolicyParams => ({
  ...defaultPolicy,
  ...overrides,
});
