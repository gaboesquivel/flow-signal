import { cn } from "cn";
import type { ReactNode } from "react";

import { ConsoleHeading } from "../_components/console-bits";
import type { Acceptance, Metrics, WindowDays } from "../_lib/metrics-view";
import {
  acceptanceRows,
  formatDays,
  formatHours,
  formatRate,
  formatWindow,
  plural,
  resolvedCount,
  verdictLabels,
} from "../_lib/metrics-view";
import { WindowToggle } from "./window-toggle";

const label = "text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase";
const quiet = "text-muted-foreground";

const metricNames: Record<string, string> = { close_the_loop_rate: "Close-the-loop rate" };

/** The MVP metrics as large mono numbers with one-line definitions (DESIGN.md → Metrics). */
export function MetricsView({ days, metrics }: { days: WindowDays; metrics: Metrics }) {
  const {
    assistantActions,
    decisionLatency,
    exposure,
    killCriterion,
    preventionRate,
    reportReuse,
    suggestionAcceptance,
    supporting,
  } = metrics;
  const shown = exposure.submissions;
  const kill = killCriterion.populations;
  const prevention = preventionRate.overall;
  const preventionTotal = (side: (typeof prevention)["all"]) =>
    side.attachedToExisting + side.mergedDrafts;
  const latency = decisionLatency.decided;
  const acceptance = suggestionAcceptance.overall;
  const kinds = acceptanceRows(suggestionAcceptance.byKind);
  const reportsSaved = reportReuse.human.saved + reportReuse.agent.saved;
  const reportsReused = reportReuse.human.reused + reportReuse.agent.reused;

  return (
    <div className="flex flex-col gap-8" data-window={days}>
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <ConsoleHeading title="Metrics">
          <span data-testid="metrics-window">
            {formatWindow(metrics.window)} · last {days} days
          </span>{" "}
          · from Signal’s event log · people and agents counted apart
        </ConsoleHeading>
        <WindowToggle days={days} />
      </div>

      <section aria-labelledby="mvp-heading" className="flex flex-col gap-3">
        <h2 className={label} id="mvp-heading">
          MVP metrics
        </h2>
        <ol className="border-rule-strong m-0 list-none border-t p-0">
          <Metric
            baseline={
              <>
                Baseline <b className="font-medium">unknown</b> · target{" "}
                <b className="font-medium">≥ 50%</b>, a hypothesis
              </>
            }
            definition="Signals that joined an existing need when submitted, out of those plus signals whose new draft need was later merged."
            name="Prevention rate"
            value={
              <BigNumber
                detail={`${prevention.all.attachedToExisting} of ${plural(preventionTotal(prevention.all), "signal")}`}
                testId="prevention-rate"
                value={formatRate(prevention.all.rate)}
              />
            }
            split={{
              agents: rateLine(
                prevention.agent.rate,
                prevention.agent.attachedToExisting,
                preventionTotal(prevention.agent),
                "none in window",
              ),
              people: rateLine(
                prevention.human.rate,
                prevention.human.attachedToExisting,
                preventionTotal(prevention.human),
                "none in window",
              ),
            }}
          />
          <Metric
            baseline={
              <>
                Baseline <b className="font-medium">unknown</b> (seeded history only) · target{" "}
                <b className="font-medium">half the baseline</b>, a hypothesis
              </>
            }
            definition="Median days from a need’s first signal to its first published decision."
            name="Decision latency"
            value={
              <BigNumber
                detail={
                  <>
                    median of {plural(latency.all.decisions, "decision")}
                    <br />
                    {plural(decisionLatency.openPast30Days.needs, "need")} undecided past 30 days
                    {decisionLatency.openPast30Days.medianAgeDays === null
                      ? ""
                      : `, median age ${formatDays(decisionLatency.openPast30Days.medianAgeDays)}`}
                  </>
                }
                testId="decision-latency"
                unit={latency.all.medianDays === null ? undefined : "days"}
                value={
                  latency.all.medianDays === null
                    ? "—"
                    : String(Math.round(latency.all.medianDays * 10) / 10)
                }
              />
            }
            split={{
              agents: latencyLine(latency.agent),
              people: latencyLine(latency.human),
            }}
          />
          <Metric
            baseline={
              <>
                Baseline <b className="font-medium">unknown</b> · target{" "}
                <b className="font-medium">≥ 70%</b> as-is, a hypothesis. High acceptance with
                rising unmerges means rubber-stamping.
              </>
            }
            definition="AI suggestions accepted as-is, out of all accepted, edited, and rejected."
            extra={kinds.length > 0 ? <KindTable rows={kinds} /> : null}
            name="Suggestion acceptance"
            value={
              <BigNumber
                detail={`${acceptance.all.accepted} as-is · ${acceptance.all.edited} edited · ${acceptance.all.rejected} rejected`}
                testId="suggestion-acceptance"
                value={formatRate(acceptance.all.acceptanceRate)}
              />
            }
            split={{
              agents: acceptanceLine(acceptance.agent),
              people: acceptanceLine(acceptance.human),
            }}
          />
        </ol>
      </section>

      <section aria-labelledby="exposure-heading" className="flex flex-col gap-3">
        <h2 className={label} id="exposure-heading">
          Match exposure
        </h2>
        <ol className="border-rule-strong m-0 list-none border-t p-0">
          <Metric
            baseline={
              <>
                Riskiest assumption 1 · baseline <b className="font-medium">unknown</b>
              </>
            }
            definition="Submissions shown at least one matching need that joined one of them."
            extra={
              <ExposureBreakdown
                counts={shown.all}
                previews={exposure.previewsWithoutSubmission.all}
              />
            }
            name="Match take-up"
            value={
              <BigNumber
                detail={`${shown.all.taken} of ${plural(shown.all.shown, "submission")} shown a match`}
                testId="match-take-up"
                value={formatRate(shown.all.takeUpRate)}
              />
            }
            split={{
              agents: rateLine(
                shown.agent.takeUpRate,
                shown.agent.taken,
                shown.agent.shown,
                "none shown",
              ),
              people: rateLine(
                shown.human.takeUpRate,
                shown.human.taken,
                shown.human.shown,
                "none shown",
              ),
            }}
          />
          <Metric
            baseline={
              <>
                Kill when prevention is under{" "}
                <b className="font-medium">{formatRate(killCriterion.minPreventionRate)}</b> or
                unmerges exceed{" "}
                <b className="font-medium">{formatRate(killCriterion.maxUnmergeRate)}</b> · all
                time, not just this window
              </>
            }
            definition={`Real-user kill criterion: needs ${killCriterion.minShownSubmissions} submissions that were shown a match.`}
            name="Kill criterion"
            value={
              <BigNumber
                detail={`${verdictLabels[kill.all.verdict]} · prevention ${formatRate(kill.all.preventionRate.rate)} · unmerges ${formatRate(killCriterion.unmergeRate.rate)}`}
                testId="kill-criterion"
                value={`${kill.all.shownSubmissions} / ${killCriterion.minShownSubmissions}`}
              />
            }
            split={{
              agents: `${kill.agent.shownSubmissions} · ${verdictLabels[kill.agent.verdict]}`,
              people: `${kill.human.shownSubmissions} · ${verdictLabels[kill.human.verdict]}`,
            }}
          />
        </ol>
      </section>

      <section aria-labelledby="reports-heading" className="flex flex-col gap-3">
        <h2 className={label} id="reports-heading">
          Reports
        </h2>
        <ol className="border-rule-strong m-0 list-none border-t p-0">
          <Metric
            baseline={
              <>
                Diagnostic · baseline <b className="font-medium">unknown</b> · target{" "}
                <b className="font-medium">≥ 40%</b> (hypothesis)
              </>
            }
            definition="Reports first saved in the window that were opened, shared, or saved again within 14 days."
            name="Report reuse"
            value={
              <BigNumber
                detail={`${reportsReused} of ${plural(reportsSaved, "report")} reused`}
                testId="report-reuse"
                value={formatRate(reportsSaved === 0 ? null : reportsReused / reportsSaved)}
              />
            }
            split={{
              agents: rateLine(
                reportReuse.agent.rate,
                reportReuse.agent.reused,
                reportReuse.agent.saved,
                "none saved",
              ),
              people: rateLine(
                reportReuse.human.rate,
                reportReuse.human.reused,
                reportReuse.human.saved,
                "none saved",
              ),
            }}
          />
        </ol>
      </section>

      <section aria-labelledby="assistant-heading" className="flex flex-col gap-3">
        <h2 className={label} id="assistant-heading">
          Assistant
        </h2>
        <ol className="border-rule-strong m-0 list-none border-t p-0">
          <Metric
            baseline={
              <>
                Diagnostic · baseline <b className="font-medium">unknown</b> · no target yet
                (experimental)
              </>
            }
            definition="People’s writes in the window confirmed through the Operator assistant, of all their writes. Agent writes are left out."
            name="Assistant action share"
            unsplit={
              <p
                className={cn(quiet, "font-mono text-[13px] tabular-nums")}
                data-testid="assistant-outcomes"
              >
                {assistantActions.proposed === 0
                  ? "none proposed"
                  : `${plural(assistantActions.proposed, "proposal")} · ${assistantActions.confirmedUnchanged} confirmed as is, ${assistantActions.confirmedEdited} edited, ${assistantActions.rejected} dismissed, ${assistantActions.expired} expired`}
              </p>
            }
            value={
              <BigNumber
                detail={
                  assistantActions.writes.human === 0
                    ? "no writes in window"
                    : `${assistantActions.writes.assistant} of ${plural(assistantActions.writes.human, "write")} via the assistant`
                }
                testId="assistant-share"
                value={formatRate(assistantActions.share)}
              />
            }
          />
        </ol>
      </section>

      <section aria-labelledby="guardrails-heading" className="flex flex-col gap-3">
        <h2 className={label} id="guardrails-heading">
          Guardrails
        </h2>
        <ol className="border-rule-strong m-0 list-none border-t p-0">
          <Metric
            baseline={
              <>
                Target <b className="font-medium">&lt; 5%</b> · kill signal above{" "}
                <b className="font-medium">10%</b>
              </>
            }
            definition="Merges in the window that were later undone."
            name="Unmerge rate"
            value={
              <BigNumber
                detail={
                  supporting.unmergeRate.merges === 0
                    ? "no merges in window"
                    : `${supporting.unmergeRate.undone} of ${plural(supporting.unmergeRate.merges, "merge")} undone`
                }
                testId="unmerge-rate"
                value={formatRate(supporting.unmergeRate.rate)}
              />
            }
          />
        </ol>
      </section>

      <section aria-labelledby="supporting-heading" className="flex flex-col gap-3">
        <h2 className={label} id="supporting-heading">
          Supporting
        </h2>
        <dl className="border-rule-strong m-0 grid gap-x-8 gap-y-5 border-t pt-4 sm:grid-cols-3">
          <Supporting
            detail={`Signals with the person’s own use case · people ${formatRate(supporting.contextRate.human.rate)}, agents ${formatRate(supporting.contextRate.agent.rate)}`}
            name="Context rate"
            value={formatRate(supporting.contextRate.all.rate)}
          />
          <Supporting
            detail={`Median from suggestion to first resolution · ${supporting.timeToTriage.resolved} resolved`}
            name="Time to triage"
            value={formatHours(supporting.timeToTriage.medianHours)}
          />
          <Supporting
            detail={`${plural(supporting.reviewLoad.created, "suggestion")} created, ${supporting.reviewLoad.resolved} resolved in the window`}
            name="Review load"
            value={`${supporting.reviewLoad.pendingAtEnd} pending`}
          />
        </dl>
        {metrics.unsupported.length > 0 ? (
          <p className={cn(quiet, "text-[13px]")}>
            Not computed yet:{" "}
            {metrics.unsupported
              .map((entry) => `${metricNames[entry.metric] ?? entry.metric}. ${entry.reason}`)
              .join(" ")}
          </p>
        ) : null}
      </section>
    </div>
  );
}

