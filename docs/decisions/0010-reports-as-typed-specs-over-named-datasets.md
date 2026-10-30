# 0010 — PM reports are typed specs over named datasets

Status: Proposed (2026-10-30)

## Context

PM Reports ([spec 013](../specs/013-pm-reports.md)) lets a PM describe any report in plain words and get charts and tables back. Every figure must trace to Signal's own records, saved reports must re-run on fresh data, and agents must be able to generate and re-run them over Operator MCP. The existing GenUI stack (`lib/genui`, OpenUI Lang) composes from fixture records, and its prompt lets the model invent synthetic rows. Whatever format is chosen gets stored in saved reports, so changing it later means migrating them.

## Options

1. **Extend OpenUI Lang:** add Chart, Table, and KPI components to the GenUI library, and have the model write OpenUI text plus records.
2. **Typed JSON report spec over named datasets:** the model picks dataset queries from a fixed catalog and lays out blocks (heading, text, KPI, chart, table) that reference dataset columns. The server runs the queries. The model never writes a number, only references to columns.
3. **Model-written chart code or SQL:** most flexible. Not checkable, unsafe to run, and impossible to re-run deterministically.

## Decision

Option 2, as proposed in spec 013.

- The spec is a zod schema (`lib/signal/domain/report-spec.ts`). It is validated on generate, save, and read.
- Data comes only from `get_report_dataset` queries, which run on the server. Saving re-runs them, so client-sent rows are never stored.
- Re-running a saved report replays its dataset queries with no model call.
- Text blocks are checked for traceability: any number in prose must appear in the report's data.

## Consequences

- "Any report" is bounded by the dataset catalog. A request outside it gets the closest report plus a warning naming the gap (riskiest assumption 6 in PRODUCT.md). Each new dataset widens the reports PMs can make.
- Rendering is ordinary React (Recharts through the shadcn chart wrapper), themed by DESIGN.md tokens, and not tied to the OpenUI runtime.
- `lib/genui` stays as it is for the public `compose_ui` MCP tool and the MCP app. Reports do not depend on it.
