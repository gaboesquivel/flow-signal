/**
 * Contract: live evals (real model calls, real spend) never run in CI. CI runs `pnpm qa` only
 * (spec 001 → Testing Decisions); evals run locally, on demand. Every live eval entry point calls
 * this before doing anything, and `tests/evals/ci-contract.test.ts` checks that they do and that
 * no workflow invokes them.
 */
export const refuseInCi = (name: string) => {
  if (!process.env.CI) return;
  console.error(
    `[${name}] refused: live evals never run in CI (CI is set). Run it locally, on demand.`,
  );
  process.exit(1);
};