function rateLine(rate: number | null, count: number, total: number, none: string) {
  return total === 0 ? (
    <span className={quiet}>{none}</span>
  ) : (
    `${formatRate(rate)} · ${count} of ${total}`
  );
}

function latencyLine(side: { decisions: number; medianDays: number | null }) {
  return side.decisions === 0 ? (
    <span className={quiet}>no decisions</span>
  ) : (
    `${formatDays(side.medianDays)} · ${plural(side.decisions, "decision")}`
  );
}

function acceptanceLine(side: Acceptance) {
  const total = resolvedCount(side);
  return total === 0 ? (
    <span className={quiet}>none resolved</span>
  ) : (
    `${formatRate(side.acceptanceRate)} · ${side.accepted} of ${total}`
  );
}

function BigNumber({
  detail,
  testId,
  unit,
  value,
}: {
  detail: ReactNode;
  testId: string;
  unit?: string;
  value: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span
        className={cn(
          "font-mono text-4xl leading-none font-medium tracking-tight tabular-nums sm:text-5xl",
          value === "—" && "text-muted-foreground",
        )}
        data-testid={testId}
      >
        {value}
        {unit ? (
          <small className="text-muted-foreground ml-1.5 text-base font-normal">{unit}</small>
        ) : null}
      </span>
      <span className={cn(quiet, "font-mono text-xs tabular-nums")}>{detail}</span>
    </div>
  );
}

