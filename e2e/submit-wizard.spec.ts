import { setTimeout } from "node:timers/promises";

import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";

/**
 * The public submit wizard (spec 006 task 04): Describe → Check → Details → Done, the remembered
 * My signals link, and Start a new link. `preview_signal` is stubbed in the browser with real
 * needs from the seeded board, so matches are deterministic; submissions hit the real API.
 */

interface BoardNeed {
  id: string;
  statement: string;
  status: string;
  supporterCount: number;
  demandBand: string;
}

const LINK_KEY = "signal.myLink";

const boardNeeds = async (request: APIRequestContext) => {
  const response = await request.get("/api/needs?limit=5&status=open");
  expect(response.ok()).toBe(true);
  const { needs } = (await response.json()) as { needs: BoardNeed[] };
  expect(needs.length).toBeGreaterThanOrEqual(3);
  return needs.slice(0, 4);
};

type PreviewStub =
  | { kind: "matches"; needs: BoardNeed[]; asks?: string[] }
  | { kind: "unavailable" }
  | { kind: "database_unavailable" };

/** Stubs `preview_signal` and counts the calls. */
const stubPreview = async (page: Page, stub: PreviewStub) => {
  const calls: unknown[] = [];
  await page.route("**/api/signals/preview", async (route) => {
    calls.push(route.request().postDataJSON());
    if (stub.kind === "database_unavailable") {
      await route.fulfill({
        json: {
          error: { code: "database_unavailable", message: "down", retryable: true },
        },
        status: 503,
      });
      return;
    }
    const matches =
      stub.kind === "matches"
        ? stub.needs.map((need, index) => ({
            demandBand: need.demandBand,
            needId: need.id,
            probability: 0.9 - index * 0.1,
            reason: `Reason ${index + 1}: same problem, said differently.`,
            statement: need.statement,
            status: need.status,
            supporterCount: need.supporterCount,
          }))
        : [];
    // A short delay so the loading line shows.
    await setTimeout(300);
    await route.fulfill({
      json: {
        ai: stub.kind === "matches" ? "ok" : "unavailable",
        draftNeed: {
          additionalAsks: stub.kind === "matches" ? (stub.asks ?? []) : [],
          statement:
            "Finance leaders need to share current dashboard numbers in the board pack so that the board sees this month's revenue",
        },
        matches,
        previewId: "pv_e2e",
      },
    });
  });
  return calls;
};

const describe = async (page: Page, title: string, body: string) => {
  await page.getByLabel("In a few words, what do you need?").fill(title);
  await page.getByLabel(/What's getting in the way/u).fill(body);
};

const fillDetails = async (page: Page, email: string) => {
  await page.getByLabel("How does this affect you?").fill("board pack every month, ~2 hours");
  await page.getByText("High", { exact: true }).click();
  await page.getByLabel("Email").fill(email);
};

const doneLink = async (page: Page) => {
  const link = page.locator("#tracking-link");
  await expect(link).toBeVisible();
  return link.inputValue();
};

const rememberedLink = (page: Page) =>
  page.evaluate((key) => window.localStorage.getItem(key), LINK_KEY);

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

test("checks once on Continue, reads the selected match side by side, and Back keeps the words", async ({
  page,
  request,
}) => {
  const needs = await boardNeeds(request);
  const calls = await stubPreview(page, {
    asks: ["Editable charts for slides"],
    kind: "matches",
    needs,
  });
  await page.goto("/submit");
  await describe(
    page,
    "Monthly PDF of the revenue dashboard",
    "Our CFO wants a PDF of the revenue dashboard every month for the board pack.",
  );
  // Nothing is checked while typing.
  await page.waitForTimeout(800);
  expect(calls).toHaveLength(0);
  await expect(page.getByText(/people$/u)).toHaveCount(0);

  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/step=check/u);
  await expect(page.getByText("Looking for needs like yours…")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Others may have asked for this already." }),
  ).toBeVisible();
  expect(calls).toHaveLength(1);

  // Up to three matches, the first selected and read next to the person's words.
  const radios = page.getByRole("radio");
  await expect(radios).toHaveCount(3);
  await expect(radios.first()).toBeChecked();
  const selectedPane = page.getByRole("region", { name: "The selected need" });
  await expect(selectedPane.getByText(needs[0]!.statement)).toBeVisible();
  await expect(selectedPane.getByText("Reason 1: same problem, said differently.")).toBeVisible();
  const yours = page.getByRole("region", { name: "What you wrote" });
  await expect(yours.getByText("Monthly PDF of the revenue dashboard")).toBeVisible();
  await expect(yours.getByText("Your need, as we understand it")).toBeVisible();
  await expect(page.getByTestId("additional-asks")).toContainText("Editable charts for slides");

  await radios.nth(1).check();
  await expect(selectedPane.getByText(needs[1]!.statement)).toBeVisible();
  await expect(selectedPane.getByText("Reason 2: same problem, said differently.")).toBeVisible();

  // Back keeps the words; continuing with the same words does not check again.
  await page.getByRole("button", { name: "Back to your words" }).click();
  // Describe is the default step, so the URL drops `?step=`.
  await expect(page).not.toHaveURL(/step=/u);
  await expect(page.getByLabel("In a few words, what do you need?")).toHaveValue(
    "Monthly PDF of the revenue dashboard",
  );
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/step=check/u);
  await expect(radios).toHaveCount(3);
  expect(calls).toHaveLength(1);

  // Changed words are checked again.
  await page.getByRole("button", { name: "Back to your words" }).click();
  await expect(page).not.toHaveURL(/step=/u);
  await page
    .getByLabel(/What's getting in the way/u)
    .fill("A monthly PDF for the board pack, please.");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/step=check/u);
  await expect(radios).toHaveCount(3);
  expect(calls).toHaveLength(2);

  // Browser back walks the steps too.
  await page.goBack();
  await expect(page.getByLabel("In a few words, what do you need?")).toHaveValue(
    "Monthly PDF of the revenue dashboard",
  );
});

