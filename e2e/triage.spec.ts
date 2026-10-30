import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { signIn } from "./operator";

/**
 * Triage keyboard flow (spec 006 task 05; acceptance step 5). The e2e seed puts a pending merge
 * first (newest) and a split second, ahead of the demo seed's drafts, theme, and summary.
 */

const row = (page: Page, kind: string) => page.locator(`[data-kind=${kind}]`).first();

/** J until the row of this kind is the open one. */
const moveTo = async (page: Page, target: Locator) => {
  for (let step = 0; step < 12; step += 1) {
    if ((await target.getAttribute("data-state")) === "open") return;
    await page.keyboard.press("j");
  }
  await expect(target).toHaveAttribute("data-state", "open");
};

const pendingCount = async (page: Page) =>
  Number(/\d+/u.exec((await page.getByTestId("pending-count").textContent()) ?? "")?.[0]);

test("clears the queue from the keyboard", async ({ page }) => {
  await signIn(page);
  await page.goto("/operator/triage");
  await expect(page.getByRole("heading", { level: 1, name: "Triage" })).toBeVisible();
  const before = await pendingCount(page);
  expect(before).toBeGreaterThan(3);

  // The newest suggestion, a merge, is open and read side by side.
  const merge = row(page, "merge");
  await expect(merge).toHaveAttribute("data-state", "open");
  await expect(merge.getByRole("heading", { name: /^From/u })).toBeVisible();
  await expect(merge.getByRole("heading", { name: /^Into/u })).toBeVisible();
  await expect(merge.locator("[data-slot=pencil][data-state=suggested]").first()).toBeVisible();

  // A accepts; the next row opens, and Undo merge stays on the merge row.
  await page.keyboard.press("a");
  await expect(merge).toHaveAttribute("data-outcome", "accept");
  await expect(row(page, "split")).toHaveAttribute("data-state", "open");
  await expect.poll(() => pendingCount(page)).toBe(before - 1);
  await merge.getByRole("button", { name: "Undo merge" }).click();
  await expect(merge).toHaveAttribute("data-outcome", "undone");

  // K goes back, J forward; Esc closes the open row.
  await page.keyboard.press("k");
  await expect(merge).toHaveAttribute("data-state", "open");
  await page.keyboard.press("Escape");
  await expect(merge).toHaveAttribute("data-state", "closed");

  // J/K to the theme suggestion, R, a reason, Enter: rejected with the reason.
  const theme = row(page, "theme");
  await moveTo(page, theme);
  await page.keyboard.press("r");
  await expect(page.getByLabel(/Why reject/u)).toBeFocused();
  await page.keyboard.type("Too broad");
  await page.keyboard.press("Enter");
  await expect(theme).toHaveAttribute("data-outcome", "reject");
  await expect(theme.locator("[data-slot=ruled-row-trigger]")).toContainText("Rejected");

  // A public summary that names a supporting account is blocked until edited.
  const summary = row(page, "public_summary");
  await moveTo(page, summary);
  await expect(summary.getByTestId("check-line")).toContainText("No names");
  const needHref = await summary.getByRole("link", { name: /Open need/u }).getAttribute("href");
  const detail = await page.request.get(`/api${needHref}`);
  const account = ((await detail.json()) as { accounts: { name: string }[] }).accounts[0]?.name;
  expect(account).toBeTruthy();
  await page.keyboard.press("e");
  await page.keyboard.type(` Asked by ${account}.`);
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(summary.getByTestId("check-line")).toContainText(account ?? "");
  await expect(summary).toHaveAttribute("data-outcome", "pending");
  await page.keyboard.press("Escape");
  await expect(summary.getByRole("button", { name: /Accept/u })).toBeEnabled();

  // Reject what is left: the queue ends in a calm "All caught up".
  for (let step = 0; step < 20; step += 1) {
    if (await page.getByTestId("caught-up").isVisible()) break;
    const open = page.locator("[data-suggestion][data-state=open][data-outcome=pending]");
    const id = (await open.count()) > 0 ? await open.first().getAttribute("data-suggestion") : null;
    if (id) {
      await page.keyboard.press("r");
      await page.keyboard.press("Enter");
      await expect(page.locator(`[data-suggestion="${id}"]`)).toHaveAttribute(
        "data-outcome",
        "reject",
      );
    } else await page.keyboard.press("j");
  }
  await expect(page.getByTestId("caught-up")).toContainText("All caught up");
  await expect(page.getByRole("heading", { level: 1, name: "Triage" })).toBeVisible();
});
