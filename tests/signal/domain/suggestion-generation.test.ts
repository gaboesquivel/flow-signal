import { eq } from "drizzle-orm";
import { beforeEach, expect, it } from "vitest";

import { events, needs, suggestions } from "../../../lib/db/schema";
import { createFakeAi, createUnavailableAi, fakeReasoner } from "../../../lib/signal/ai/fakes";
import type { ReasonerTask } from "../../../lib/signal/ai/ports";
import { embedNeeds } from "../../../lib/signal/domain/embeddings";
import {
  generateSuggestionsForSignal,
  scheduleSuggestionGeneration,
} from "../../../lib/signal/domain/suggestion-generation";
import { insertAccount, insertNeed, insertSubmitter, insertTheme } from "../support/builders";
import { executeOperation } from "../../../lib/signal/operations/execute";
import { submitSignal } from "../../../lib/signal/operations/submit-signal";
import { configureSignalRuntime } from "../../../lib/signal/runtime";
import {
  describeWithDatabase,
  resetDatabase,
  scheduledGenerations,
  useTestDatabase,
} from "../support/database";

const now = new Date("2026-10-30T09:00:00Z");
const clock = { now: () => now };

/** The line number of the first numbered prompt line containing `text`. */
const pick = (prompt: string, text: string) => {
  const line = prompt
    .split("\n")
    .find((candidate) => /^\d+\./u.test(candidate) && candidate.includes(text));
  return line ? Math.trunc(Number(line.split(".")[0])) : null;
};

const reasoner = (
  overrides: Partial<Record<ReasonerTask, (input: { prompt: string }) => unknown>> = {},
) =>
  fakeReasoner({
    draft_need: () => ({
      reason: "No existing need matched.",
      statement:
        "Executives need monthly dashboard snapshots so that board meetings use current numbers",
    }),
    merge: ({ prompt }) => ({
      candidate: pick(prompt, "Executives need to share"),
      reason: "Same board-meeting outcome.",
    }),
    priority: () => ({
      business_value: { reason: "Acme's ARR.", score: 4 },
      demand: { reason: "Two supporters.", score: 2 },
      effort: { reason: "Small.", score: 4 },
      strategic_fit: { reason: "Reporting theme.", score: 3 },
      summary: "New signal from an enterprise account.",
    }),
    public_summary: () => ({
      reason: "Anonymized from use cases.",
      summary: "Leaders bring current numbers into recurring board meetings.",
    }),
    split: ({ prompt }) => ({
      reason: "One signal asks for SSO.",
      split: {
        signals: [pick(prompt, "Okta")],
        statement: "Admins need single sign-on so that access is managed centrally",
      },
    }),
    theme: ({ prompt }) => ({
      newThemeName: null,
      reason: "Board reporting.",
      theme: pick(prompt, "Reporting"),
    }),
    ...overrides,
  });