test("adds a voice, then carries the next request onto the same My signals link", async ({
  page,
  request,
}) => {
  const needs = await boardNeeds(request);
  await stubPreview(page, { kind: "matches", needs });
  const run = unique();

  await page.goto("/submit");
  await describe(page, `Board PDF ${run}`, "Our CFO wants a PDF of the dashboard every month.");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Add my voice to this need" }).click();
  await expect(page).toHaveURL(/step=details/u);
  await expect(page.getByText("Adding your voice to")).toBeVisible();
  await expect(page.getByTestId("lands-statement")).toHaveText(needs[0]!.statement);
  // First submission from this browser: no link to file under yet.
  await expect(page.getByTestId("link-line")).toHaveCount(0);
  await expect(
    page.getByText("Your words are kept as you wrote them and shown only to the product team."),
  ).toBeVisible();
  await fillDetails(page, `maya+${run}@acme.example`);
  await page.getByRole("button", { name: "Add my voice" }).click();

  await expect(page).toHaveURL(/step=done/u);
  await expect(page.getByText("Your voice was added to")).toBeVisible();
  const first = await doneLink(page);
  expect(first).toMatch(/\/my\/[\w-]{16,}$/u);
  await expect(page.getByTestId("link-note")).toContainText("new private link");
  expect(await rememberedLink(page)).toBe(first.split("/my/")[1]);

  // The next request files under the remembered link.
  await page.getByRole("button", { name: "Submit another request" }).click();
  await expect(page.getByLabel("In a few words, what do you need?")).toHaveValue("");
  await describe(page, `Archive ${run}`, "We need a fixed monthly copy of reports for auditors.");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /None of these/u }).click();
  await expect(page.getByText("New need", { exact: true })).toBeVisible();
  await expect(page.getByTestId("link-line")).toContainText("Filing under your My signals page");
  // Contact details carry over to the next request.
  await expect(page.getByLabel("Email")).toHaveValue(`maya+${run}@acme.example`);
  await page.getByRole("button", { name: "Submit request" }).click();

  await expect(page.getByText(/started a new need/u)).toBeVisible();
  expect(await doneLink(page)).toBe(first);
  await expect(page.getByTestId("link-note")).toContainText("already have");

  // Both signals on one page, newest first.
  await page.getByRole("link", { name: "Open My signals" }).click();
  await expect(page.getByRole("heading", { name: "My signals" })).toBeVisible();
  const items = page.getByTestId("my-signal");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText(`Archive ${run}`);
  await expect(items.nth(1)).toContainText(`Board PDF ${run}`);
  await expect(items.nth(1)).toContainText("You added your voice to");
});

