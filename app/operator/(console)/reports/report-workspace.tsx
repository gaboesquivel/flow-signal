"use client";

import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { Button } from "@/components/button";
import { LoadingLine } from "@/components/loading-line";
import { ReportView } from "@/components/report/report-view";
import type { SignalClientError } from "@/lib/signal/client";

import { ConsoleError } from "../_components/console-bits";
import { browserSignal } from "../_components/operator-browser";
import type { ReportDataValue, ReportSpecValue, SavedReport } from "../_lib/reports";
import { ReportPrompt } from "./report-prompt";
import { SharePanel } from "./share-panel";
import type { ShareAction, ShareFlags } from "./share-panel";

interface Shown {
  asOf: string;
  data: ReportDataValue;
  spec: ReportSpecValue;
  warnings: string[];
}

type Busy = "generate" | "refresh" | "save" | "share" | null;

const busyText: Record<Exclude<Busy, null>, string> = {
  generate: "Reading the data and laying out the report…",
  refresh: "Re-running the report on fresh data…",
  save: "Saving…",
  share: "Checking the report for names, accounts, and emails…",
};

/**
 * One report: generate from a prompt (`?q=`) or open a saved one, refine in plain words, Save
 * (the one primary action), Refresh, and Share a read-only snapshot (spec 013).
 */
export function ReportWorkspace({
  initialPrompt,
  saved,
}: {
  initialPrompt?: string;
  saved?: SavedReport;
}) {
  const router = useRouter();
  const [shown, setShown] = useState<Shown | null>(
    saved ? { asOf: saved.asOf, data: saved.data, spec: saved.spec, warnings: [] } : null,
  );
  const [title, setTitle] = useState(saved?.title ?? "");
  const [prompts, setPrompts] = useState<string[]>(saved ? [saved.prompt] : []);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<Pick<SignalClientError, "code" | "message"> | null>(null);
  const [refine, setRefine] = useState("");
  const [share, setShare] = useState(saved?.share ?? null);
  const [shareOpen, setShareOpen] = useState(false);
  const [flags, setFlags] = useState<ShareFlags | null>(null);
  const started = useRef(false);
  const refineRef = useRef<HTMLInputElement>(null);
  const reportId = saved?.reportId ?? null;

  const generate = async (prompt: string, prior: ReportSpecValue | null) => {
    setBusy("generate");
    setError(null);
    const result = await browserSignal.generateReport(prior ? { prior, prompt } : { prompt });
    setBusy(null);
    if (!result.ok) return setError(result.error);
    setShown({
      asOf: result.data.asOf,
      data: result.data.data,
      spec: result.data.report,
      warnings: result.data.warnings,
    });
    setPrompts((current) => [...current, prompt]);
    setTitle((current) => (current && prior ? current : result.data.report.title));
    setDirty(true);
    setRefine("");
    refineRef.current?.focus();
  };

  const start = useEffectEvent(() => {
    if (started.current || saved || !initialPrompt) return;
    started.current = true;
    void generate(initialPrompt, null);
  });
  useEffect(() => start(), []);

  const save = async () => {
    if (!shown) return;
    setBusy("save");
    setError(null);
    const result = await browserSignal.saveReport({
      idempotencyKey: crypto.randomUUID(),
      prompt: prompts.join("\n"),
      spec: { ...shown.spec, title: title.trim() || shown.spec.title },
      title: title.trim() || shown.spec.title,
      ...(reportId ? { reportId } : {}),
    });
    setBusy(null);
    if (!result.ok) return setError(result.error);
    setDirty(false);
    // Land with `?saved=1` so the reload after a save is not counted as reuse.
    if (reportId) router.refresh();
    else router.replace(`/operator/reports/${result.data.reportId}?saved=1`);
  };

  const refresh = async () => {
    if (!reportId) return;
    setBusy("refresh");
    setError(null);
    const result = await browserSignal.getReport({ reportId });
    setBusy(null);
    if (!result.ok) return setError(result.error);
    setShown({
      asOf: result.data.asOf,
      data: result.data.data,
      spec: result.data.spec,
      warnings: [],
    });
    setShare(result.data.share);
    setDirty(false);
  };

  const shareAction = async (action: ShareAction, acknowledgeFlags = false) => {
    if (!reportId) return;
    setBusy("share");
    setError(null);
    const result = await browserSignal.shareReport({ acknowledgeFlags, action, reportId });
    setBusy(null);
    if (!result.ok) return setError(result.error);
    if (result.data.status === "needs_acknowledgement") return setFlags(result.data.flags);
    setFlags(null);
    if (result.data.status === "revoked") return setShare(null);
    setShare({
      path: result.data.path,
      sharedAt: share?.sharedAt ?? result.data.snapshotAt,
      snapshotAt: result.data.snapshotAt,
    });
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8">
      <ReportHeader
        heading={initialPrompt ?? "Report"}
        onTitle={(value) => {
          setTitle(value);
          setDirty(true);
        }}
        saved={reportId !== null}
        title={shown ? title : null}
      />

      {shown ? (
        <ReportActions
          busy={busy !== null}
          dirty={dirty}
          onRefresh={refresh}
          onSave={save}
          onToggleShare={() => setShareOpen((open) => !open)}
          saved={reportId !== null}
          shareOpen={shareOpen}
        />
      ) : null}

      {shareOpen && reportId ? (
        <SharePanel
          busy={busy !== null}
          flags={flags}
          onAction={(action, acknowledgeFlags) => {
            void shareAction(action, acknowledgeFlags);
          }}
          onDismissFlags={() => setFlags(null)}
          share={share}
        />
      ) : null}

      {error ? <ConsoleError error={error} /> : null}
      {busy ? <LoadingLine>{busyText[busy]}</LoadingLine> : null}

      {shown ? (
        <ReportView
          asOf={shown.asOf}
          data={shown.data}
          showTitle={false}
          spec={shown.spec}
          warnings={shown.warnings}
        />
      ) : null}

      {shown || error ? (
        <div className="border-border flex flex-col gap-2 border-t pt-6">
          <p className={eyebrow}>{shown ? "Refine" : "Try again"}</p>
          <ReportPrompt
            busy={busy !== null}
            inputRef={refineRef}
            label="Refine the report"
            onChange={setRefine}
            onSubmit={() => generate(refine.trim(), shown?.spec ?? null)}
            placeholder="e.g. make it weekly, only Growth accounts, add a table of accounts"
            submitLabel="Update"
            value={refine}
          />
        </div>
      ) : null}
    </div>
  );
}