describeWithDatabase("suggestion generation", () => {
  const harness = useTestDatabase();

  const build = async () => {
    const reporting = await insertTheme(harness.db, { name: "Reporting" });
    const acme = await insertAccount(harness.db, { name: "Acme Corp" });
    const maya = await insertSubmitter(harness.db, {
      accountId: acme.id,
      email: "maya@acme.example",
      name: "Maya Lindqvist",
    });
    const n1 = await insertNeed(harness.db, {
      statement:
        "Executives need to share dashboard snapshots so that board meetings use current numbers",
      themeId: reporting.id,
    });
    const draft = await insertNeed(harness.db, {
      approvedAt: null,
      signals: [
        {
          attachedTo: "draft",
          body: "The board wants dashboard snapshots every month. Also please add SSO.",
          submitterId: maya.id,
          title: "Dashboard snapshots for the board",
          useCase: "Acme Corp board meeting; Maya prepares the deck.",
        },
        { attachedTo: "existing", body: "We need SSO with Okta.", title: "SSO" },
      ],
      statement: "Executives need dashboard snapshots so that board meetings use current numbers",
      status: "draft",
    });
    await embedNeeds(harness.db, createFakeAi().embedder, [n1.need.id, draft.need.id]);
    return { acme, draft, maya, n1, reporting, signal: draft.signals[0]! };
  };

  beforeEach(() => resetDatabase(harness.db));

  it("creates draft_need, merge, theme, public_summary, and split suggestions with reasons", async () => {
    const f = await build();
    const ai = createFakeAi({ reasoner: reasoner() });
    const outcome = await generateSuggestionsForSignal(
      { ai, clock, db: harness.db },
      { signalId: f.signal.id },
    );

    expect(outcome.created.map((c) => c.kind).toSorted()).toEqual([
      "draft_need",
      "merge",
      "priority",
      "public_summary",
      "split",
      "theme",
    ]);
    const rows = await harness.db.select().from(suggestions);
    const byKind = Object.fromEntries(rows.map((row) => [row.kind, row]));
    for (const row of rows) {
      expect(row).toMatchObject({
        model: "fake/reasoner",
        needId: f.draft.need.id,
        status: "pending",
      });
      expect(typeof row.payload.reason).toBe("string");
    }
    expect(byKind.merge).toMatchObject({
      payload: { intoNeedId: f.n1.need.id },
      relatedNeedId: f.n1.need.id,
    });
    expect(byKind.theme).toMatchObject({
      payload: { themeId: f.reporting.id },
      themeId: f.reporting.id,
    });
    expect(byKind.split).toMatchObject({
      payload: { signalIds: [f.draft.signals[1]!.id] },
      signalIds: [f.draft.signals[1]!.id],
    });
    expect(byKind.draft_need!.signalIds).toEqual([f.signal.id]);

    const created = await harness.db
      .select()
      .from(events)
      .where(eq(events.type, "suggestion.created"));
    expect(created).toHaveLength(6);
    expect(created.every((e) => e.actorKind === "agent" && e.actorRef === "signal:ai")).toBe(true);

    const [need] = await harness.db.select().from(needs).where(eq(needs.id, f.draft.need.id));
    expect(need).toMatchObject({ publicSummary: null, publicSummaryStatus: "pending" });

    const again = await generateSuggestionsForSignal(
      { ai, clock, db: harness.db },
      { signalId: f.signal.id },
    );
    expect(again.created).toEqual([]);
    expect((await harness.db.select().from(suggestions)).length).toBe(6);
  });

  it("drops a public summary that names a customer, and proposals that point nowhere", async () => {
    const f = await build();
    const ai = createFakeAi({
      reasoner: reasoner({
        merge: () => ({ candidate: null, reason: "No duplicate." }),
        public_summary: () => ({ reason: "r", summary: "Maya at ACME CORP preps the board deck." }),
        split: () => ({ reason: "One need.", split: null }),
        theme: () => ({ newThemeName: null, reason: "Nothing fits.", theme: null }),
      }),
    });
    const outcome = await generateSuggestionsForSignal(
      { ai, clock, db: harness.db },
      { signalId: f.signal.id },
    );
    expect(outcome.created.map((c) => c.kind).toSorted()).toEqual(["draft_need", "priority"]);
    expect(outcome.skipped.map((s) => s.kind).toSorted()).toEqual([
      "merge",
      "public_summary",
      "split",
      "theme",
    ]);
  });

  it("creates nothing and does not throw when AI is unavailable", async () => {
    const f = await build();
    const outcome = await generateSuggestionsForSignal(
      { ai: createUnavailableAi(), clock, db: harness.db },
      { signalId: f.signal.id },
    );
    expect(outcome.created).toEqual([]);
    expect(outcome.skipped.every((s) => s.reason.includes("ai_unavailable"))).toBe(true);
    expect(await harness.db.select().from(suggestions)).toEqual([]);
  });

  it("skips a signal on a merged need and an unknown signal", async () => {
    const f = await build();
    await harness.db
      .update(needs)
      .set({ mergedIntoId: f.n1.need.id, status: "merged" })
      .where(eq(needs.id, f.draft.need.id));
    const ai = createFakeAi({ reasoner: reasoner() });
    expect(
      (await generateSuggestionsForSignal({ ai, clock, db: harness.db }, { signalId: f.signal.id }))
        .created,
    ).toEqual([]);
    expect(
      (
        await generateSuggestionsForSignal(
          { ai, clock, db: harness.db },
          { signalId: "00000000-0000-4000-8000-000000000000" },
        )
      ).created,
    ).toEqual([]);
  });

  it("schedules generation after the response and never rejects", async () => {
    const f = await build();
    const ai = createFakeAi({ reasoner: reasoner() });
    const tasks: Promise<unknown>[] = [];
    scheduleSuggestionGeneration({ ai, clock, db: harness.db }, f.signal.id, (task) => {
      tasks.push(task());
    });
    await Promise.all(tasks);
    expect((await harness.db.select().from(suggestions)).length).toBe(6);
  });

  it("submit_signal schedules generation after responding", async () => {
    const f = await build();
    configureSignalRuntime({ ai: createFakeAi({ reasoner: reasoner() }), clock });
    scheduledGenerations.length = 0;
    const result = await executeOperation(
      submitSignal,
      {
        body: "Board members want the KPI dashboard as a monthly snapshot.",
        email: "lee@example.test",
        idempotencyKey: "gen-0001",
        target: {
          newNeed: {
            statement:
              "Board members need monthly KPI snapshots so that meetings use current numbers",
          },
        },
        title: "Monthly KPI snapshot",
      },
      { kind: "human", ref: "web" },
    );
    expect(result.ok).toBe(true);
    expect(scheduledGenerations).toHaveLength(1);
    expect(await harness.db.select().from(suggestions)).toEqual([]);
    await scheduledGenerations[0]!();
    const kinds = (await harness.db.select().from(suggestions)).map((row) => row.kind).toSorted();
    expect(kinds).toContain("draft_need");
    expect(kinds).toContain("priority");
    expect(f.n1.need.id).toBeTruthy();
    configureSignalRuntime({ ai: createFakeAi(), clock: { now: () => new Date() } });
  });

  it("a replayed submit_signal (same idempotencyKey) schedules nothing", async () => {
    await build();
    scheduledGenerations.length = 0;
    const submission = {
      body: "Board members want the KPI dashboard as a monthly snapshot.",
      email: "lee@example.test",
      idempotencyKey: "gen-replay-0001",
      target: {
        newNeed: {
          statement:
            "Board members need monthly KPI snapshots so that meetings use current numbers",
        },
      },
      title: "Monthly KPI snapshot",
    };
    const human = { kind: "human" as const, ref: "web" };
    const first = await executeOperation(submitSignal, submission, human);
    const replay = await executeOperation(submitSignal, submission, human);
    expect(first.ok && replay.ok).toBe(true);
    expect(replay).toEqual(first);
    // `replayed` is internal: the public output is unchanged.
    expect(replay.ok && "replayed" in (replay.data as object)).toBe(false);
    expect(scheduledGenerations).toHaveLength(1);
  });
});
