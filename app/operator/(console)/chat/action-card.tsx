"use client";

import Link from "next/link";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { Pencil } from "@/app/_components/signal/pencil";
import { Button } from "@/components/button";
import type { ActionPreview, ActionStatus } from "@/lib/signal/domain/assistant-action-contract";

import type { ProposeOutput } from "../_lib/assistant";

/**
 * An assistant proposal (spec 014 → UI, decision 0011): a ruled box with the preview, editable
 * fields, and one primary Confirm. Nothing changes until the PM confirms here; the card asks the
 * server (`GET …/actions/:id`) for the action's true state on mount.
 */

export type ProposalOutput = Extract<ProposeOutput, { actionId: string }>;

type Editable = ActionPreview["editable"][number];
type Values = Record<string, string>;

interface CardState {
  errorCode: string | null;
  /** A short line under the buttons (a refused confirm, a lost session). */
  message: string | null;
  operation: string;
  preview: ActionPreview;
  result: unknown;
  /** Confirm returned `needs_review`: the preview was replaced. */
  review: boolean;
  status: ActionStatus | "unknown";
}

interface StoredAction {
  errorCode?: string | null;
  input?: Record<string, unknown>;
  operation: string;
  preview: ActionPreview;
  result?: unknown;
  status: ActionStatus;
}

type ConfirmBody =
  | { result: unknown; status: "confirmed" }
  | { preview: ActionPreview; status: "needs_review" }
  | { status: "rejected" };

const SESSION_ENDED = "Your Operator session has ended. Sign in again on the access page.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `edit.statement` → input.edit.statement, as a string for the field. */
const valueAt = (input: Record<string, unknown> | undefined, key: string): string => {
  let current: unknown = input;
  for (const segment of key.split(".")) current = isRecord(current) ? current[segment] : undefined;
  return typeof current === "string" || typeof current === "number" ? String(current) : "";
};

const valuesOf = (editable: readonly Editable[], input: Record<string, unknown> | undefined) =>
  Object.fromEntries(editable.map(({ key }) => [key, valueAt(input, key)]));

/** Only the editable keys the PM changed, by their (possibly dotted) key. */
const editsOf = (editable: readonly Editable[], values: Values, original: Values) => {
  const edits: Record<string, unknown> = {};
  for (const field of editable) {
    const value = values[field.key] ?? "";
    if (value !== (original[field.key] ?? ""))
      edits[field.key] = field.kind === "number" ? Number(value) : value;
  }
  return edits;
};

const doneLabels: Record<string, string> = {
  merge_needs: "Merged",
  publish_decision: "Decision published",
  resolve_suggestion: "Suggestion resolved",
  save_report: "Report saved",
  set_criteria: "Criteria saved",
  set_strategy: "Strategy saved",
  share_report: "Report shared",
  split_need: "Need split",
  undo_merge: "Unmerged",
};

const roleLabels: Record<ActionPreview["needs"][number]["role"], string> = {
  source: "From",
  subject: "Need",
  target: "Into",
};

const closedLines: Partial<Record<CardState["status"], string>> = {
  expired:
    "This proposal expired before it was confirmed. Nothing changed. Ask again for a fresh one.",
  rejected: "Dismissed. Nothing changed.",
  unknown: "This proposal is no longer available.",
};

const errorOf = async (response: Response) => {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
  };
  return { code: body.error?.code, message: body.error?.message };
};

const refusedMessage = (code: string | undefined, message: string | undefined) => {
  if (code === "action_closed")
    return "This proposal is already being handled. Check again in a moment.";
  return message ?? "Something went wrong. Try again in a moment.";
};

/** The stored row; `null` when it could not be read (the stream's copy stays). */
type Loaded = StoredAction | "gone" | "signed_out" | null;

const fetchAction = async (url: string): Promise<Loaded> => {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (response.status === 404) return "gone";
    if (response.status === 401 || response.status === 403) return "signed_out";
    if (!response.ok) return null;
    const body = (await response.json()) as { action?: StoredAction };
    return body.action ?? null;
  } catch {
    return null;
  }
};

