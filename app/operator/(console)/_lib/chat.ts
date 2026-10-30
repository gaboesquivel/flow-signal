/**
 * Console chat (spec 006 task 07): the Operator agent's answer rendered as pencil prose with
 * linked needs and a cited-needs list. The agent links a need as `[words](need:<id>)` (or
 * `/operator/needs/<id>`); everything else in its markdown is read as plain text. Browser-safe.
 */

const UUID = String.raw`[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}`;
const UUID_ONLY = new RegExp(`^${UUID}$`, "iu");
const NEED_LINK = new RegExp(
  String.raw`\[([^\]]+)\]\((?:need:|/operator/needs/)(${UUID})\)`,
  "giu",
);

export interface CitedNeed {
  accounts: string[];
  id: string;
  people: number | null;
  statement: string;
  status: string | null;
}

export type AnswerSegment =
  | { text: string; type: "text" }
  | { id: string; text: string; type: "need" };
export type AnswerBlock =
  | { kind: "paragraph"; segments: AnswerSegment[] }
  | { items: AnswerSegment[][]; kind: "list" };

/** What the chat route returns for one question. */
export interface ChatAnswer {
  answer: string;
  cited: CitedNeed[];
  sources: { input: unknown; name: string }[];
}

/** Drops markdown emphasis and code marks the console does not style. */
const plain = (text: string) =>
  text.replaceAll(/\*\*|__|`/gu, "").replaceAll(/(?<lead>^|\s)[*_](?<word>\S)/gu, "$<lead>$<word>");

const segmentsOf = (line: string): AnswerSegment[] => {
  const segments: AnswerSegment[] = [];
  let last = 0;
  for (const match of line.matchAll(NEED_LINK)) {
    const before = line.slice(last, match.index);
    if (before) segments.push({ text: plain(before), type: "text" });
    segments.push({
      id: (match[2] ?? "").toLowerCase(),
      text: plain(match[1] ?? ""),
      type: "need",
    });
    last = match.index + match[0].length;
  }
  const rest = line.slice(last);
  if (rest) segments.push({ text: plain(rest), type: "text" });
  return segments;
};

const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)])\s+/u;

/** Paragraphs (blank-line separated) and bullet or numbered lists; headings become paragraphs. */
export const answerBlocks = (answer: string): AnswerBlock[] => {
  const blocks: AnswerBlock[] = [];
  for (const chunk of answer.replaceAll("\r\n", "\n").split(/\n\s*\n/u)) {
    const lines = chunk
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    let paragraph: string[] = [];
    let items: string[] = [];
    const flushParagraph = () => {
      if (paragraph.length > 0)
        blocks.push({ kind: "paragraph", segments: segmentsOf(paragraph.join(" ")) });
      paragraph = [];
    };
    const flushItems = () => {
      if (items.length > 0) blocks.push({ items: items.map(segmentsOf), kind: "list" });
      items = [];
    };
    for (const line of lines) {
      if (LIST_ITEM.test(line)) {
        flushParagraph();
        items.push(line.replace(LIST_ITEM, ""));
      } else {
        flushItems();
        paragraph.push(line.replace(/^#{1,6}\s+/u, ""));
      }
    }
    flushParagraph();
    flushItems();
  }
  return blocks;
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asNeed = (value: Record<string, unknown>): CitedNeed | null => {
  const id = typeof value.needId === "string" ? value.needId : value.id;
  if (typeof id !== "string" || !UUID_ONLY.test(id) || typeof value.statement !== "string")
    return null;
  const people = [value.supporters, value.people].find((count) => typeof count === "number");
  const accounts = Array.isArray(value.accounts)
    ? value.accounts.flatMap((account) => {
        const name = record(account)?.name;
        return typeof name === "string" ? [name] : [];
      })
    : [];
  return {
    accounts,
    id: id.toLowerCase(),
    people: typeof people === "number" ? people : null,
    statement: value.statement,
    status: typeof value.status === "string" ? value.status : null,
  };
};

/** Every need (an object with a uuid `id`/`needId` and a `statement`) anywhere in a tool output. */
export const needsInToolOutput = (output: unknown): CitedNeed[] => {
  const found: CitedNeed[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 6) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const object = record(value);
    if (!object) return;
    const need = asNeed(object);
    if (need) found.push(need);
    for (const [key, child] of Object.entries(object))
      if (key !== "accounts" && typeof child === "object") visit(child, depth + 1);
  };
  visit(output, 0);
  return found;
};

/** The needs the answer links, each once, in the order they first appear. */
export const citedNeeds = (answer: string, seen: readonly CitedNeed[]): CitedNeed[] => {
  const known = new Map<string, CitedNeed>();
  for (const need of seen) if (!known.has(need.id)) known.set(need.id, need);
  const cited = new Map<string, CitedNeed>();
  for (const match of answer.matchAll(NEED_LINK)) {
    const id = (match[2] ?? "").toLowerCase();
    if (cited.has(id)) continue;
    cited.set(
      id,
      known.get(id) ?? {
        accounts: [],
        id,
        people: null,
        statement: plain(match[1] ?? ""),
        status: null,
      },
    );
  }
  return [...cited.values()];
};

const describeValue = (value: unknown) =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : JSON.stringify(value);

/** "get_demand_summary · plan = Enterprise · list_operator_needs": what the answer read. */
export const toolSourceLine = (sources: readonly { input: unknown; name: string }[]) =>
  sources
    .map(({ input, name }) => {
      const args = Object.entries(record(input) ?? {})
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(([key, value]) => `${key} = ${describeValue(value)}`);
      return [name, ...args].join(" · ");
    })
    .join(" · ");
