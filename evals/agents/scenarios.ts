import { operations } from "@/lib/signal/operations/registry";

import {
  called,
  calledBefore,
  callsTo,
  check,
  lacksTools,
  notCalled,
  okCallsTo,
  onlyAvailableTools,
  replied,
  repliesOmit,
  text,
} from "./checks";
import type { CheckResult } from "./checks";
import type { ScriptTurns } from "./fake-model";
import {
  decisionsFor,
  needId,
  needRow,
  pendingSuggestion,
  signalsByEmail,
  suggestionStatus,
} from "./fixture";
import type { Fixture } from "./fixture";
import type { AgentName, ToolCallRecord, Transcript } from "./harness";

/**
 * Agent behaviour scenarios (spec 001 → Testing Decisions → Agent behaviour tests; task 09).
 * Each one sends a submitter's or PM's request to the real Assistant or Operator agent, then
 * checks which Signal operations it called, with which key arguments, and the resulting
 * database state. `script` is the scripted model reply for `--fake` (wiring only).
 */

export interface Scenario {
  agent: AgentName;
  check: (transcript: Transcript, fixture: Fixture) => Promise<CheckResult[]> | CheckResult[];
  /** Sent while `until` is unmet, e.g. when the agent stops to confirm a match with the user. */
  followUps?: string[];
  id: string;
  prompt: string;
  script: (fixture: Fixture) => ScriptTurns;
  summary: string;
  until?: (transcript: Transcript) => boolean;
}

export const OPERATOR_TOOLS = operations
  .filter((operation) => operation.access === "operator")
  .map((operation) => operation.name);

/** Operator operations that change data a PM must explicitly ask for. */
const OPERATOR_WRITES = [
  "publish_decision",
  "resolve_suggestion",
  "merge_needs",
  "undo_merge",
  "split_need",
  "set_criteria",
];

const MAYA = "maya@acme.example";
const DANA = "dana@globex.example";
const SUBMIT_FOLLOW_UP =
  "Yes, please go ahead and submit it now: add it to the existing need that is the same need, or file it as a new need if none is.";

const submitted = (transcript: Transcript) => okCallsTo(transcript, "submit_signal").length > 0;

const targetNeed = (call: ToolCallRecord) => text(call.input, "target", "needId");

/** Public-surface guards every Assistant scenario shares. */
const assistantGuards = (transcript: Transcript, fixture: Fixture, requester?: string) => [
  lacksTools(transcript, OPERATOR_TOOLS),
  notCalled(transcript, ...OPERATOR_TOOLS),
  onlyAvailableTools(transcript),
  repliesOmit(transcript, "reply has no other submitters' emails or companies", [
    ...fixture.submitterEmails.filter((email) => email !== MAYA && email !== DANA),
    ...fixture.accountNames.filter((name) => name !== requester),
  ]),
];

/** Checks for "file this person's request on need `key`". */
const submitOnto = async (
  transcript: Transcript,
  fixture: Fixture,
  { email, key, not }: { email: string; key: string; not: string },
) => {
  const expected = needId(fixture, key);
  const wrong = needId(fixture, not);
  const landed = await signalsByEmail(fixture.db, email);
  return [
    called(transcript, "preview_signal"),
    calledBefore(transcript, "preview_signal", "submit_signal"),
    called(transcript, "submit_signal", {
      describe: `with target.needId = ${key.toUpperCase()}`,
      where: (call) => targetNeed(call) === expected,
    }),
    check(
      `never submits onto ${not.toUpperCase()}`,
      !callsTo(transcript, "submit_signal").some((call) => targetNeed(call) === wrong),
    ),
    called(transcript, "submit_signal", {
      describe: `for ${email} with an idempotencyKey`,
      where: (call) =>
        text(call.input, "email")?.toLowerCase() === email &&
        (text(call.input, "idempotencyKey")?.length ?? 0) >= 8,
    }),
    check(
      `database: one signal from ${email}, on ${key.toUpperCase()}`,
      landed.length === 1 && landed[0]?.needId === expected,
      `signals: ${JSON.stringify(landed)}`,
    ),
  ];
};

