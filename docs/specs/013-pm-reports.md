# 013 — PM Reports: describe any report, get grounded charts, save and share it

Status: implemented (2026-10-30)

Product brief: [PRODUCT.md](../../PRODUCT.md) → Who (PMs, agents, stakeholders), Core journeys 8, Diagnostics → Report reuse, Riskiest assumption 6. Decision: [0010](../decisions/0010-reports-as-typed-specs-over-named-datasets.md). Builds on [spec 001](./001-signal-mvp.md) (operations, event log, `get_metrics`), [spec 006](./006-lean-ledger-ui.md) (Operator console, `check_public_text`, Lean Ledger design), and [spec 007](./007-decision-direction.md) (decisions, readiness).

**Bet.** If a PM can describe a report in plain words and get one built only from Signal's records, which they can save, re-run, and share, PMs will come back to their reports instead of rebuilding them in a spreadsheet. A fixed catalog of read-only datasets covers most of what they ask (assumption 6).

## Problem Statement

PMs answer recurring questions for leadership and go-to-market teams: where demand sits by theme and plan, how fast decisions get made, which enterprise accounts are waiting on what, and how the matching bet is doing. Today they have three options, and none of them works:

- **Metrics** shows a fixed set of numbers.
- **Needs** is a table with no aggregation over time.
- **Chat** answers in two paragraphs, with no charts and nothing saved.

So PMs export to a spreadsheet and rebuild the same report each week, and stakeholders get screenshots.

`/genui` looks like a report builder, but it is a public playground that composes from fictional Acme fixtures, and its prompt tells the model to invent synthetic rows ([generate-openui.ts](../../lib/genui/orchestration/generate-openui.ts)). Its charting is a single bar chart. It can't show PM-only data (revenue, accounts), it can't be trusted for decisions, and it saves nothing.

## Solution

A **Reports** tab in the Operator console (`/operator/reports`):

1. The PM describes a report ("ARR-weighted demand by theme for the last quarter, with the top 10 enterprise needs"), or picks a starter.
2. Signal plans which datasets to read from a fixed catalog, runs those queries on the server, and lays out a report of headings, short text, KPI numbers, charts (bar, line, area, scatter, donut), and tables. Every chart and table names its dataset and can show its rows. Numbers come only from the data. A sentence citing a figure that isn't in the data is rejected.
3. The PM refines it in plain words ("make it weekly", "only Growth accounts", "add a table of the accounts"), then **Save**s it. Saved reports are listed. Opening one re-runs its queries on fresh data with no model call.
4. **Share** creates a read-only link (`/r/<token>`) that shows a snapshot of the report as of when it was shared. Before sharing, Signal flags names, account names, and emails in the report (the `check_public_text` matcher), and the PM confirms. The PM can refresh the snapshot or revoke the link.

Agents get the same capability over Operator MCP (`generate_report`, `save_report`, `list_reports`, `get_report`, `share_report`, `get_report_dataset`). `/genui` redirects to `/operator/reports`.

## User Stories

1. As a PM, I want to describe a report in plain words and get charts and tables of Signal's real data, so that I stop rebuilding it in a spreadsheet.
2. As a PM, I want every figure to show where it came from, so that I can trust it in front of leadership.
3. As a PM, I want to refine a report conversationally and save it, so that next week I open it and it is current.
4. As a PM, I want to share a read-only link with a check for names and accounts first, so that stakeholders see the report without console access and nothing leaks by accident.
5. As an agent with Operator access, I want to generate, save, re-run, and share reports over MCP, so that I can produce a weekly digest for a PM.
6. As a PM asking for something no dataset covers ("NPS by region"), I want to be told what's missing rather than shown invented numbers.
7. As a stakeholder, I want a shared link that says when its data is from and that fails clearly once revoked.

## Implementation Decisions

### Report spec (contract-first, decision 0010)

