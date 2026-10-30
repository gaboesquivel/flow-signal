import assert from "node:assert/strict";

import type { SignalDb } from "../../../lib/signal/db";
import {
  insertAccount,
  insertCriteria,
  insertNeed,
  insertSubmitter,
  insertTheme,
  supporters,
} from "./builders";

/**
 * A small board: N1 and N2 share the "PDF export" solution (the acceptance scenario's pair),
 * plus a draft, a merged-away need, a decided need, and a scored need. Private values are
 * collected in `secrets` so tests can assert none of them reach a public response.
 */
export const buildPublicNeedsFixture = async (db: SignalDb) => {
  await insertCriteria(db);
  const reporting = await insertTheme(db, { name: "Reporting" });
  const compliance = await insertTheme(db, { name: "Compliance" });
  const acme = await insertAccount(db, {
    arrCents: 48_000_000,
    name: "Acme Corp",
    plan: "Enterprise",
  });
  const maya = await insertSubmitter(db, {
    accountId: acme.id,
    email: "maya@acme.example",
    name: "Maya Lindqvist",
  });

  const n1 = await insertNeed(db, {
    createdAt: new Date("2026-08-01T10:00:00Z"),
    publicSummary: "Leaders bring current KPI snapshots into recurring board meetings.",
    publicSummaryStatus: "approved",
    signals: [
      {
        body: "Our CFO pastes screenshots of the revenue dashboard into the Acme board pack.",
        submitterId: maya.id,
        title: "Board pack screenshots are painful",
        useCase: "Acme quarterly board pack",
      },
      ...supporters(10),
    ],
    solutions: ["PDF export", "Scheduled email digest"],
    statement:
      "Executives need to share dashboard snapshots outside the product so that board meetings use current numbers",
    themeId: reporting.id,
  });
  const n2 = await insertNeed(db, {
    createdAt: new Date("2026-08-05T10:00:00Z"),
    publicSummary: "Acme's compliance lead archives reports for SOC 2 auditors.",
    publicSummaryStatus: "pending",
    signals: supporters(3),
    solutions: ["PDF export"],
    statement:
      "Compliance teams need to archive monthly reports so that audits have a fixed record",
    themeId: compliance.id,
  });
  const draft = await insertNeed(db, {
    createdAt: new Date("2026-10-20T10:00:00Z"),
    signals: supporters(1),
    statement: "Analysts need to annotate chart points so that teammates see why numbers moved",
    status: "draft",
    themeId: reporting.id,
  });
  const merged = await insertNeed(db, {
    createdAt: new Date("2026-08-02T10:00:00Z"),
    mergedIntoId: n1.need.id,
    statement: "Board members need dashboard PDFs so that they can read offline",
    status: "merged",
    themeId: reporting.id,
  });
  const decided = await insertNeed(db, {
    createdAt: new Date("2026-07-01T10:00:00Z"),
    decision: {
      note: "Shipping in the October release.",
      publishedAt: new Date("2026-09-15T12:00:00Z"),
      status: "planned",
    },
    signals: supporters(5),
    statement: "Admins need to schedule report delivery so that teams get numbers without asking",
    status: "planned",
    themeId: reporting.id,
  });
  const scored = await insertNeed(db, {
    createdAt: new Date("2026-06-01T10:00:00Z"),
    scores: { business_value: 1, demand: 1, effort: 1, strategic_fit: 1 },
    signals: supporters(12),
    statement: "Support agents need to tag conversations so that recurring issues are visible",
  });

  const secrets = [
    "maya@acme.example",
    "Maya Lindqvist",
    "Acme",
    "48000000",
    "Our CFO pastes screenshots",
    "Board pack screenshots are painful",
    "Acme quarterly board pack",
    "SOC 2 auditors",
    "person",
    "Verbatim",
  ];

  return { compliance, decided, draft, merged, n1, n2, reporting, scored, secrets };
};

export type PublicNeedsFixture = Awaited<ReturnType<typeof buildPublicNeedsFixture>>;

/** Fails when any private value (PII, revenue, verbatim text, unapproved summary) is present. */
export const assertNoPrivateData = (output: unknown, fixture: PublicNeedsFixture) => {
  const text = JSON.stringify(output);
  for (const secret of fixture.secrets)
    assert.ok(!text.includes(secret), `public output leaked ${JSON.stringify(secret)}`);
  for (const key of ["email", "company", "account", "arr", "revenue", "body", "useCase", "title"])
    assert.ok(!text.includes(`"${key}"`), `public output has a ${key} field`);
};