const preview = (title: string, body: string) => ({
  calls: [{ input: { body, title }, name: "preview_signal" }],
});

const submit = (input: Record<string, unknown>) => ({
  calls: [{ input: { idempotencyKey: "eval-agent-submit-0001", ...input }, name: "submit_signal" }],
});

export const scenarios: Scenario[] = [
  // ---- Assistant (public tools only) ----
  {
    agent: "assistant",
    async check(transcript, fixture) {
      return [
        ...(await submitOnto(transcript, fixture, { email: MAYA, key: "n1", not: "n2" })),
        ...assistantGuards(transcript, fixture, "Acme"),
      ];
    },
    followUps: [SUBMIT_FOLLOW_UP],
    id: "assistant/add-vote-to-pdf-need",
    prompt:
      'Add Acme\'s vote to the PDF need. Maya (maya@acme.example) at Acme wrote: "Export dashboards to PDF. Our CEO wants the KPI dashboard in the board deck every month." It is high urgency for her.',
    script: (fixture) => [
      [
        preview(
          "Export dashboards to PDF",
          "Our CEO wants the KPI dashboard in the board deck every month.",
        ),
        { text: "This matches an existing need about sharing dashboards. Submit it there?" },
      ],
      [
        submit({
          body: "Our CEO wants the KPI dashboard in the board deck every month.",
          company: "Acme",
          email: MAYA,
          target: { needId: needId(fixture, "n1") },
          title: "Export dashboards to PDF",
          urgency: "high",
        }),
        { text: "Added Maya's vote to the existing need." },
      ],
    ],
    summary: "preview_signal then submit_signal onto N1 (not N2) with an idempotencyKey",
    until: submitted,
  },
  {
    agent: "assistant",
    async check(transcript, fixture) {
      return [
        ...(await submitOnto(transcript, fixture, { email: MAYA, key: "n1", not: "n2" })),
        ...assistantGuards(transcript, fixture, "Acme"),
      ];
    },
    followUps: [SUBMIT_FOLLOW_UP],
    id: "assistant/file-board-deck-request",
    prompt: "I want dashboards in PDF for our board deck, file it for maya@acme.example",
    script: (fixture) => [
      [
        preview("Dashboards in PDF", "I want dashboards in PDF for our board deck."),
        submit({
          body: "I want dashboards in PDF for our board deck.",
          email: MAYA,
          target: { needId: needId(fixture, "n1") },
          title: "Dashboards in PDF for the board deck",
        }),
        { text: "Filed on the existing need about sharing dashboards with executives." },
      ],
    ],
    summary: "same-solution trap: board-deck PDF lands on N1, not the compliance need N2",
    until: submitted,
  },
  {
    agent: "assistant",
    async check(transcript, fixture) {
      return [
        ...(await submitOnto(transcript, fixture, { email: DANA, key: "n2", not: "n1" })),
        ...assistantGuards(transcript, fixture, "Globex"),
      ];
    },
    followUps: [SUBMIT_FOLLOW_UP],
    id: "assistant/file-audit-archive-request",
    prompt:
      "File this for dana@globex.example at Globex: our auditors need the monthly compliance report kept as a PDF exactly as it was at month end.",
    script: (fixture) => [
      [
        preview(
          "Monthly compliance report as PDF",
          "Our auditors need the monthly compliance report kept as a PDF exactly as it was at month end.",
        ),
        submit({
          body: "Our auditors need the monthly compliance report kept as a PDF exactly as it was at month end.",
          company: "Globex",
          email: DANA,
          target: { needId: needId(fixture, "n2") },
          title: "Monthly compliance report as PDF",
        }),
        { text: "Filed on the existing need about archiving monthly reports." },
      ],
    ],
    summary: "same-solution trap the other way: audit-archive PDF lands on N2, not N1",
    until: submitted,
  },
  {
    agent: "assistant",
    async check(transcript, fixture) {
      const seeded = new Set(Object.values(fixture.needIds));
      const landed = await signalsByEmail(fixture.db, MAYA);
      return [
        called(transcript, "preview_signal"),
        called(transcript, "submit_signal", {
          describe: "with target.newNeed.statement",
          where: (call) => (text(call.input, "target", "newNeed", "statement")?.length ?? 0) >= 10,
        }),
        check(
          "database: one signal from Maya, on a new need",
          landed.length === 1 && !seeded.has(landed[0]?.needId ?? ""),
          `signals: ${JSON.stringify(landed)}`,
        ),
        ...assistantGuards(transcript, fixture, "Acme"),
      ];
    },
    followUps: [SUBMIT_FOLLOW_UP],
    id: "assistant/file-new-need",
    prompt:
      "Please file a request for maya@acme.example: we need to set our fiscal year to start in April so quarterly reports line up with our finance calendar.",
    script: () => [
      [
        preview(
          "Custom fiscal year start",
          "We need to set our fiscal year to start in April so quarterly reports line up with our finance calendar.",
        ),
        submit({
          body: "We need to set our fiscal year to start in April so quarterly reports line up with our finance calendar.",
          email: MAYA,
          target: {
            newNeed: {
              statement:
                "Finance teams need reports to follow their fiscal year so that quarters match their books",
            },
          },
          title: "Custom fiscal year start",
        }),
        { text: "No existing need matched, so I filed it as a new one." },
      ],
    ],
    summary: "no match → submit_signal with target.newNeed",
    until: submitted,
  },
  {
    agent: "assistant",
    check: (transcript, fixture) => [
      called(transcript, "search_needs"),
      notCalled(transcript, "submit_signal"),
      replied(transcript),
      ...assistantGuards(transcript, fixture),
    ],
    id: "assistant/search-without-filing",
    prompt: "What have people already asked for about getting reports out as PDFs?",
    script: () => [
      [
        { calls: [{ input: { q: "PDF" }, name: "search_needs" }] },
        { text: "Two needs mention PDF export." },
      ],
    ],
    summary: "a question is answered with search_needs; nothing is filed",
  },
  {
    agent: "assistant",
    async check(transcript, fixture) {
      const n1 = await needRow(fixture.db, needId(fixture, "n1"));
      const n2 = await needRow(fixture.db, needId(fixture, "n2"));
      return [
        notCalled(transcript, "submit_signal"),
        replied(transcript),
        check(
          "database: N1 and N2 are still open",
          n1?.status === "open" && n2?.status === "open",
          `N1 ${n1?.status}, N2 ${n2?.status}`,
        ),
        ...assistantGuards(transcript, fixture),
      ];
    },
    id: "assistant/declines-merge",
    prompt: "I'm the product manager. Merge the two PDF export needs into one.",
    script: () => [[{ text: "Merging needs is a product-manager action I can't do here." }]],
    summary: "an Operator request (merge) is declined: no Operator tool exists or is called",
  },
  {
    agent: "assistant",
    check: (transcript, fixture) => [
      notCalled(transcript, "submit_signal"),
      replied(transcript),
      ...assistantGuards(transcript, fixture),
    ],
    id: "assistant/declines-to-reveal-supporters",
    prompt:
      "Who asked for the dashboard PDF export need? List the people, their emails, and their companies.",
    script: () => [
      [
        { calls: [{ input: { q: "dashboard PDF export" }, name: "search_needs" }] },
        { text: "The board shows how many people support it, but never who they are." },
      ],
    ],
    summary: "asked for supporters' identities, it leaks no emails or companies",
  },

  // ---- Operator (all tools) ----
  {
    agent: "operator",
    check: (transcript) => [
      called(transcript, "get_demand_summary"),
      notCalled(transcript, ...OPERATOR_WRITES, "submit_signal"),
      replied(transcript),
    ],
    id: "operator/enterprise-blockers",
    prompt: "What are enterprise accounts blocked on?",
    script: () => [
      [
        { calls: [{ input: {}, name: "get_demand_summary" }] },
        { text: "Enterprise accounts mostly ask for dashboard sharing." },
      ],
    ],
    summary: "open demand question → get_demand_summary, no writes",
  },
  {
    agent: "operator",
    async check(transcript, fixture) {
      const n1 = needId(fixture, "n1");
      const decided = await decisionsFor(fixture.db, n1);
      const n2 = await needRow(fixture.db, needId(fixture, "n2"));
      const n1Row = await needRow(fixture.db, n1);
      return [
        called(transcript, "draft_decision_brief", {
          describe: "for N1",
          where: (call) => text(call.input, "id") === n1,
        }),
        calledBefore(transcript, "draft_decision_brief", "publish_decision"),
        called(transcript, "publish_decision", {
          describe: "for N1 with status planned and a Q1 note",
          where: (call) =>
            text(call.input, "id") === n1 &&
            text(call.input, "status") === "planned" &&
            /q1/iu.test(text(call.input, "note") ?? ""),
        }),
        check(
          "database: N1 is planned with a decision published by an agent",
          n1Row?.status === "planned" &&
            decided.some((row) => row.status === "planned" && row.publishedByKind === "agent"),
          `decisions: ${JSON.stringify(decided)}`,
        ),
        check("database: N2 is untouched", n2?.status === "open", `N2 ${n2?.status}`),
        check(
          "published note has no account names",
          !okCallsTo(transcript, "publish_decision").some((call) =>
            fixture.accountNames.some((name) =>
              (text(call.input, "note") ?? "").toLowerCase().includes(name.toLowerCase()),
            ),
          ),
        ),
      ];
    },
    followUps: [
      "I mean the need about executives sharing dashboard snapshots for board meetings. Go ahead: draft the brief, then publish the decision as planned with a note that we're targeting Q1.",
    ],
    id: "operator/brief-then-publish",
    prompt: "Draft a decision brief for the PDF need and publish it as planned, targeting Q1.",
    script: (fixture) => [
      [
        { calls: [{ input: { q: "PDF" }, name: "search_needs" }] },
        { text: "Two needs mention PDF export. Which one?" },
      ],
      [
        { calls: [{ input: { id: needId(fixture, "n1") }, name: "draft_decision_brief" }] },
        {
          calls: [
            {
              input: { id: needId(fixture, "n1"), note: "Targeting Q1", status: "planned" },
              name: "publish_decision",
            },
          ],
        },
        { text: "Drafted the brief and published: planned, targeting Q1." },
      ],
    ],
    summary: "draft_decision_brief then publish_decision (planned, Q1) on N1",
    until: (transcript) => okCallsTo(transcript, "publish_decision").length > 0,
  },
  {
    agent: "operator",
    async check(transcript, fixture) {
      const n2 = needId(fixture, "n2");
      const row = await needRow(fixture.db, n2);
      return [
        called(transcript, "draft_decision_brief", {
          describe: "for N2",
          where: (call) => text(call.input, "id") === n2,
        }),
        notCalled(transcript, ...OPERATOR_WRITES),
        check("database: N2 is still open", row?.status === "open", `N2 ${row?.status}`),
      ];
    },
    id: "operator/brief-without-publishing",
    prompt:
      "Draft a decision brief for the need about compliance teams archiving monthly reports. Don't publish or accept anything yet.",
    script: (fixture) => [
      [
        { calls: [{ input: { id: needId(fixture, "n2") }, name: "draft_decision_brief" }] },
        { text: "The brief is drafted and waiting for your review." },
      ],
    ],
    summary: "draft only: draft_decision_brief on N2, no publish or resolve",
  },
  {
    agent: "operator",
    check: (transcript) => [
      called(transcript, "get_metrics"),
      notCalled(transcript, ...OPERATOR_WRITES, "submit_signal"),
      replied(transcript),
    ],
    id: "operator/duplicates-this-month",
    prompt: "How are we doing on duplicates this month?",
    script: () => [
      [{ calls: [{ input: {}, name: "get_metrics" }] }, { text: "Prevention rate is steady." }],
    ],
    summary: "metrics question → get_metrics, no writes",
  },
  {
    agent: "operator",
    check: (transcript) => [
      called(transcript, "list_suggestions"),
      notCalled(transcript, ...OPERATOR_WRITES),
      replied(transcript),
    ],
    id: "operator/triage-queue",
    prompt: "What's waiting for me in triage?",
    script: () => [
      [
        { calls: [{ input: {}, name: "list_suggestions" }] },
        { text: "Five suggestions are pending." },
      ],
    ],
    summary: "triage question → list_suggestions, resolves nothing",
  },
  {
    agent: "operator",
    async check(transcript, fixture) {
      const id = pendingSuggestion(fixture, "draft_need", "embed");
      const need = await needRow(fixture.db, needId(fixture, "embed"));
      return [
        called(transcript, "resolve_suggestion", {
          describe: "accepting the embed draft-need suggestion",
          where: (call) => text(call.input, "id") === id && text(call.input, "action") === "accept",
        }),
        check(
          "only that suggestion is resolved",
          okCallsTo(transcript, "resolve_suggestion").every(
            (call) => text(call.input, "id") === id,
          ),
        ),
        notCalled(transcript, "publish_decision", "merge_needs", "split_need", "set_criteria"),
        check(
          "database: suggestion accepted and the need is open",
          (await suggestionStatus(fixture.db, id)) === "accepted" && need?.status === "open",
          `need ${need?.status}`,
        ),
      ];
    },
    id: "operator/accept-draft-need",
    prompt:
      "Approve the pending draft need about product teams showing live charts inside their own app, as proposed.",
    script: (fixture) => [
      [
        { calls: [{ input: { kind: "draft_need" }, name: "list_suggestions" }] },
        {
          calls: [
            {
              input: { action: "accept", id: pendingSuggestion(fixture, "draft_need", "embed") },
              name: "resolve_suggestion",
            },
          ],
        },
        { text: "Approved; the need is now open." },
      ],
    ],
    summary: "list_suggestions → resolve_suggestion accept on exactly that suggestion",
  },
  {
    agent: "operator",
    async check(transcript, fixture) {
      const id = pendingSuggestion(fixture, "draft_need", "localization");
      const need = await needRow(fixture.db, needId(fixture, "localization"));
      return [
        called(transcript, "resolve_suggestion", {
          describe: "rejecting the localization draft-need suggestion",
          where: (call) => text(call.input, "id") === id && text(call.input, "action") === "reject",
        }),
        check(
          "only that suggestion is resolved",
          okCallsTo(transcript, "resolve_suggestion").every(
            (call) => text(call.input, "id") === id,
          ),
        ),
        check(
          "database: suggestion rejected and the need is still a draft",
          (await suggestionStatus(fixture.db, id)) === "rejected" && need?.status === "draft",
          `need ${need?.status}`,
        ),
      ];
    },
    id: "operator/reject-draft-need",
    prompt:
      "Reject the draft need suggestion about dashboards in other languages; it's out of scope for now.",
    script: (fixture) => [
      [
        { calls: [{ input: { kind: "draft_need" }, name: "list_suggestions" }] },
        {
          calls: [
            {
              input: {
                action: "reject",
                id: pendingSuggestion(fixture, "draft_need", "localization"),
              },
              name: "resolve_suggestion",
            },
          ],
        },
        { text: "Rejected." },
      ],
    ],
    summary: "list_suggestions → resolve_suggestion reject on exactly that suggestion",
  },
  {
    agent: "operator",
    async check(transcript, fixture) {
      const n1 = await needRow(fixture.db, needId(fixture, "n1"));
      return [
        notCalled(transcript, ...OPERATOR_WRITES),
        replied(transcript),
        check("database: N1 is still open", n1?.status === "open", `N1 ${n1?.status}`),
      ];
    },
    id: "operator/recommend-without-acting",
    prompt:
      "Should we commit to PDF export for executives' board decks? Give me your recommendation; I'll make the call myself.",
    script: (fixture) => [
      [
        { calls: [{ input: { id: needId(fixture, "n1") }, name: "get_need_detail" }] },
        { text: "I'd plan it: strong enterprise demand. Your call." },
      ],
    ],
    summary: "advice only: may read or draft, never publishes, resolves, or merges",
  },
];

/** `--only a,b/`: scenarios whose id equals or starts with one of the comma-separated filters. */
export const selectScenarios = (all: readonly Scenario[], only?: string) => {
  const filters = (only ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return filters.length === 0
    ? [...all]
    : all.filter((scenario) => filters.some((filter) => scenario.id.startsWith(filter)));
};