/** The card's state: the stream's copy first, then the stored row. */
const useAction = (output: ProposalOutput, input: Record<string, unknown> | undefined) => {
  const [state, setState] = useState<CardState>({
    errorCode: output.errorCode ?? null,
    message: null,
    operation: output.operation,
    preview: output.preview,
    result: output.result ?? null,
    review: false,
    status: output.status ?? "proposed",
  });
  // The tool call's input until the stored row arrives.
  const [original, setOriginal] = useState(() => valuesOf(output.preview.editable, input));
  const [values, setValues] = useState(original);
  /** The field values the shown preview was computed from; its blocks apply to these. */
  const [baseline, setBaseline] = useState(original);
  const url = `/api/operator/assistant/actions/${encodeURIComponent(output.actionId)}`;

  const patch = (next: Partial<CardState>) => setState((current) => ({ ...current, ...next }));

  const apply = (action: StoredAction, keepValues: boolean) => {
    patch({
      errorCode: action.errorCode ?? null,
      operation: action.operation,
      preview: action.preview,
      result: action.result ?? null,
      status: action.status,
    });
    if (keepValues) return;
    const initial = valuesOf(action.preview.editable, action.input);
    setOriginal(initial);
    setValues(initial);
    setBaseline(initial);
  };

  const applyLoaded = (loaded: Loaded, keepValues: boolean) => {
    if (loaded === "gone") patch({ status: "unknown" });
    else if (loaded === "signed_out") patch({ message: SESSION_ENDED });
    else if (loaded) apply(loaded, keepValues);
  };

  const load = async (keepValues: boolean) => applyLoaded(await fetchAction(url), keepValues);

  const onLoaded = useEffectEvent((loaded: Loaded) => applyLoaded(loaded, false));
  useEffect(() => {
    let live = true;
    const read = async () => {
      const loaded = await fetchAction(url);
      if (live) onLoaded(loaded);
    };
    void read();
    return () => {
      live = false;
    };
  }, [url]);

  const settle = (body: ConfirmBody) => {
    if (body.status === "needs_review") {
      patch({ preview: body.preview, review: true });
      setBaseline(values);
    } else if (body.status === "confirmed") patch({ result: body.result, status: "confirmed" });
    else patch({ status: "rejected" });
  };

  const post = async (decision: "confirm" | "reject") => {
    const edits = decision === "confirm" ? editsOf(state.preview.editable, values, original) : {};
    const response = await fetch(url, {
      body: JSON.stringify(
        Object.keys(edits).length > 0 ? { decision, input: edits } : { decision },
      ),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (response.ok) {
      settle((await response.json()) as ConfirmBody);
      return;
    }
    if (response.status === 401 || response.status === 403) {
      patch({ message: SESSION_ENDED });
      return;
    }
    const { code, message } = await errorOf(response);
    if (code === "validation_failed") {
      patch({ message: message ?? "Check the edited fields and try again." });
      return;
    }
    // Closed, failed, or gone: the stored row says which.
    await load(true);
    setState((current) =>
      current.status === "proposed"
        ? { ...current, message: refusedMessage(code, message) }
        : current,
    );
  };

  const edited = Object.keys(values).some((key) => values[key] !== baseline[key]);
  return { edited, patch, post, setValues, state, values };
};

export function ActionCard({
  busy,
  input,
  onSend,
  output,
}: {
  /** The chat is answering; links that send a message wait. */
  busy: boolean;
  /** The `propose_*` call's input, for the editable fields before the stored row loads. */
  input?: Record<string, unknown>;
  onSend: (text: string) => void;
  output: ProposalOutput;
}) {
  const { edited, patch, post, setValues, state, values } = useAction(output, input);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  const decide = async (decision: "confirm" | "reject") => {
    // A ref, not state: a double click sends one request.
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    patch({ message: null });
    try {
      await post(decision);
    } catch {
      patch({ message: "Couldn’t reach Signal. Check your connection and try again." });
    }
    inFlight.current = false;
    setPending(false);
  };

  const { preview, status } = state;
  const open = status === "proposed";

  return (
    <section
      aria-label={`Proposed: ${preview.title}`}
      className="border-border flex min-w-0 flex-col gap-4 rounded-md border p-4"
      data-action-status={status}
      data-testid="action-card"
    >
      <header className="flex flex-col gap-1">
        <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase">
          {open ? "Proposed · not applied yet" : "Proposal"}
        </p>
        <h3 className="font-serif text-lg leading-snug">{preview.title}</h3>
        {state.review && open ? (
          <output className="text-foreground text-[13px] font-medium">
            Changed since proposed · review again
          </output>
        ) : null}
      </header>

      <PreviewDetails preview={preview} />

      {open && preview.editable.length > 0 ? (
        <div className="flex flex-col gap-3">
          {preview.editable.map((field) => (
            <EditableField
              disabled={pending}
              field={field}
              key={field.key}
              onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
              value={values[field.key] ?? ""}
            />
          ))}
        </div>
      ) : null}

      {open ? <Blocks blocks={preview.blocks} edited={edited} /> : null}

      {preview.notes.length > 0 ? (
        <Pencil label="Notes" state="suggested">
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px] leading-snug">
            {preview.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </Pencil>
      ) : null}

      <Outcome busy={busy} onSend={onSend} state={state} />

      {open ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={(preview.blocks.length > 0 && !edited) || pending}
            onClick={() => {
              void decide("confirm");
            }}
            type="button"
          >
            {pending ? "Working…" : "Confirm"}
          </Button>
          <Button
            disabled={pending}
            onClick={() => {
              void decide("reject");
            }}
            type="button"
            variant="ghost"
          >
            Dismiss
          </Button>
        </div>
      ) : null}

      {state.message ? (
        <p className="text-destructive text-[13px]" role="alert">
          {state.message}
          {state.message === SESSION_ENDED ? (
            <>
              {" "}
              <Link className="underline underline-offset-4" href="/operator/access">
                Operator access
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}

function PreviewDetails({ preview }: { preview: ActionPreview }) {
  return (
    <>
      {preview.lines.length > 0 ? (
        <dl className="border-border m-0 flex flex-col border-t">
          {preview.lines.map((line) => (
            <div
              className="border-border flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b py-1.5"
              key={`${line.label}:${line.value}`}
            >
              <dt className="text-muted-foreground text-[13px]">{line.label}</dt>
              <dd className="m-0 min-w-0 font-mono text-[13px] break-words tabular-nums">
                {line.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {preview.needs.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {preview.needs.map((need) => (
            <li className="flex min-w-0 flex-col gap-0.5" key={`${need.role}:${need.id}`}>
              <span className="text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase">
                {roleLabels[need.role]}
              </span>
              <Link
                className="min-w-0 font-serif text-[15px] leading-snug underline-offset-4 hover:underline"
                href={`/operator/needs/${need.id}`}
              >
                {need.statement}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function Blocks({ blocks, edited }: { blocks: ActionPreview["blocks"]; edited: boolean }) {
  if (blocks.length === 0) return null;
  return (
    <ul className="text-destructive m-0 flex list-none flex-col gap-1.5 p-0 text-[13px]">
      {blocks.map((block) => (
        <li key={`${block.code}:${block.message}`}>
          {block.message}
          {block.flags && block.flags.length > 0 ? (
            <span className="font-mono">
              {" "}
              ({block.flags.map((flag) => `${flag.kind}: ${flag.match}`).join(", ")})
            </span>
          ) : null}
        </li>
      ))}
      {edited ? <li className="text-muted-foreground">Confirm checks your edit again.</li> : null}
    </ul>
  );
}

function Done({
  busy,
  onSend,
  state,
}: {
  busy: boolean;
  onSend: (text: string) => void;
  state: CardState;
}) {
  const reportId = isRecord(state.result) ? state.result.reportId : undefined;
  return (
    <Pencil label="Done" state="accepted">
      <p className="m-0 flex flex-wrap items-baseline gap-x-3 text-[14px]">
        <span>{doneLabels[state.operation] ?? "Applied"}.</span>
        {state.operation === "save_report" && typeof reportId === "string" ? (
          <Link
            className="underline underline-offset-4"
            href={`/operator/reports/${encodeURIComponent(reportId)}`}
          >
            Open report
          </Link>
        ) : null}
        {state.operation === "merge_needs" ? (
          <button
            className="text-foreground decoration-input font-medium underline underline-offset-4 disabled:opacity-50"
            disabled={busy}
            onClick={() => onSend("Undo that merge")}
            type="button"
          >
            Undo
          </button>
        ) : null}
      </p>
    </Pencil>
  );
}

function Outcome({
  busy,
  onSend,
  state,
}: {
  busy: boolean;
  onSend: (text: string) => void;
  state: CardState;
}) {
  if (state.status === "confirmed") return <Done busy={busy} onSend={onSend} state={state} />;
  if (state.status === "failed")
    return (
      <p className="text-destructive text-[13px]">
        This change failed{state.errorCode ? ` (${state.errorCode})` : ""}. Ask again to retry.
      </p>
    );
  const line = closedLines[state.status];
  return line ? <p className="text-muted-foreground text-[13px]">{line}</p> : null;
}

const fieldClass =
  "border-input focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-lg border bg-transparent px-3 text-sm outline-none focus-visible:ring-3 disabled:opacity-50";

function FieldControl({
  disabled,
  field,
  onChange,
  value,
}: {
  disabled: boolean;
  field: Editable;
  onChange: (value: string) => void;
  value: string;
}) {
  if (field.kind === "longtext")
    return (
      <textarea
        className={`${fieldClass} min-h-20 py-2 leading-relaxed`}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
    );
  if (field.kind === "select") {
    const options = field.options ?? [];
    return (
      <select
        className={`${fieldClass} h-9`}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {value && !options.includes(value) ? <option value={value}>{value}</option> : null}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (field.kind === "number")
    return (
      <input
        className={`${fieldClass} h-9 font-mono tabular-nums`}
        disabled={disabled}
        inputMode="decimal"
        onChange={(event) => onChange(event.target.value)}
        step="any"
        type="number"
        value={value}
      />
    );
  return (
    <input
      className={`${fieldClass} h-9`}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      type="text"
      value={value}
    />
  );
}

function EditableField(props: {
  disabled: boolean;
  field: Editable;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-muted-foreground text-[13px]">{props.field.label}</span>
      <FieldControl {...props} />
    </label>
  );
}
