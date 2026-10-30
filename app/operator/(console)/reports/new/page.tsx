import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ReportWorkspace } from "../report-workspace";

export const metadata: Metadata = { title: "New report · Signal" };

/** Generates a report from `?q=` (spec 013); nothing is saved until the PM saves it. */
export default async function NewReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { q } = await searchParams;
  const prompt = typeof q === "string" ? q.trim().slice(0, 2000) : "";
  if (!prompt) redirect("/operator/reports");
  return <ReportWorkspace initialPrompt={prompt} key={prompt} />;
}
