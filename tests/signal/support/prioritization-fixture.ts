import { createFakeAi, fakeReasoner } from "../../../lib/signal/ai/fakes";
import type { SignalDb } from "../../../lib/signal/db";
import { SignalError } from "../../../lib/signal/errors";
import { configureSignalRuntime } from "../../../lib/signal/runtime";
import {
  insertAccount,
  insertCriteria,
  insertNeed,
  insertSubmitter,
  insertTheme,
  supporters,
} from "./builders";

/**
 * Demand and decisions fixture (task 05) on a fixed clock. Weights 0.4 / 0.3 / 0.2 / 0.1.
 *
 * - N1 (Reporting, open, score 4.1): Maya (Acme) and a Globex person plus 3 others; new
 *   supporters 4 in the last 30 days vs. 1 in the 30 before (rising), one more 200 days ago.
 * - N2 (Compliance, open, score 2.0): an Acme person among 5; 1 recent vs. 4 before (falling).
 * - N3 (Reporting, open, unscored): 2 recent vs. 2 before (steady).
 * - A merged-away need and a declined need, which demand leaves out.
 */

export const NOW = new Date("2026-10-30T09:00:00Z");
const DAY = 86_400_000;
export const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

/** A need whose statement contains this makes the fake reasoner fail with `ai_unavailable`. */
export const OUTAGE = "OUTAGE";

export const fakeReasoningAi = () =>
  createFakeAi({
    reasoner: fakeReasoner({
      decision_brief: ({ prompt }) => {
        if (prompt.includes(OUTAGE)) throw new SignalError("ai_unavailable", "Model down.");
        return {
          options: [
            {
              rationale: "Strong rising demand from Acme Corp (Enterprise).",
              status: "planned",
              tradeoffs: "Delays other reporting work.",
            },
            {
              rationale: "Low effort fit is unclear.",
              status: "declined",
              tradeoffs: "Churn risk.",
            },
          ],
          recommendation: { note: "Targeting Q1", status: "planned" },
          summary: "Executives at large accounts ask to share dashboards with their boards.",
        };
      },
      demand_summary: ({ prompt }) => ({
        text: `Top demand: ${prompt.includes("Executives") ? "dashboard sharing" : "other"}.`,
      }),
      priority: ({ prompt }) => {
        if (prompt.includes(OUTAGE)) throw new SignalError("ai_unavailable", "Model down.");
        return {
          business_value: { reason: "Acme Corp ARR $480,000 asks for it.", score: 5 },
          demand: { reason: "Six supporters, rising.", score: 4 },
          effort: { reason: "Moderate.", score: 2 },
          strategic_fit: { reason: "Reporting is a focus theme.", score: 4 },
          summary: "Business value raised: Acme Corp (ARR $480,000) joined.",
        };
      },
    }),
  });

export const buildPrioritizationFixture = async (db: SignalDb) => {
  configureSignalRuntime({ ai: fakeReasoningAi(), clock: { now: () => NOW } });
  await insertCriteria(db);
  const reporting = await insertTheme(db, { name: "Reporting", strategicWeight: 0.9 });
  const compliance = await insertTheme(db, { name: "Compliance", strategicWeight: 0.4 });
  const acme = await insertAccount(db, {
    arrCents: 48_000_000,
    name: "Acme Corp",
    openDealCents: 12_000_000,
    plan: "Enterprise",
  });
  const globex = await insertAccount(db, { arrCents: 6_000_000, name: "Globex", plan: "Growth" });
  const maya = await insertSubmitter(db, {
    accountId: acme.id,
    email: "maya@acme.example",
    name: "Maya Lindqvist",
  });
  const acmeAuditor = await insertSubmitter(db, { accountId: acme.id });
  const globexPerson = await insertSubmitter(db, { accountId: globex.id });

  const n1 = await insertNeed(db, {
    createdAt: daysAgo(200),
    scores: { business_value: 5, demand: 4, effort: 2, strategic_fit: 4 },
    signals: [
      { createdAt: daysAgo(200) },
      { createdAt: daysAgo(45) },
      { createdAt: daysAgo(25) },
      { createdAt: daysAgo(25) },
      { createdAt: daysAgo(20), submitterId: globexPerson.id },
      {
        createdAt: daysAgo(10),
        submitterId: maya.id,
        urgency: "high",
        useCase: "monthly board deck",
      },
    ],
    solutions: ["PDF export"],
    statement:
      "Executives need to share dashboard snapshots outside the product so that board meetings use current numbers",
    themeId: reporting.id,
  });
  const n2 = await insertNeed(db, {
    createdAt: daysAgo(60),
    scores: { business_value: 2, demand: 2, effort: 2, strategic_fit: 2 },
    signals: [
      { createdAt: daysAgo(50), submitterId: acmeAuditor.id },
      { createdAt: daysAgo(50) },
      { createdAt: daysAgo(40) },
      { createdAt: daysAgo(40) },
      { createdAt: daysAgo(10) },
    ],
    solutions: ["PDF export"],
    statement:
      "Compliance teams need to archive monthly reports so that audits have a fixed record",
    themeId: compliance.id,
  });
  const n3 = await insertNeed(db, {
    createdAt: daysAgo(50),
    signals: [
      { createdAt: daysAgo(45) },
      { createdAt: daysAgo(45) },
      { createdAt: daysAgo(15) },
      { createdAt: daysAgo(15) },
    ],
    statement: "Analysts need to annotate chart points so that teammates see why numbers moved",
    themeId: reporting.id,
  });
  const merged = await insertNeed(db, {
    mergedIntoId: n1.need.id,
    statement: "Board members need dashboard PDFs so that they can read offline",
    status: "merged",
  });
  const declined = await insertNeed(db, {
    signals: supporters(3),
    statement: "Users need a dark mode so that night work is easier",
    status: "declined",
  });
  const outage = await insertNeed(db, {
    statement: `${OUTAGE}: Ops need alerts so that incidents are caught`,
    status: "shipped",
  });
  return { acme, compliance, declined, globex, maya, merged, n1, n2, n3, outage, reporting };
};

export type PrioritizationFixture = Awaited<ReturnType<typeof buildPrioritizationFixture>>;
