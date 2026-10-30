import path from "node:path";
import { defineConfig } from "vitest/config";

const exclude = [
  "node_modules/**",
  ".agents/**",
  ".claude/**",
  ".next/**",
  "**/.eve/**",
  "mcp-app/**",
];
/** Tests that share the Neon test branch; one fork runs their files one at a time. */
const databaseTests = ["tests/signal/**/*.test.ts"];

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname),
    },
  },
  test: {
    environment: "node",
    pool: "forks",
    projects: [
      {
        extends: true,
        test: {
          exclude: [...exclude, ...databaseTests],
          include: ["**/*.test.ts"],
          name: "unit",
          setupFiles: ["tests/setup/database-env.ts"],
        },
      },
      {
        extends: true,
        test: {
          exclude,
          hookTimeout: 60_000,
          include: databaseTests,
          name: "signal",
          poolOptions: { forks: { singleFork: true } },
          setupFiles: ["tests/setup/database-env.ts"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
