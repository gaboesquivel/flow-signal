import { describe, expect, it } from "vitest";

import {
  buildEdit,
  formatCents,
  formatScore,
  mostUrgentSignals,
  nextPendingAfter,
  proposalOf,
  relativeAge,
  themesOf,
  triageCommand,
} from "../../app/operator/(console)/_lib/console";
import { loadNeedsSearchParams } from "../../app/operator/(console)/_lib/needs-params";

/** Pure rules behind the PM console's Triage and Needs screens (spec 006 task 05). */

const key = (value: string, extra: Partial<Parameters<typeof triageCommand>[0]> = {}) =>
  triageCommand({
    altKey: false,
    ctrlKey: false,
    key: value,
    metaKey: false,
    typing: false,
    ...extra,
  });

describe("triageCommand", () => {
  it("maps J/K/A/E/R/Esc to the triage commands", () => {
    expect(key("j")).toBe("next");
    expect(key("k")).toBe("previous");
    expect(key("a")).toBe("accept");
    expect(key("e")).toBe("edit");
    expect(key("r")).toBe("reject");
    expect(key("Escape")).toBe("cancel");
    expect(key("J")).toBe("next");
  });

  it("ignores letters while typing or with a modifier, but Esc always cancels", () => {
    expect(key("a", { typing: true })).toBeNull();
    expect(key("r", { metaKey: true })).toBeNull();
    expect(key("j", { ctrlKey: true })).toBeNull();
    expect(key("Escape", { typing: true })).toBe("cancel");
    expect(key("x")).toBeNull();
  });
});

describe("nextPendingAfter", () => {
  const ids = ["a", "b", "c", "d"];

  it("opens the next pending row after the one just resolved", () => {
    expect(nextPendingAfter(ids, "b", new Set(["a", "b"]))).toBe("c");
  });

  it("wraps to an earlier pending row, and returns null when none is left", () => {
    expect(nextPendingAfter(ids, "d", new Set(["b", "c", "d"]))).toBe("a");
    expect(nextPendingAfter(ids, "d", new Set(ids))).toBeNull();
  });
});

const suggestion = (kind: string, payload: Record<string, unknown>, signalIds: string[] = []) =>
  ({ kind, payload, relatedNeedId: null, signalIds, themeId: null }) as Parameters<
    typeof proposalOf
  >[0];

describe("proposalOf", () => {
  it("reads each kind's proposal defensively from the free-form payload", () => {
    const proposal = proposalOf(
      suggestion("split", { signalIds: ["s1", 4], statement: "Support agents need CRM data" }),
    );
    expect(proposal.statement).toBe("Support agents need CRM data");
    expect(proposal.signalIds).toEqual(["s1"]);
    expect(proposalOf(suggestion("public_summary", { summary: 3 })).summary).toBe("");
  });

  it("falls back to the suggestion's columns for signals, merge target, and theme", () => {
    const proposal = proposalOf({
      ...suggestion("merge", {}, ["s9"]),
      relatedNeedId: "n1",
      themeId: "t1",
    });
    expect(proposal.signalIds).toEqual(["s9"]);
    expect(proposal.intoNeedId).toBe("n1");
    expect(proposal.themeId).toBe("t1");
  });
});

