import type { SignalOperations } from "@/lib/signal/client";

/** Report shapes as the operations return them (spec 013). */
export type GeneratedReport = SignalOperations["generate_report"]["output"];
export type SavedReport = SignalOperations["get_report"]["output"];
export type ReportListItem = SignalOperations["list_reports"]["output"]["reports"][number];
export type ShareResult = SignalOperations["share_report"]["output"];
export type ReportSpecValue = GeneratedReport["report"];
export type ReportDataValue = GeneratedReport["data"];

/** Starter prompts on the Reports page (spec 013 → Further Notes). */
export const reportStarters = [
  "Demand by theme, ARR-weighted, with the top 10 needs",
  "Signals per week by account plan for the last 12 weeks",
  "Decision latency by month this half-year",
  "Top needs for Enterprise accounts",
  "Prevention rate trend, humans vs. agents",
] as const;

/** The workspace's shareable link for a report's `/r/<token>` path. */
export const shareUrl = (path: string) =>
  typeof window === "undefined" ? path : new URL(path, window.location.origin).toString();
