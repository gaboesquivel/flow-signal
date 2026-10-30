import { suggestions } from "../../../lib/db/schema";
import type { SignalDb } from "../../../lib/signal/db";
import { recordEvent } from "../../../lib/signal/events";
import {
  insertAccount,
  insertCriteria,
  insertNeed,
  insertSubmitter,
  insertTheme,
  supporters,
} from "./builders";

const ai = { kind: "agent", ref: "signal:ai" } as const;
const at = (day: number) => new Date(Date.UTC(2026, 9, day, 9));

/**
 * PM triage data: N1 (open, 3 signals, one naming "PDF export"), a duplicate draft D of N1,
 * N2 (open), an already merged-away need M, a theme, and one pending suggestion of each kind
 * task 04 generates, plus a rejected one. Private values are in `secrets`.
 */
export const buildTriageFixture = async (db: SignalDb) => {
  await insertCriteria(db);
  const reporting = await insertTheme(db, { name: "Reporting" });
  const acme = await insertAccount(db, {
    arrCents: 48_000_000,
    name: "Acme Corp",
    openDealCents: 1_200_000,
    plan: "Enterprise",
  });
  const maya = await insertSubmitter(db, {
    accountId: acme.id,
    email: "maya@acme.example",
    name: "Maya Lindqvist",
  });
  const n1 = await insertNeed(db, {
    createdAt: new Date("2026-08-01T10:00:00Z"),
    scores: { business_value: 4, demand: 5 },
    signals: [
      {
        body: "Our CFO pastes dashboard screenshots into the board pack.",
        createdAt: new Date("2026-08-01T10:00:00Z"),
        submitterId: maya.id,
        title: "Export dashboards",
        useCase: "Monthly board meeting at Acme.",
      },
      { createdAt: new Date("2026-08-02T10:00:00Z") },
      { createdAt: new Date("2026-08-03T10:00:00Z"), title: "Also SSO please" },
    ],
    solutions: [],
    statement:
      "Executives need to share dashboard snapshots so that board meetings use current numbers",
    themeId: reporting.id,
  });
  const n2 = await insertNeed(db, {
    createdAt: new Date("2026-08-05T10:00:00Z"),
    signals: supporters(1),
    statement:
      "Compliance teams need to archive monthly reports so that audits have a fixed record",
  });
  const draft = await insertNeed(db, {
    approvedAt: null,
    createdAt: new Date("2026-10-20T10:00:00Z"),
    signals: [{ attachedTo: "draft", createdAt: new Date("2026-10-20T10:00:00Z") }],
    statement: "Board members need dashboards as PDF so that they read them offline",
    status: "draft",
  });
  const merged = await insertNeed(db, {
    createdAt: new Date("2026-07-01T10:00:00Z"),
    mergedIntoId: n2.need.id,
    statement: "Auditors need frozen reports",
    status: "merged",
  });

  const suggest = async (row: typeof suggestions.$inferInsert) => {
    const [created] = await db.insert(suggestions).values(row).returning();
    await recordEvent(db, {
      actor: ai,
      needId: created!.needId,
      occurredAt: created!.createdAt,
      payload: { kind: created!.kind },
      suggestionId: created!.id,
      type: "suggestion.created",
    });
    return created!;
  };
  const draftNeed = await suggest({
    createdAt: at(21),
    kind: "draft_need",
    model: "fake/reasoner",
    needId: draft.need.id,
    payload: {
      reason: "New submission with no match above the threshold.",
      statement: "Board members need dashboards offline so that they prepare for meetings",
    },
    signalIds: [draft.signals[0]!.id],
  });
  const merge = await suggest({
    createdAt: at(22),
    kind: "merge",
    model: "fake/reasoner",
    needId: draft.need.id,
    payload: { intoNeedId: n1.need.id, reason: "Same board-meeting outcome." },
    relatedNeedId: n1.need.id,
  });
  const theme = await suggest({
    createdAt: at(23),
    kind: "theme",
    model: "fake/reasoner",
    needId: n2.need.id,
    payload: { reason: "Reports and audits.", themeId: reporting.id },
    themeId: reporting.id,
  });
  const summary = await suggest({
    createdAt: at(24),
    kind: "public_summary",
    model: "fake/reasoner",
    needId: n1.need.id,
    payload: {
      reason: "Anonymized from supporters' use cases.",
      summary: "Leaders bring current KPI snapshots into recurring board meetings.",
    },
  });
  const split = await suggest({
    createdAt: at(25),
    kind: "split",
    model: "fake/reasoner",
    needId: n1.need.id,
    payload: {
      reason: "One signal asks for SSO, a different need.",
      signalIds: [n1.signals[2]!.id],
      statement: "Admins need single sign-on so that access is managed centrally",
    },
    signalIds: [n1.signals[2]!.id],
  });
  const rejected = await suggest({
    createdAt: at(10),
    kind: "merge",
    model: "fake/reasoner",
    needId: n2.need.id,
    payload: { intoNeedId: n1.need.id, reason: "Both ask for PDF export." },
    relatedNeedId: n1.need.id,
    resolvedAt: at(11),
    resolvedByKind: "human",
    status: "rejected",
  });

  return {
    acme,
    draft,
    maya,
    merged,
    n1,
    n2,
    reporting,
    secrets: ["maya@acme.example", "Maya Lindqvist", "Acme Corp", "48000000"],
    suggestions: { draftNeed, merge, rejected, split, summary, theme },
  };
};

export type TriageFixture = Awaited<ReturnType<typeof buildTriageFixture>>;