`lib/signal/domain/report-spec.ts` holds the zod schemas. Every surface validates against them. They are JSON only.

```ts
type DatasetName = "needs" | "signals_weekly" | "accounts" | "decisions" | "metrics_weekly";

interface DatasetQuery {
  id: string; // "d1"… unique within a report; blocks reference it
  name: DatasetName;
  params: DatasetParams; // per-dataset zod, below
}

interface ColumnDef {
  key: string;
  label: string;
  type: "string" | "number" | "date";
  unit?: "cents" | "count" | "days" | "percent" | "score";
}

interface DatasetResult {
  columns: ColumnDef[];
  rows: Record<string, string | number | null>[];
  truncated: boolean;
}

type Block =
  | { kind: "heading"; text: string }
  | { kind: "text"; markdown: string } // ≤ 600 chars; traceability-checked
  | {
      kind: "kpi";
      items: {
        label: string;
        dataset: string;
        column: string;
        aggregate: "sum" | "count" | "avg" | "median" | "min" | "max" | "latest";
      }[];
    } // 1–4
  | {
      kind: "chart";
      chart: "bar" | "line" | "area" | "scatter" | "donut";
      title: string;
      caption?: string;
      dataset: string;
      x: string;
      y: string[];
      seriesBy?: string; // pivot a string column into series
      stacked?: boolean;
      aggregate?: "sum" | "avg" | "count" | "min" | "max"; // rows sharing an x are combined (default sum; not scatter)
      horizontal?: boolean;
      sort?: { column: string; direction: "asc" | "desc" };
      limit?: number;
    }
  | {
      kind: "table";
      title: string;
      dataset: string;
      columns: string[];
      sort?: { column: string; direction: "asc" | "desc" };
      limit?: number;
    };

interface ReportSpec {
  version: 1;
  title: string;
  datasets: DatasetQuery[]; // 1–6
  blocks: Block[]; // 1–20
}
```

`validateReportSpec(spec, results)` checks:

- every block's `dataset` is a declared id, and every referenced column exists in that dataset's columns
- `y`, KPI columns other than `count`, and scatter `x` columns are numeric
- `seriesBy` is a string column
- `donut` has exactly one `y`

It returns typed issues. Aggregation, sorting, limits, and pivoting are pure functions in the same module (`applyBlockData`). The renderer and the KPI calculation share them, so a number on screen is always a function of the rows.

### Dataset catalog: `get_report_dataset` (Operator, read)

`GET /api/operator/report-datasets/:name`. Domain: `lib/signal/domain/report-datasets.ts`, `runReportDataset(db, query, now)`. Each dataset is one SQL query, at most 500 rows (`truncated: true` beyond that). Money is in cents.

| Dataset          | Params                                                                  | Row                                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `needs`          | `themeId?`, `plan?`, `status?[]`, `includeDecided` (default true)       | needId, statement, theme, status, people, accounts, arrCents, openDealCents, score, trend, createdAt, readyAt, decidedAt (live needs, merged-away excluded) |
| `signals_weekly` | `since?` (default 12 weeks), `until?`, `groupBy`: none/theme/plan/actor | weekStart, group, signals, attachedExisting, attachedDraft                                                                                                  |
| `accounts`       | `plan?`                                                                 | accountId, account, plan, arrCents, openDealCents, needsSupported, signals, lastSignalAt                                                                    |
| `decisions`      | `since?` (default 180 days), `until?`, `themeId?`                       | needId, statement, theme, status, publishedAt, latencyDays, recommendedStatus                                                                               |
| `metrics_weekly` | `since?` (default 12 weeks), `until?`, `actor`: all/human/agent         | weekStart, preventionRate, signals, attachedExisting, mergedLater (the `get_metrics` weekly series)                                                         |

The operation description lists the catalog for agents. Operator-only data (accounts, ARR) is allowed here because every caller is the Operator. No dataset returns submitter names, emails, or verbatim signal text.

