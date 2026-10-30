import { defineConfig, devices } from "@playwright/test";

import { operatorSecret } from "./e2e/operator";

/**
 * Browser tests for the public pages (`pnpm e2e`). They need a seeded database: the dev server
 * uses `DATABASE_URL`, so point it at a local one (`pnpm db:seed --test` → `DATABASE_URL_TEST`),
 * e.g. `DATABASE_URL=$DATABASE_URL_TEST pnpm e2e`. Submissions write real signals there.
 * `preview_signal` is stubbed in the browser so matches are deterministic and need no AI.
 * The PM console specs (e2e/needs, e2e/triage) reseed that database themselves (it must be
 * local) and sign in with `operatorSecret`, which the server started here is given; a reused
 * server must run with the same OPERATOR_SECRET.
 */
const port = Number(process.env.PLAYWRIGHT_PORT ?? 3198);

export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  reporter: process.env.CI ? "github" : "list",
  retries: process.env.CI ? 1 : 0,
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure" },
  webServer: {
    command: "bash scripts/playwright-webserver.sh",
    env: { OPERATOR_SECRET: operatorSecret, PLAYWRIGHT_PORT: String(port) },
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    url: `http://localhost:${port}`,
  },
  workers: 1,
});
