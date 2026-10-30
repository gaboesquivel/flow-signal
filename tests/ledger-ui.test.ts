import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DemandBand } from "../app/_components/signal/demand-band";
import { Pencil } from "../app/_components/signal/pencil";
import { Quote } from "../app/_components/signal/quote";
import { Status } from "../app/_components/signal/status";
import { KbdHint, KbdHints } from "../components/kbd-hint";
import { LoadingLine } from "../components/loading-line";
import { ReadingPair, ReadingPane } from "../components/reading-pair";
import { RuledList, RuledRow, stepExpanded, toggleExpanded } from "../components/ruled-list";

/**
 * Ledger primitives (spec 006 task 01). The repo's vitest runs in Node without a DOM, so these
 * render to static markup and test the list's expansion rules as pure functions.
 */

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

const renderPencil = (state: "suggested" | "accepted" | "edited" | "rejected") =>
  html(
    h(Pencil, { children: "Both ask for board-ready dashboards.", label: "Why it matches", state }),
  );

const renderList = (props: { defaultExpanded?: string; expanded?: string | null }) =>
  html(
    h(
      RuledList,
      { "aria-label": "Suggestions", ...props },
      h(RuledRow, { children: "Detail A", summary: "Row A", value: "a" }),
      h(RuledRow, { children: "Detail B", summary: "Row B", value: "b" }),
      h(RuledRow, { children: "Detail C", summary: "Row C", value: "c" }),
    ),
  );

describe("Pencil", () => {
  it("writes a suggestion in pencil: dashed AI rule, AI text, labelled for screen readers", () => {
    const markup = renderPencil("suggested");
    expect(markup).toContain('data-state="suggested"');
    expect(markup).toContain("border-dashed");
    expect(markup).toContain("border-ai");
    expect(markup).toContain("text-ai-foreground");
    expect(markup).toContain("Why it matches");
    expect(markup).toContain("Suggested by AI");
    expect(markup).not.toContain("line-through");
  });

  it("turns accepted text to ink: solid strong rule, normal text, no pencil colour", () => {
    const markup = renderPencil("accepted");
    expect(markup).toContain('data-state="accepted"');
    expect(markup).toContain("border-rule-strong");
    expect(markup).not.toContain("border-dashed");
    expect(markup).not.toContain("text-ai-foreground");
    expect(markup).not.toContain("edited by you");
  });

  it("marks edited ink with a visible 'edited by you'", () => {
    const markup = renderPencil("edited");
    expect(markup).toContain('data-state="edited"');
    expect(markup).toContain("border-rule-strong");
    expect(markup).toContain("edited by you");
  });

  it("strikes and fades rejected text but keeps its label and the word 'rejected' readable", () => {
    const markup = renderPencil("rejected");
    expect(markup).toContain('data-state="rejected"');
    expect(markup).toContain("line-through");
    expect(markup).toContain("Why it matches");
    expect(markup).toMatch(/>rejected</u);
  });

  it("defaults the label to 'Suggested'", () => {
    expect(html(h(Pencil, { children: "x", state: "suggested" }))).toContain("Suggested");
  });
});

describe("Quote", () => {
  it("keeps customer words verbatim with muted attribution only when given", () => {
    const withCite = html(
      h(Quote, { children: "We need a PDF.", cite: "Maya · Acme · Enterprise" }),
    );
    expect(withCite).toContain("<blockquote");
    expect(withCite).toContain("We need a PDF.");
    expect(withCite).toContain("Maya · Acme · Enterprise");
    expect(withCite).toContain("text-muted-foreground");
    expect(html(h(Quote, { children: "We need a PDF." }))).not.toContain("figcaption");
  });
});

describe("Status and demand", () => {
  it.each([
    ["new", "New"],
    ["open", "Open"],
    ["planned", "Planned"],
    ["in_progress", "In progress"],
    ["shipped", "Shipped"],
    ["declined", "Declined"],
    ["merged", "Merged"],
  ] as const)("%s shows a word and a shape, never colour alone", (status, word) => {
    const markup = html(h(Status, { status }));
    expect(markup).toContain(`>${word}<`);
    expect(markup).toContain("<svg");
    expect(markup).toContain(`data-status="${status}"`);
  });

  it("gives each status its own shape", () => {
    const shapes = new Set(
      (["new", "open", "planned", "in_progress", "shipped", "declined", "merged"] as const).map(
        (status) => html(h(Status, { status })).replaceAll(/>[^<]+</gu, "><"),
      ),
    );
    expect(shapes.size).toBe(7);
  });

  it("names the demand band in words", () => {
    expect(html(h(DemandBand, { band: "high" }))).toContain("High demand");
    expect(html(h(DemandBand, { band: "low" }))).toContain("Low demand");
  });
});

describe("Ruled list: exactly one row expands", () => {
  it("toggles a row open, closes it again, and opening another replaces the first", () => {
    expect(toggleExpanded(null, "a")).toBe("a");
    expect(toggleExpanded("a", "a")).toBeNull();
    expect(toggleExpanded("a", "b")).toBe("b");
  });

  it("steps the open row with J/K and stops at the ends", () => {
    const rows = ["a", "b", "c"];
    expect(stepExpanded(rows, null, 1)).toBe("a");
    expect(stepExpanded(rows, null, -1)).toBe("c");
    expect(stepExpanded(rows, "a", 1)).toBe("b");
    expect(stepExpanded(rows, "c", 1)).toBe("c");
    expect(stepExpanded(rows, "a", -1)).toBe("a");
    expect(stepExpanded([], null, 1)).toBeNull();
    expect(stepExpanded(rows, "gone", 1)).toBe("a");
  });

  it("renders only the expanded row's detail, with buttons that say which row is open", () => {
    const markup = renderList({ defaultExpanded: "b" });
    expect(markup).toContain("Detail B");
    expect(markup).not.toContain("Detail A");
    expect(markup).not.toContain("Detail C");
    expect(markup.match(/aria-expanded="true"/gu)).toHaveLength(1);
    expect(markup.match(/aria-expanded="false"/gu)).toHaveLength(2);
    expect(markup.match(/<button/gu)).toHaveLength(3);
  });

  it("follows a controlled value and shows none when null", () => {
    expect(renderList({ expanded: "c" })).toContain("Detail C");
    expect(renderList({ expanded: null })).not.toContain("Detail");
  });
});

describe("Reading pair, loading line, keyboard hints", () => {
  it("lays two panes side by side and puts the chosen pane first when stacked", () => {
    const markup = html(
      h(
        ReadingPair,
        { stackFirst: "end" },
        h(ReadingPane, { label: "What you wrote" }, "mine"),
        h(ReadingPane, { label: "The need" }, "theirs"),
      ),
    );
    expect(markup).toContain("What you wrote");
    expect(markup).toContain("The need");
    expect(markup).toContain("@container");
    expect(markup).toContain("@max-xl:*:last:order-first");
  });

  it("announces loading politely in one calm line", () => {
    const markup = html(h(LoadingLine, null, "Looking for needs like yours…"));
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Looking for needs like yours…");
  });

  it("shows keys quietly in mono", () => {
    const markup = html(
      h(
        KbdHints,
        null,
        h(KbdHint, { keys: ["j", "k"] }, "move"),
        h(KbdHint, { keys: ["a"] }, "accept"),
      ),
    );
    expect(markup.match(/<kbd/gu)).toHaveLength(3);
    expect(markup).toContain("font-mono");
    expect(markup).toContain("move");
  });
});