### `generate_report` (Operator, read)

`POST /api/operator/reports/generate`, body `{ prompt (1–2000 chars), prior?: ReportSpec }` (limit 64 KB). It returns `{ report: ReportSpec, data: Record<datasetId, DatasetResult>, asOf, warnings: string[] }` and saves nothing.

Domain: `lib/signal/domain/report-generation.ts`. Its dependencies are injected (`{ reasoner, runDataset, now }`) so tests can stub them. There are two new `ReasonerTask`s on the reasoning model:

1. **`report_plan`:** the prompt, the prior spec, the dataset catalog with its params and columns, and the theme list (id, name) give the dataset queries plus `gaps` (parts of the request the catalog can't answer).
2. Run the queries.
3. **`report_compose`:** the prompt, the prior spec, each dataset's columns, and up to 20 sample rows each give the title and blocks.
4. `validateReportSpec` plus the **traceability check**: every number in a text block (digits, after stripping `$`, `%`, `,`, and k/M suffixes, with tolerance for rounding to the displayed precision) must equal a value in the data or a KPI the report computes. One repair round sends the issues back to `report_compose`. Blocks that still fail are dropped, with a warning.
5. `gaps` become warnings ("No dataset covers NPS; showing …").

If the model is unreachable, the call fails with `ai_unavailable`. Saved reports still open, because re-running a report needs no model.

### Saved reports and sharing

New table `reports`:

- `id`, `title`, `prompt`, `spec jsonb`
- `snapshot jsonb` (the datasets as of `snapshot_at`) and `snapshot_at`
- `share_token text unique null` and `shared_at`
- `created_by_kind`, `created_at`, `updated_at`

The migration is additive.

| Operation           | Access          | HTTP                                         | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | --------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `save_report`       | operator, write | `POST /api/operator/reports`                 | `{ reportId?, title, prompt, spec, idempotencyKey? }`. Validates the spec, re-runs its queries on the server (client rows are never accepted), and stores spec plus snapshot. Creates, or updates `reportId`. Records `report.saved` (`{ reportId, created: boolean }`; deduped by the key). Errors: `not_found`, `validation_failed` with the spec issues in the message.                                                                                                                     |
| `list_reports`      | operator        | `GET /api/operator/reports`                  | `{ reports: [{ reportId, title, updatedAt, sharedAt \| null }] }`, newest first.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `get_report`        | operator        | `GET /api/operator/reports/:reportId`        | Re-runs the queries now and returns `{ reportId, title, prompt, spec, data, asOf, share: { path, sharedAt, snapshotAt } \| null }`. Records `report.viewed` (`{ reportId, via: "console" }`).                                                                                                                                                                                                                                                                                                  |
| `share_report`      | operator, write | `POST /api/operator/reports/:reportId/share` | `{ action: "share" \| "refresh" \| "revoke", acknowledgeFlags?: boolean }`. Share and refresh re-run the queries into the snapshot and scan text blocks, titles, and string cells with `findIdentifyingText`. If anything is found and `acknowledgeFlags` isn't set, it returns `{ status: "needs_acknowledgement", flags }` and changes nothing. Otherwise `{ status: "shared", path: "/r/<token>", snapshotAt }`. Revoke clears the token. Records `report.shared` (`{ reportId, action }`). |
| `get_shared_report` | public          | `GET /api/shared-reports/:token`             | `{ title, spec, data, snapshotAt }` from the snapshot; `not_found` for an unknown or revoked token. Records `report.viewed` (`{ reportId, via: "link" }`). Default public rate limit.                                                                                                                                                                                                                                                                                                          |

Tokens are 32 random bytes, base64url, like tracking links. Event types `report.saved`, `report.viewed`, and `report.shared` are added to `SignalEventType`.

### Report reuse metric

`get_metrics` gains `reportReuse` as defined in PRODUCT.md → Diagnostics. Reports first saved in the window count. A report is reused if a `report.viewed`, `report.shared`, or later `report.saved` exists within 14 days of its first save, counting only actions by an actor other than the save itself. It is split by the saver's actor kind (human, agent). `/operator/metrics` shows one line for it.

### UI (Lean Ledger, DESIGN.md)

- **Console nav:** Triage · Needs · Decide · Criteria · Metrics · **Reports** · Chat.
- **`/operator/reports`:** one prompt field ("Describe a report") with 4–5 starter prompts in a quiet line, then the saved reports as a ruled list (title, updated, "shared" text marker). No cards.
- **Report view** (`/operator/reports/new?q=…`, `/operator/reports/[reportId]`): title, an "as of" line, then blocks top to bottom:
  - KPIs are large mono numbers with labels.
  - Charts use Recharts through `components/chart.tsx` (shadcn `ChartContainer`), with colours from chart tokens defined on `:root` and in dark mode. A categorical palette is validated with the `dataviz` skill. There are no gridline boxes or gradients, and axes are mono.
  - Each chart has a "Data" disclosure showing its rows as a ruled table, and a quiet source line naming the dataset and params.
  - Tables are ruled, with right-aligned mono numbers.
  - Text is markdown in the body face.
  - Warnings appear as a pencil line at the top.
  - Below the report sits a refine field. Actions are **Save** (the one primary), Refresh, and Share. Share opens an inline panel with the flags and the copyable link.
- **Shared view `/r/[token]`:** the same renderer, read-only, with "Shared from Signal · data as of <date>". Its metadata sets `noindex`.
- `/genui` permanently redirects to `/operator/reports`, and `app/_components/studio/` is deleted. `lib/genui`, `/api/genui/compose`, the `compose_ui` MCP tool, and the MCP app are unchanged.

Renderer: `components/report/` (`report-view.tsx`, `report-chart.tsx`, `report-table.tsx`, `report-kpis.tsx`). Its props are `{ spec, data }` only, so it has no fetching and the console and the shared page use the same component.

### Exposure

- `/operator/reports*` and every report operation except `get_shared_report` are Operator-only: Operator auth on REST and the Operator MCP and agent. On a deployment without the Operator secret they fail closed, as the console does.
- `get_shared_report` and `/r/[token]` are public but token-gated. They show only the snapshot the PM chose to share, after the identifying-text check, and stop working when revoked.
- `generate_report` costs model calls and is reachable only with Operator access. It is not exposed publicly.
- `/genui` no longer serves a page.

## Testing Decisions

Tests go test-first at the domain and operation level, against the PGlite or test database harness, as the existing domain tests do. Parity covers each new operation. There are no UI tests (ARCHITECTURE → Testing). The UI is checked by hand in the browser against DESIGN.md. Prior art: `tests/signal/domain/metrics.test.ts`, `tests/signal/domain/decisions.test.ts` (fake reasoner), `tests/signal/domain/tracking-links.test.ts` (tokens), and `tests/signal/parity/*`.

In scope:

- **Spec validation:** an unknown dataset id, a missing column, a non-numeric `y`, a donut with two `y`s, and too many blocks. `applyBlockData` aggregates, sorts, limits, and pivots correctly, including nulls.
- **Each dataset** on a hand-built workspace: correct rows; merged-away needs excluded; filters; week buckets aligned with `get_metrics`; the 500-row truncation; no names, emails, or signal text in any row.
- **Generation**, with a fake reasoner:
  - The plan's queries are what runs.
  - A text block citing a number absent from the data triggers one repair, and is dropped if the repair fails, with a warning.
  - `gaps` become warnings.
  - A `prior` spec reaches both prompts.
  - A model outage gives `ai_unavailable`.
  - A plan naming an unknown dataset or bad params fails validation and is repaired or reported, never run.
- **Saving:**
  - Client-supplied `data` is ignored, and the server snapshot is stored.
  - An update keeps the id.
  - An idempotent retry records one `report.saved`.
  - An invalid spec gives `validation_failed`.
- **Sharing:** flags without acknowledgement change nothing; acknowledging shares; refresh moves `snapshotAt`; revoke makes `get_shared_report` return `not_found`; the snapshot (not live data) is what the link returns.
- **Metric:** a report reused on day 13 counts and one on day 15 does not; the saver's own initial save doesn't count as reuse; human and agent are split; a failed save writes no event.
- **Parity:** all six operations agree on REST, Operator MCP, and the Operator agent (`get_shared_report` on REST and public MCP). Operator operations return `unauthorized` without the secret.

**Acceptance scenario.** A fresh `pnpm db:seed` workspace has themes (Reporting, Integrations, …), Enterprise, Growth, and Starter accounts with ARR, needs with signals over the past 12 weeks, and some published decisions. The model calls run live or through the fake reasoner in tests.

1. Priya (PM, signed in to the console) opens Reports, which shows the prompt field and no saved reports.
2. She asks "ARR-weighted demand by theme, plus the top 10 needs for Enterprise accounts". Within 30 s the report shows:
   - a KPI row (live needs, total ARR of requesting accounts)
   - a bar chart of `arrCents` by theme from `needs`
   - a table of 10 needs from `needs` with `plan=Enterprise`
     Opening each chart's Data disclosure shows the rows, and the numbers match `/operator/needs` for the same needs.
3. She refines with "also show signals per week by theme for the last 12 weeks, stacked". A stacked area or bar chart from `signals_weekly` (`groupBy: theme`) is added, and the earlier blocks stay.
4. She asks "add NPS by region". Signal shows a warning that no dataset covers NPS, and no NPS figures appear.
5. She saves the report as "Weekly demand". It appears in the list, and one `report.saved` (human) exists.
6. A new signal from an Enterprise account is submitted. Priya reopens "Weekly demand", which re-runs with no model call, and the people count for that need rises by 1.
7. She clicks Share. The panel flags account names in the table. She confirms, gets `/r/<token>`, and one `report.shared` exists.
8. In a private window, `/r/<token>` shows the report with "data as of …" and is reachable without Operator access. Another new signal does not change it until Priya clicks Refresh in Share.
9. She revokes the link, and `/r/<token>` returns not found.
10. Over Operator MCP, an agent calls:
    - `generate_report` with "decision latency trend by month this half-year"
    - `save_report` with the result
    - `get_report`, which matches the console view
    - `share_report` with `acknowledgeFlags: false` on a report with account names, which returns `needs_acknowledgement` and changes nothing
11. `get_metrics` shows `reportReuse`: Priya's report counts as reused (viewed and shared within 14 days), attributed to human, and the agent's report counts under agent. Without the Operator secret, `generate_report` returns `unauthorized`.
12. Visiting `/genui` lands on `/operator/reports`.

## Out of Scope

- Free-form SQL or model-written code. New datasets are added to the catalog.
- Scheduled refresh or email digests.
- PNG, PDF, or CSV export (the Data disclosure is the inspection path).
- Uploaded or pasted external data.
- Dashboards with several reports, editing a report's layout by hand, and access control per shared link beyond the token.
- Changing `lib/genui`, `/api/genui/compose`, the `compose_ui` MCP tool, or the MCP app.

## Tasks

- [x] 01: Report contract, dataset catalog types, and planned operation stubs
- [x] 02: `get_report_dataset` and the five datasets
- [x] 03: `generate_report` with plan, compose, validation, and traceability
- [x] 04: Saved reports, sharing, events, and the reuse metric
- [x] 05: Report renderer components and chart tokens
- [x] 06: Reports pages, shared page, nav, and the `/genui` redirect

### 01: Report contract, dataset catalog types, and planned operation stubs

**What to build:** `lib/signal/domain/report-spec.ts` holds the zod schemas above, `validateReportSpec`, and `applyBlockData`, with tests. Dataset names, params schemas, and column definitions live in `report-datasets.ts`, with `runReportDataset` stubbed. Six `plannedOperation` stubs plus registry entries. The reasoner task names and event types.

**Area:** lib/signal/domain/report-spec.ts, lib/signal/domain/report-datasets.ts (types), lib/signal/operations/\*report\*.ts, registry.ts, ai/ports.ts, events.ts, tests

**Blocked by:** None

- [ ] Spec validation and `applyBlockData` tests pass.
- [ ] Registry and client tests pass with planned stubs.

### 02: `get_report_dataset` and the five datasets

**What to build:** `runReportDataset` SQL for each dataset, plus the operation, domain tests, and parity.

**Area:** lib/signal/domain/report-datasets.ts, lib/signal/operations/get-report-dataset.ts, tests

**Blocked by:** 01

- [ ] Each dataset's rows, filters, and truncation are tested, and there is no PII.
- [ ] Parity passes.

### 03: `generate_report` with plan, compose, validation, and traceability

**What to build:** `report-generation.ts` with injected dependencies, the operation, a fake reasoner for the two tasks, domain tests, and parity.

**Area:** lib/signal/domain/report-generation.ts, lib/signal/operations/generate-report.ts, lib/signal/ai/fakes.ts, tests

**Blocked by:** 01

- [ ] Generation tests (above) pass with fakes, and parity passes.

### 04: Saved reports, sharing, events, and the reuse metric

**What to build:** the `reports` table and migration, `domain/reports.ts`, the five operations, events, `reportReuse` in `metrics.ts`, plus tests and parity.

**Area:** lib/db/schema.ts, drizzle/, lib/signal/domain/reports.ts, lib/signal/operations/{save,list,get,share}-report.ts, get-shared-report.ts, lib/signal/metrics.ts, tests

**Blocked by:** 01

- [ ] Saving, sharing, and metric tests pass, and parity passes.
- [ ] The migration is additive.

### 05: Report renderer components and chart tokens

**What to build:** `components/report/*`, which renders every block kind from `{ spec, data }`, the chart colour tokens in `styles/`, and a dev fixture.

**Area:** components/report/, styles/

**Blocked by:** 01

- [ ] Every block and chart kind renders from the fixture in light and dark mode, checked by hand.

### 06: Reports pages, shared page, nav, and the `/genui` redirect

**What to build:** the console pages, the `/r/[token]` page, the nav link, the `/genui` redirect, the studio deletion, client regeneration, the metrics line, and ARCHITECTURE and GLOSSARY updates.

**Area:** app/operator/(console)/reports/, app/r/[token]/, app/genui/, console-shell.tsx, next.config.ts, ARCHITECTURE.md, GLOSSARY.md

**Blocked by:** 02, 03, 04, 05

- [ ] The acceptance scenario passes in the browser.

## Further Notes

- The 30 s target in step 2 is a hypothesis. It is two reasoning-model calls plus SQL. If it is too slow, `report_compose` can move to the fast model.
- Assumption 6 is measured informally at first: the warnings from `gaps` show which datasets are missing. Logging `gaps` into an event is a follow-up.
- Starter prompts: "Demand by theme, ARR-weighted", "Signals per week by plan", "Decision latency by month", "Top Enterprise needs", "Prevention rate trend".
- Built findings (2026-10-30):
  - `report_compose` returns each block as `{ kind, json }` (the block's fields as a JSON string), validated after. Constrained decoding on a wide object of optional fields took 45–120+ s per call; this shape composes in seconds. Live runs: 6–11 s per report.
  - Saved snapshots hold `{ title, spec, data }`, so a shared link shows exactly what passed the names check. Saving a shared report leaves its link unchanged until Refresh.
  - Catalog gap seen live: "by month" requests plot one point per decision because no dataset buckets by month. That is the first evidence for assumption 6, and a candidate dataset param.
