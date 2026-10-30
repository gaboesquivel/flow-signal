import { execFileSync } from "node:child_process";

import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/** The Operator secret for the server Playwright starts: a local test value, never a real one. */
export const operatorSecret = process.env.OPERATOR_SECRET ?? "e2e-operator-secret-local-only";

/**
 * Reseeds the e2e database (DATABASE_URL, which must be local) with the demo workspace plus a
 * pending merge and split (e2e/seed-console.ts), so a console spec starts from a known queue.
 */
export const reseedConsole = () => {
  execFileSync(process.execPath, ["--import", "tsx", "e2e/seed-console.ts"], {
    env: {
      ...process.env,
      E2E_DATABASE_URL: process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL,
    },
    stdio: "inherit",
  });
};

/** Opens an Operator session the way the access page does (POST /api/operator/session). */
export const signIn = async (page: Page) => {
  const response = await page.request.post("/api/operator/session", {
    data: { token: operatorSecret },
  });
  expect(response.ok()).toBe(true);
};