function Metric({
  baseline,
  definition,
  extra,
  name,
  split,
  unsplit,
  value,
}: {
  baseline: ReactNode;
  definition: string;
  extra?: ReactNode;
  name: string;
  split?: { agents: ReactNode; people: ReactNode };
  /** Shown instead of the people/agents split when there is none. */
  unsplit?: ReactNode;
  value: ReactNode;
}) {
  return (
    <li className="border-border grid min-w-0 gap-x-10 gap-y-4 border-b py-6 md:grid-cols-[minmax(0,1.1fr)_minmax(0,0.8fr)_minmax(0,1.2fr)]">
      <div className="min-w-0">
        <h3 className="font-serif text-xl font-medium">{name}</h3>
        <p className="mt-1 text-sm">{definition}</p>
        <p className={cn(quiet, "mt-2 text-[13px]")}>{baseline}</p>
      </div>
      {value}
      <div className="flex min-w-0 flex-col gap-4">
        {split ? (
          <dl className="m-0 grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
            <dt className={quiet}>People</dt>
            <dd className="m-0 font-mono tabular-nums" data-testid="split-people">
              {split.people}
            </dd>
            <dt className={quiet}>Agents</dt>
            <dd className="m-0 font-mono tabular-nums" data-testid="split-agents">
              {split.agents}
            </dd>
          </dl>
        ) : (
          (unsplit ?? (
            <p className={cn(quiet, "text-[13px]")}>Merges are not split by who made them.</p>
          ))
        )}
        {extra}
      </div>
    </li>
  );
}