test("Start a new link files the request under a new link and remembers it", async ({
  page,
  request,
}) => {
  const needs = await boardNeeds(request);
  await stubPreview(page, { kind: "matches", needs });
  const run = unique();

  await page.goto("/submit");
  await describe(page, `Shared computer ${run}`, "Someone else used this browser before me.");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Add my voice to this need" }).click();
  await fillDetails(page, `first+${run}@acme.example`);
  await page.getByRole("button", { name: "Add my voice" }).click();
  const first = await doneLink(page);

  await page.getByRole("button", { name: "Submit another request" }).click();
  await describe(page, `My own request ${run}`, "I want my own page, not theirs.");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Add my voice to this need" }).click();
  await page.getByRole("button", { name: "Start a new link" }).click();
  await expect(page.getByTestId("link-line")).toHaveText(
    "This request starts a new My signals link.",
  );
  expect(await rememberedLink(page)).toBeNull();
  await page.getByLabel("Email").fill(`second+${run}@acme.example`);
  await page.getByRole("button", { name: "Add my voice" }).click();

  const second = await doneLink(page);
  expect(second).not.toBe(first);
  await expect(page.getByTestId("link-note")).toContainText("new private link");
  expect(await rememberedLink(page)).toBe(second.split("/my/")[1]);

  await page.goto(new URL(second).pathname);
  await expect(page.getByTestId("my-signal")).toHaveCount(1);
  await expect(page.getByTestId("my-signal")).toContainText(`My own request ${run}`);
});

test("a remembered link that no longer resolves gets a new link, and Done says so", async ({
  page,
  request,
}) => {
  const needs = await boardNeeds(request);
  await stubPreview(page, { kind: "matches", needs });
  await page.addInitScript((key) => {
    if (!window.sessionStorage.getItem("seeded")) {
      window.localStorage.setItem(key, "gone-link-0000000000000000");
      window.sessionStorage.setItem("seeded", "1");
    }
  }, LINK_KEY);
  await page.goto("/submit");
  await describe(page, `Stale link ${unique()}`, "My old link was from a different database.");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Add my voice to this need" }).click();
  await expect(page.getByTestId("link-line")).toContainText("Filing under your My signals page");
  await page.getByLabel("Email").fill("stale@acme.example");
  await page.getByRole("button", { name: "Add my voice" }).click();
  await expect(page.getByTestId("link-note")).toContainText("no longer works");
});

test("with matching unavailable, the request is still submitted as a new need", async ({
  page,
}) => {
  await stubPreview(page, { kind: "unavailable" });
  await page.goto("/submit");
  await describe(page, `No AI ${unique()}`, "Matching is down but I still want to be heard.");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("heading", { name: "Matching is unavailable right now" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Submit as a new need" }).click();
  await expect(page.getByText("New need", { exact: true })).toBeVisible();
  await page.getByLabel("Email").fill("noai@acme.example");
  await page.getByRole("button", { name: "Submit request" }).click();
  await expect(page.getByText(/started a new need/u)).toBeVisible();
});

test("when the database is unavailable at Check, the step explains it and offers a retry", async ({
  page,
}) => {
  const calls = await stubPreview(page, { kind: "database_unavailable" });
  await page.goto("/submit");
  await describe(page, "Database down", "Checking should explain itself.");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Signal is temporarily unavailable")).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => calls.length).toBe(2);
});

test("at 390px the Check step stacks with the need first and nothing scrolls sideways", async ({
  page,
  request,
}) => {
  const needs = await boardNeeds(request);
  await stubPreview(page, { kind: "matches", needs });
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/submit");
  await describe(page, "Monthly PDF", "A PDF of the revenue dashboard for the board pack.");
  await page.getByRole("button", { name: "Continue" }).click();
  const theirs = page.getByRole("region", { name: "The selected need" });
  const yours = page.getByRole("region", { name: "What you wrote" });
  await expect(theirs).toBeVisible();
  const [theirsBox, yoursBox] = await Promise.all([theirs.boundingBox(), yours.boundingBox()]);
  expect(theirsBox!.y).toBeLessThan(yoursBox!.y);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("public board and need page show no submitter details", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Board" })).toBeVisible();
  const rows = page.getByRole("region", { name: "Needs" }).getByRole("link");
  await expect(rows.first()).toBeVisible();
  expect(await page.locator("main").textContent()).not.toMatch(/@[\w-]+\.\w+/u);
  await rows.first().click();
  await expect(page.getByRole("link", { name: "Add my voice" })).toBeVisible();
  expect(await page.locator("main").textContent()).not.toMatch(/@[\w-]+\.\w+/u);
});
