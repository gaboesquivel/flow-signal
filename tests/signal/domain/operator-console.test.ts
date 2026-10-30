import { beforeEach, describe, expect, it } from "vitest";

import { suggestions } from "../../../lib/db/schema";
import { writeCriteria } from "../../../lib/signal/domain/criteria";
import { listOperatorNeeds } from "../../../lib/signal/domain/operator-needs";
import type { OperatorNeedSort } from "../../../lib/signal/domain/operator-needs";
import { checkPublicText, findIdentifyingText } from "../../../lib/signal/domain/public-text";
import { insertAccount, insertNeed, insertSubmitter } from "../support/builders";
import { describeWithDatabase, resetDatabase, useTestDatabase } from "../support/database";
import { buildPrioritizationFixture } from "../support/prioritization-fixture";
import type { PrioritizationFixture } from "../support/prioritization-fixture";

describe("findIdentifyingText", () => {
  const candidates = [
    { kind: "person" as const, value: "Maya Lindqvist" },
    { kind: "account" as const, value: "Acme Corp" },
    { kind: "email" as const, value: "maya@acme.example" },
    { kind: "person" as const, value: "Al" },
  ];

  it("finds names, accounts, and emails case-insensitively, in text order", () => {
    expect(
      findIdentifyingText(
        "Thanks MAYA LINDQVIST from acme corp; write to Maya@Acme.example.",
        candidates,
      ),
    ).toEqual([
      { kind: "person", match: "MAYA LINDQVIST" },
      { kind: "account", match: "acme corp" },
      { kind: "email", match: "Maya@Acme.example" },
    ]);
  });

  it("matches names as whole words only", () => {
    expect(findIdentifyingText("All dashboards, totally, Alpine.", candidates)).toEqual([]);
    expect(findIdentifyingText("Ask Al.", candidates)).toEqual([{ kind: "person", match: "Al" }]);
  });

  it("flags an account by its name without a legal suffix", () => {
    expect(findIdentifyingText("Planned for Acme in Q1.", candidates)).toEqual([
      { kind: "account", match: "Acme" },
    ]);
  });

  it("reports an email once, not the account inside it, and dedupes repeats", () => {
    expect(
      findIdentifyingText("maya@acme.example and MAYA@ACME.EXAMPLE again", candidates),
    ).toEqual([{ kind: "email", match: "maya@acme.example" }]);
  });

  it("returns nothing for clean text", () => {
    expect(
      findIdentifyingText("Executives share dashboard snapshots in board meetings.", candidates),
    ).toEqual([]);
  });
});