function ExposureBreakdown({
  counts,
  previews,
}: {
  counts: Metrics["exposure"]["submissions"]["all"];
  previews: number;
}) {
  const filed = counts.filedNewDespiteMatch;
  const rows: [string, string][] = [
    [
      "Picked rank 1 / 2 / 3",
      `${counts.chosenRank[1]} / ${counts.chosenRank[2]} / ${counts.chosenRank[3]}`,
    ],
    [
      "Filed new anyway",
      `${filed.total} · ${filed.mergedIntoShown} later merged into a shown need, ${filed.mergedElsewhere} elsewhere, ${filed.unmerged} not merged`,
    ],
    [
      "Split off a taken match",
      `${counts.movedOffTakenMatch.moved} · ${formatRate(counts.movedOffTakenMatch.rate)}`,
    ],
    ["No match shown", String(counts.noneShown)],
    ["Skipped the check", String(counts.skipped)],
    ["Unknown preview", String(counts.unknown)],
    ["Previews never submitted", String(previews)],
  ];
  return (
    <dl
      className="m-0 grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]"
      data-testid="exposure-breakdown"
    >
      {rows.map(([name, value]) => (
        <div className="contents" key={name}>
          <dt className={quiet}>{name}</dt>
          <dd className="m-0 font-mono tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function KindTable({ rows }: { rows: ReturnType<typeof acceptanceRows> }) {
  const cell = "py-1 pl-3 text-right font-mono tabular-nums";
  const head = "py-1 pl-3 text-right font-medium whitespace-nowrap";
  return (
    <table className="w-full border-collapse text-[13px]">
      <caption className="sr-only">Suggestion acceptance by kind</caption>
      <thead>
        <tr className={cn(quiet, "border-border border-b text-xs")}>
          <th className="py-1 text-left font-medium" scope="col">
            Kind
          </th>
          <th className={head} scope="col">
            As-is
          </th>
          <th className={head} scope="col">
            Edited
          </th>
          <th className={head} scope="col">
            Rejected
          </th>
          <th className={head} scope="col">
            By agents
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr className="border-border border-b last:border-b-0" key={row.kind}>
            <th className="py-1 text-left font-normal" scope="row">
              {row.label}
            </th>
            <td className={cell}>{row.all.accepted}</td>
            <td className={cell}>{row.all.edited}</td>
            <td className={cell}>{row.all.rejected}</td>
            <td className={cn(cell, quiet)}>{resolvedCount(row.agent)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Supporting({ detail, name, value }: { detail: string; name: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className={label}>{name}</dt>
      <dd className="m-0 font-mono text-2xl tabular-nums">{value}</dd>
      <dd className={cn(quiet, "m-0 text-[13px]")}>{detail}</dd>
    </div>
  );
}
