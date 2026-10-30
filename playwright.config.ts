import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests on seeded data (spec 006 → Testing Decisions). Needs the local Docker database
 * (`pnpm db:up`); global setup reseeds E2E_DATABASE_URL, which must be local. Starts its own
 * `next dev` with a throwaway Operator secret, so stop any other dev server in this checkout.
 *   pnpm e2e
 */

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3198);
const databaseUrl =
  process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/signal_e2e";
/** Test-only value for the local server Playwright starts; never a deployment secret. */
const operatorSecret = process.env.E2E_OPERATOR_SECRET ?? "e2e-operator-secret-local-only";

process.env.E2E_DATABASE_URL = databaseUrl;
process.env.E2E_OPERATOR_SECRET = operatorSecret;

export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  globalSetup: "./e2e/global-setup.ts",
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  reporter: process.env.CI ? "github" : "list",
  retries: 0,
  testDir: "e2e",
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure" },
  webServer: {
    command: `pnpm exec next dev -p ${port}`,
    env: { DATABASE_URL: databaseUrl, OPERATOR_SECRET: operatorSecret },
    reuseExistingServer: false,
    timeout: 120_000,
    url: `http://localhost:${port}/operator/access`,
  },
  // Specs share one seeded database and change it; run them in order.
  workers: 1,
});