describeWithDatabase("operator console reads", () => {
  const harness = useTestDatabase();
  let fx: PrioritizationFixture;

  beforeEach(async () => {
    await resetDatabase(harness.db);
    fx = await buildPrioritizationFixture(harness.db);
  });

  const ids = async (filter: Parameters<typeof listOperatorNeeds>[1]) =>
    (await listOperatorNeeds(harness.db, filter)).map((need) => need.id);
  const order = (sort: OperatorNeedSort) => ids({ sort });

  describe("listOperatorNeeds", () => {
    it("returns every live need with people, accounts, money, scores, and pending suggestions", async () => {
      await harness.db.insert(suggestions).values([
        { kind: "theme", needId: fx.n3.need.id, payload: {} },
        { kind: "merge", needId: fx.n3.need.id, payload: {}, relatedNeedId: fx.n1.need.id },
        { kind: "theme", needId: fx.n3.need.id, payload: {}, status: "rejected" },
      ]);
      const needs = await listOperatorNeeds(harness.db, { sort: "priority" });
      expect(needs.map((need) => need.id)).not.toContain(fx.merged.need.id);
      const n1 = needs.find((need) => need.id === fx.n1.need.id);
      expect(n1).toEqual({
        accounts: 2,
        arrCents: 54_000_000,
        criterionScores: { business_value: 5, demand: 4, effort: 2, strategic_fit: 4 },
        id: fx.n1.need.id,
        openDealCents: 12_000_000,
        pendingSuggestions: 1,
        people: 6,
        score: 4.1,
        statement: fx.n1.need.statement,
        status: "open",
        theme: { id: fx.reporting.id, name: "Reporting" },
      });
      const n3 = needs.find((need) => need.id === fx.n3.need.id);
      expect(n3).toMatchObject({
        accounts: 0,
        arrCents: 0,
        criterionScores: null,
        openDealCents: 0,
        pendingSuggestions: 2,
        people: 4,
        score: null,
      });
    });

    it("sorts by priority with nulls last, then people", async () => {
      expect(await order("priority")).toEqual([
        fx.n1.need.id,
        fx.n2.need.id,
        fx.n3.need.id,
        fx.declined.need.id,
        fx.outage.need.id,
      ]);
    });

    it("breaks equal scores by people", async () => {
      await writeCriteria(harness.db, {
        business_value: 0,
        demand: 0,
        effort: 1,
        strategic_fit: 0,
      });
      const needs = await listOperatorNeeds(harness.db, { sort: "priority" });
      expect(needs.slice(0, 2).map((need) => [need.id, need.score, need.people])).toEqual([
        [fx.n1.need.id, 2, 6],
        [fx.n2.need.id, 2, 5],
      ]);
    });

    it("sorts by people, accounts, and ARR", async () => {
      const busy = await insertNeed(harness.db, {
        signals: Array.from({ length: 8 }, () => ({})),
        statement: "Admins need audit logs so that changes are traceable",
      });
      const big = await insertAccount(harness.db, { arrCents: 90_000_000, name: "Initech" });
      const rich = await insertNeed(harness.db, {
        signals: [{ submitterId: (await insertSubmitter(harness.db, { accountId: big.id })).id }],
        statement: "Finance needs invoices in CSV so that books close faster",
      });
      expect((await order("people")).slice(0, 3)).toEqual([
        busy.need.id,
        fx.n1.need.id,
        fx.n2.need.id,
      ]);
      expect((await order("accounts")).slice(0, 3)).toEqual([
        fx.n1.need.id,
        fx.n2.need.id,
        rich.need.id,
      ]);
      expect((await order("arr")).slice(0, 3)).toEqual([
        rich.need.id,
        fx.n1.need.id,
        fx.n2.need.id,
      ]);
    });

    it("filters by theme, status, and words in the statement or theme", async () => {
      expect(await ids({ sort: "priority", themeId: fx.compliance.id })).toEqual([fx.n2.need.id]);
      expect(await ids({ sort: "priority", status: "declined" })).toEqual([fx.declined.need.id]);
      expect(await ids({ query: "board EXECUTIVES", sort: "priority" })).toEqual([fx.n1.need.id]);
      expect(await ids({ query: "reporting", sort: "people" })).toEqual([
        fx.n1.need.id,
        fx.n3.need.id,
      ]);
      expect(await ids({ query: "100%_nothing", sort: "priority" })).toEqual([]);
    });
  });

  describe("checkPublicText", () => {
    it("checks workspace-wide names, accounts, and emails without a need", async () => {
      const result = await checkPublicText(harness.db, {
        text: "Planned after talking to Maya Lindqvist (maya@acme.example) and Globex.",
      });
      expect(result.findings).toEqual([
        { kind: "person", match: "Maya Lindqvist" },
        { kind: "email", match: "maya@acme.example" },
        { kind: "account", match: "Globex" },
      ]);
    });

    it("scopes to the need's supporters when a need is given", async () => {
      const text = "Thanks Maya Lindqvist at Acme Corp and Globex.";
      expect((await checkPublicText(harness.db, { needId: fx.n1.need.id, text })).findings).toEqual(
        [
          { kind: "person", match: "Maya Lindqvist" },
          { kind: "account", match: "Acme Corp" },
          { kind: "account", match: "Globex" },
        ],
      );
      // N2 has an Acme person but neither Maya nor Globex.
      expect((await checkPublicText(harness.db, { needId: fx.n2.need.id, text })).findings).toEqual(
        [{ kind: "account", match: "Acme Corp" }],
      );
    });

    it("fails with not_found for an unknown need", async () => {
      await expect(
        checkPublicText(harness.db, { needId: "00000000-0000-4000-8000-000000000000", text: "x" }),
      ).rejects.toMatchObject({ code: "not_found" });
    });
  });
});