describe("buildEdit", () => {
  const values = proposalOf(suggestion("draft_need", {}));

  it("builds the edit resolve_suggestion expects for each kind", () => {
    expect(
      buildEdit("draft_need", { ...values, statement: "  Teams need shared dashboards  " }),
    ).toEqual({ edit: { statement: "Teams need shared dashboards" } });
    expect(buildEdit("merge", { ...values, intoNeedId: "n2" })).toEqual({
      edit: { intoNeedId: "n2" },
    });
    expect(buildEdit("theme", { ...values, themeId: "t1", themeName: "Ignored" })).toEqual({
      edit: { themeId: "t1" },
    });
    expect(buildEdit("theme", { ...values, themeName: " Mobile " })).toEqual({
      edit: { themeName: "Mobile" },
    });
    expect(buildEdit("public_summary", { ...values, summary: " Short summary " })).toEqual({
      edit: { summary: "Short summary" },
    });
    expect(
      buildEdit("split", { ...values, signalIds: ["s1"], statement: "Agents need CRM data now" }),
    ).toEqual({ edit: { signalIds: ["s1"], statement: "Agents need CRM data now" } });
  });

  it("explains what is missing instead of sending an invalid edit", () => {
    expect(buildEdit("draft_need", { ...values, statement: "short" })).toHaveProperty("error");
    expect(buildEdit("merge", values)).toHaveProperty("error");
    expect(buildEdit("theme", { ...values, themeName: "x" })).toHaveProperty("error");
    expect(buildEdit("public_summary", values)).toHaveProperty("error");
    expect(
      buildEdit("split", { ...values, signalIds: [], statement: "Agents need CRM data now" }),
    ).toHaveProperty("error");
    expect(buildEdit("priority", values)).toHaveProperty("error");
  });
});

const signal = (id: string, urgency: "high" | "medium" | "low" | null, createdAt: string) => ({
  createdAt,
  id,
  urgency,
});

describe("mostUrgentSignals", () => {
  it("puts high urgency first, then newest, and keeps two", () => {
    const signals = [
      signal("old-high", "high", "2026-09-01T00:00:00Z"),
      signal("new-low", "low", "2026-10-29T00:00:00Z"),
      signal("new-high", "high", "2026-10-20T00:00:00Z"),
      signal("none", null, "2026-10-30T00:00:00Z"),
      signal("medium", "medium", "2026-10-01T00:00:00Z"),
    ];
    expect(mostUrgentSignals(signals).map((item) => item.id)).toEqual(["new-high", "old-high"]);
    expect(mostUrgentSignals(signals, 4).map((item) => item.id)).toEqual([
      "new-high",
      "old-high",
      "medium",
      "new-low",
    ]);
  });
});

describe("formatting", () => {
  it("formats ARR compactly in dollars", () => {
    expect(formatCents(138_000_000)).toBe("$1.38M");
    expect(formatCents(88_700_000)).toBe("$887k");
    expect(formatCents(12_000)).toBe("$120");
    expect(formatCents(0)).toBe("$0");
  });

  it("shows a score to two places, or a dash when unscored", () => {
    expect(formatScore(4.05)).toBe("4.05");
    expect(formatScore(4)).toBe("4.00");
    expect(formatScore(null)).toBe("—");
  });

  it("says how long ago, in days or weeks", () => {
    const now = new Date("2026-10-30T12:00:00Z");
    expect(relativeAge("2026-10-30T08:00:00Z", now)).toBe("today");
    expect(relativeAge("2026-10-29T08:00:00Z", now)).toBe("1d");
    expect(relativeAge("2026-10-25T08:00:00Z", now)).toBe("5d");
    expect(relativeAge("2026-10-01T08:00:00Z", now)).toBe("4w");
  });
});

describe("themesOf", () => {
  it("lists each theme once, by name", () => {
    const themes = themesOf([
      { theme: { id: "2", name: "Reporting" } },
      { theme: null },
      { theme: { id: "1", name: "Integrations" } },
      { theme: { id: "2", name: "Reporting" } },
    ]);
    expect(themes).toEqual([
      { id: "1", name: "Integrations" },
      { id: "2", name: "Reporting" },
    ]);
  });
});

describe("loadNeedsSearchParams", () => {
  it("defaults to priority and drops values the API would reject", () => {
    expect(loadNeedsSearchParams({})).toEqual({
      q: "",
      sort: "priority",
      status: null,
      theme: null,
    });
    expect(
      loadNeedsSearchParams({ q: "board", sort: "arr", status: "open", theme: "not-a-uuid" }),
    ).toEqual({
      q: "board",
      sort: "arr",
      status: "open",
      theme: null,
    });
    expect(loadNeedsSearchParams({ sort: "random", status: "merged" })).toMatchObject({
      sort: "priority",
      status: null,
    });
  });
});
