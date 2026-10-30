import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/** Opens an Operator session the way the access page does (POST /api/operator/session). */
export const signIn = async (page: Page) => {
  const response = await page.request.post("/api/operator/session", {
    data: { token: process.env.E2E_OPERATOR_SECRET },
  });
  expect(response.ok()).toBe(true);
};