const eyebrow = "text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase";

/** "New report" or "Saved report", then the editable title once there is a report. */
function ReportHeader({
  heading,
  onTitle,
  saved,
  title,
}: {
  heading: string;
  onTitle: (value: string) => void;
  saved: boolean;
  title: string | null;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className={eyebrow}>{saved ? "Saved report" : "New report"}</p>
      {title === null ? (
        <h1 className="font-serif text-3xl font-medium tracking-tight sm:text-4xl">{heading}</h1>
      ) : (
        <label className="min-w-0">
          <span className="sr-only">Report title</span>
          {/* A textarea that sizes to its content, so long titles wrap on narrow screens. */}
          <textarea
            className="field-sizing-content w-full resize-none border-0 bg-transparent p-0 font-serif text-3xl font-medium tracking-tight outline-none focus-visible:underline sm:text-4xl"
            maxLength={120}
            onChange={(event) => onTitle(event.target.value.replaceAll("\n", " "))}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
            rows={1}
            value={title}
          />
        </label>
      )}
    </div>
  );
}

/** Save is the one primary action; Refresh and Share appear once the report is saved. */
function ReportActions({
  busy,
  dirty,
  onRefresh,
  onSave,
  onToggleShare,
  saved,
  shareOpen,
}: {
  busy: boolean;
  dirty: boolean;
  onRefresh: () => void;
  onSave: () => void;
  onToggleShare: () => void;
  saved: boolean;
  shareOpen: boolean;
}) {
  let label = "Save";
  if (saved) label = dirty ? "Save changes" : "Saved";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button disabled={busy || (saved && !dirty)} onClick={onSave}>
        {label}
      </Button>
      {saved ? (
        <>
          <Button disabled={busy} onClick={onRefresh} variant="outline">
            Refresh
          </Button>
          <Button
            aria-expanded={shareOpen}
            disabled={busy}
            onClick={onToggleShare}
            variant="outline"
          >
            Share
          </Button>
        </>
      ) : (
        <span className="text-muted-foreground text-sm">Save to refresh or share it.</span>
      )}
    </div>
  );
}
