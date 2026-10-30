import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import next from "ultracite/oxlint/next";
import react from "ultracite/oxlint/react";

export default defineConfig({
  extends: [core, react, next],
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    ".agents/**",
    ".claude/**",
    ".eve/**",
    "components/**",
    "mcp-app/dist/**",
  ],
  overrides: [
    {
      files: ["providers/query-provider.tsx"],
      rules: {
        "react/hook-use-state": "off",
      },
    },
    {
      files: ["hooks/use-mobile.ts"],
      rules: {
        "react/set-state-in-effect": "off",
      },
    },
    {
      // Tests build database fixtures step by step and index into rows they just inserted;
      // browser specs (e2e) drive one page through ordered steps.
      files: ["tests/**", "e2e/**"],
      rules: {
        "eslint/no-await-in-loop": "off",
        "typescript/no-non-null-assertion": "off",
        "unicorn/no-await-expression-member": "off",
      },
    },
    {
      // The Crewday simulation replays a world in order: each step depends on the one before.
      files: ["evals/crewday/sim/**", "evals/crewday/score/**"],
      rules: {
        "eslint/no-await-in-loop": "off",
        "unicorn/no-await-expression-member": "off",
      },
    },
    {
      // A seeded PRNG is bit arithmetic by definition.
      files: ["evals/crewday/sim/rng.ts"],
      rules: {
        "eslint/no-bitwise": "off",
      },
    },
    {
      files: ["lib/genui/orchestration/stream.ts"],
      rules: {
        "eslint/no-await-in-loop": "off",
      },
    },
  ],
  rules: {
    curly: "off",
    "eslint/no-use-before-define": "off",
    "func-style": "off",
    "no-alert": "off",
    "react/function-component-definition": "off",
  },
});
