import { expect, test } from "@playwright/test";

import { signIn } from "./operator";

/** Needs (spec 006 task 05): one list_operator_needs table, filters and sort in the URL. */

const dollars = (text: string) => {
  const value = Number(text.replaceAll(/[$,kM]/gu, ""));
  if (text.endsWith("M")) return value * 1_000_000;
  if (text.endsWith("k")) return value * 1000;
  return value;
};

test("an unauthorized visit lands on the access page and the API refuses", async ({ page }) => {
  await page.goto("/operator/needs");
  await expect(page).toHaveURL(/\/operator\/access$/u);
  expect((await page.request.get("/api/operator/needs")).status()).toBe(401);
});

test("sorts and filters from the URL, and a row opens to its signals and scores", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/operator/needs");
  await expect(page.getByRole("heading", { level: 1, name: "Needs" })).toBeVisible();
  await expect(page.getByText(/needs · sorted by priority/u)).toBeVisible();
  const rows = page.locator("[data-need]");
  const total = await rows.count();
  expect(total).toBeGreaterThan(10);

  // Priority: scored needs first, highest score first, unscored (—) last.
  const scores = await page.getByTestId("need-score").allTextContents();
  const scored = scores.filter((score) => score !== "—").map(Number);
  expect(scored).toEqual(scored.toSorted((left, right) => right - left));
  expect(scores.slice(scored.length).every((score) => score === "—")).toBe(true);
  await expect(page.getByTestId("pending-marker").first()).toBeVisible();

  await page.getByRole("button", { name: "Sort by ARR" }).click();
  await expect(page).toHaveURL(/sort=arr/u);
  await expect(page.getByText(/sorted by arr/u)).toBeVisible();
  // The server re-renders with the new sort; wait for the rows to follow the URL.
  await expect
    .poll(async () => {
      const arr = (await page.getByTestId("need-arr").allTextContents()).map(dollars);
      return arr.every((value, index) => index === 0 || (arr[index - 1] ?? 0) >= value);
    })
    .toBe(true);

  await page.getByRole("combobox", { name: "Status" }).selectOption("open");
  await expect(page).toHaveURL(/status=open/u);
  await expect
    .poll(() => rows.evaluateAll((items) => [...new Set(items.map((item) => item.dataset.status))]))
    .toEqual(["open"]);

  await page.getByRole("searchbox", { name: "Search needs" }).fill("dashboard");
  await expect(page).toHaveURL(/q=dashboard/u);
  await expect
    .poll(async () =>
      (await rows.evaluateAll((items) => items.map((item) => item.textContent ?? ""))).every(
        (text) => /dashboard/iu.test(text),
      ),
    )
    .toBe(true);

  // The URL is the state: a reload keeps every filter.
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Status" })).toHaveValue("open");
  await expect(page.getByRole("searchbox", { name: "Search needs" })).toHaveValue("dashboard");
  await expect(page.getByRole("button", { name: "Sort by ARR" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const first = rows.first();
  const id = await first.getAttribute("data-need");
  await first.locator("[data-slot=ruled-row-trigger]").click();
  await expect(first.getByText("Most urgent signals")).toBeVisible();
  await expect(first.locator("figure blockquote").first()).toBeVisible();
  expect(await first.locator("figure").count()).toBeLessThanOrEqual(2);
  await expect(first.getByText("Score breakdown")).toBeVisible();
  await expect(first.getByRole("link", { name: /Open need/u })).toHaveAttribute(
    "href",
    `/operator/needs/${id}`,
  );

  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page).not.toHaveURL(/status=|q=/u);
  await expect(rows).toHaveCount(total);
});
