"use client";

import { InfoIcon, SplitIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/alert";
import { Button } from "@/components/button";
import { Input } from "@/components/input";
import { Label } from "@/components/label";
import { NativeSelect, NativeSelectOption } from "@/components/native-select";
import { Spinner } from "@/components/spinner";
import { Textarea } from "@/components/textarea";
import type { SignalClientError } from "@/lib/signal/client";

import { SignalErrorAlert } from "../_components/signal/error-alert";
import { MatchOption, NoneOfTheseOption } from "./match-option";
import { signalClient, usePreview } from "./use-preview";
import type { PreviewState } from "./use-preview";
import {
  MIN_NEW_NEED_STATEMENT,
  attemptFingerprint,
  needOptions,
  newIdempotencyKey,
  splitTitle,
  toSubmitInput,
  trackingLinkFor,
} from "./submit-model";
import type { ChosenNeed, Choice, PreviewOutput, SubmitFields } from "./submit-model";
import { SubmitSuccess } from "./submit-success";
import type { SubmitResult } from "./submit-success";

const emptyFields: SubmitFields = {
  body: "",
  company: "",
  email: "",
  name: "",
  newStatement: "",
  title: "",
  urgency: "",
  useCase: "",
};

type FieldChange = (
  name: keyof SubmitFields,
) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => void;

function RequestFields({ fields, set }: { fields: SubmitFields; set: FieldChange }) {
  return (
    <fieldset className="flex flex-col gap-4">
      <legend className="mb-3 text-base font-medium">1. What do you need?</legend>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="title">Title</Label>
        <Input
          autoComplete="off"
          id="title"
          maxLength={200}
          name="title"
          onChange={set("title")}
          placeholder="e.g. Export dashboards to PDF"
          required
          value={fields.title}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="body">Details</Label>
        <Textarea
          aria-describedby="body-help"
          id="body"
          maxLength={5000}
          name="body"
          onChange={set("body")}
          placeholder="What are you trying to do, and what gets in the way?"
          required
          rows={4}
          value={fields.body}
        />
        <p className="text-muted-foreground text-xs" id="body-help">
          Your words are kept exactly as you write them and shown only to you and the product team.
        </p>
      </div>
    </fieldset>
  );
}

const previewStatusText = (preview: PreviewState, data: PreviewOutput | undefined) => {
  if (preview.status === "idle") return "Start with a title and we'll look for needs like yours.";
  if (preview.status !== "ready" || data?.ai !== "ok") return;
  const count = data.matches.length;
  if (count === 0) return "No existing need matches yet. Your request will start a new one.";
  return `${count} similar ${count === 1 ? "need" : "needs"} found. Add your voice to one, or choose “None of these”.`;
};

function PreviewNotices({
  data,
  preview,
}: {
  data: PreviewOutput | undefined;
  preview: PreviewState;
}) {
  const asks = data?.draftNeed.additionalAsks ?? [];
  return (
    <>
      <p aria-live="polite" className="text-muted-foreground text-sm" id="matches-status">
        {preview.status === "loading" ? (
          <span className="inline-flex items-center gap-2">
            <Spinner aria-hidden /> Looking for similar needs…
          </span>
        ) : (
          previewStatusText(preview, data)
        )}
      </p>
      {data?.ai === "unavailable" ? (
        <Alert>
          <InfoIcon aria-hidden />
          <AlertTitle>Suggestions are unavailable right now</AlertTitle>
          <AlertDescription>
            We can&apos;t check for similar needs at the moment. You can still submit: your request
            starts a new need, and a product manager groups duplicates later.
          </AlertDescription>
        </Alert>
      ) : null}
      {preview.status === "error" ? <SignalErrorAlert error={preview.error} /> : null}
      {asks.length > 0 ? (
        <Alert>
          <SplitIcon aria-hidden />
          <AlertTitle>This looks like more than one request</AlertTitle>
          <AlertDescription>
            <p>
              We&apos;ll file the main request now and offer to file the rest separately after you
              submit, so each counts where it belongs:
            </p>
            <ul className="mt-1 list-disc pl-5">
              {asks.map((ask) => (
                <li key={ask}>{ask}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

function NewNeedStatement({
  drafted,
  onChange,
  value,
}: {
  drafted: boolean;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="new-statement">The need, in one sentence</Label>
      <Textarea
        aria-describedby="new-statement-help"
        id="new-statement"
        maxLength={500}
        minLength={MIN_NEW_NEED_STATEMENT}
        onChange={(event) => onChange(event.target.value)}
        required
        rows={2}
        value={value}
      />
      <p className="text-muted-foreground text-xs" id="new-statement-help">
        {drafted
          ? "We drafted this from your words; edit it if it misses the point."
          : "Who needs to do what, so that what happens? At least 10 characters."}
      </p>
    </div>
  );
}

function ContextFields({ fields, set }: { fields: SubmitFields; set: FieldChange }) {
  return (
    <fieldset className="flex flex-col gap-4">
      <legend className="mb-3 text-base font-medium">3. Your context</legend>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="use-case">Use case (optional)</Label>
        <Input
          id="use-case"
          maxLength={2000}
          onChange={set("useCase")}
          placeholder="e.g. monthly board deck"
          value={fields.useCase}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="urgency">Urgency (optional)</Label>
        <NativeSelect id="urgency" onChange={set("urgency")} value={fields.urgency}>
          <NativeSelectOption value="">Not sure</NativeSelectOption>
          <NativeSelectOption value="low">Low</NativeSelectOption>
          <NativeSelectOption value="medium">Medium</NativeSelectOption>
          <NativeSelectOption value="high">High</NativeSelectOption>
        </NativeSelect>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            autoComplete="email"
            id="email"
            maxLength={254}
            onChange={set("email")}
            required
            type="email"
            value={fields.email}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="name">Name (optional)</Label>
          <Input
            autoComplete="name"
            id="name"
            maxLength={120}
            onChange={set("name")}
            value={fields.name}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="company">Company (optional)</Label>
          <Input
            autoComplete="organization"
            id="company"
            maxLength={120}
            onChange={set("company")}
            value={fields.company}
          />
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        Only the product team sees your email, name, and company. They never appear on the board.
      </p>
    </fieldset>
  );
}

const submitErrorText = (error: SignalClientError) => {
  if (error.code === "validation_failed") return `Please check the form: ${error.message}`;
  if (error.code === "not_found")
    return "That need no longer exists. Pick another match or choose “None of these”.";
  if (error.code === "conflict") return "This request changed while sending. Submit it again.";
};

function SubmitErrorNotice({ error }: { error: SignalClientError | undefined }) {
  if (!error) return null;
  const text = submitErrorText(error);
  if (!text) return <SignalErrorAlert error={error} />;
  return (
    <Alert variant="destructive">
      <AlertTitle>Not submitted</AlertTitle>
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  );
}

const latestPreview = (preview: PreviewState) => {
  if (preview.status === "ready") return preview.data;
  if (preview.status === "loading") return preview.previous;
};

/** What the form shows and submits, derived from the preview and the person's choices. */
const deriveForm = ({
  choice,
  chosenNeed,
  fields,
  preview,
  statementEdited,
}: {
  choice: Choice | undefined;
  chosenNeed: ChosenNeed | undefined;
  fields: SubmitFields;
  preview: PreviewState;
  statementEdited: boolean;
}) => {
  const data = latestPreview(preview);
  const options = needOptions(data?.matches ?? [], [chosenNeed]);
  const draft = data?.draftNeed.statement ?? "";
  return {
    data,
    drafted: Boolean(draft) && data?.ai === "ok",
    // With nothing to choose from, "None of these" is the answer.
    effectiveChoice:
      choice ?? (data && options.length === 0 ? ({ kind: "new" } as const) : undefined),
    newStatement: statementEdited ? fields.newStatement : draft || fields.title,
    options,
  };
};

const isChosen = (choice: Choice | undefined, needId: string) =>
  choice?.kind === "need" && choice.needId === needId;

/** `/submit`: request, live duplicate check, choice of need, context, and submit. */
export function SubmitForm({ initialNeed }: { initialNeed?: ChosenNeed }) {
  const [fields, setFields] = useState<SubmitFields>(emptyFields);
  const [choice, setChoice] = useState<Choice | undefined>(
    initialNeed ? { kind: "need", needId: initialNeed.needId } : undefined,
  );
  const [chosenNeed, setChosenNeed] = useState<ChosenNeed | undefined>(initialNeed);
  const [statementEdited, setStatementEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<SignalClientError>();
  const [result, setResult] = useState<SubmitResult>();
  const [pendingAsks, setPendingAsks] = useState<string[]>([]);
  const attempt = useRef<{ fingerprint: string; key: string }>(undefined);
  const preview = usePreview(fields.title, fields.body);

  const { data, drafted, effectiveChoice, newStatement, options } = deriveForm({
    choice,
    chosenNeed,
    fields,
    preview,
    statementEdited,
  });

  const set: FieldChange = (name) => (event) =>
    setFields((current) => ({ ...current, [name]: event.target.value }));

  const startOver = (next: Partial<SubmitFields> = {}) => {
    setFields((current) => ({
      ...emptyFields,
      company: current.company,
      email: current.email,
      name: current.name,
      ...next,
    }));
    setChoice(undefined);
    setChosenNeed(undefined);
    setStatementEdited(false);
    setSubmitError(undefined);
    setResult(undefined);
    attempt.current = undefined;
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    const input = toSubmitInput({ ...fields, newStatement }, effectiveChoice, {
      idempotencyKey: "",
      previewId: data?.previewId,
    });
    if (!input) return;
    const { idempotencyKey: _placeholder, ...content } = input;
    // One key per attempt: resending the same content after a failure reuses it.
    const fingerprint = attemptFingerprint(content);
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, key: newIdempotencyKey() };

    setSubmitting(true);
    setSubmitError(undefined);
    const response = await signalClient.submitSignal({
      ...content,
      idempotencyKey: attempt.current.key,
    });
    setSubmitting(false);
    if (response.ok) {
      setPendingAsks(data?.draftNeed.additionalAsks ?? []);
      setResult({
        ...response.data,
        statement:
          options.find((need) => need.needId === response.data.needId)?.statement ?? newStatement,
        trackingLink: trackingLinkFor(response.data.trackingUrl, window.location.origin),
      });
      return;
    }
    // A conflict means the key was used for different content: the next try gets a new key.
    if (response.error.code === "conflict") attempt.current = undefined;
    setSubmitError(response.error);
  };

  if (result)
    return (
      <SubmitSuccess
        onSplit={(ask) => {
          setPendingAsks((asks) => asks.filter((item) => item !== ask));
          startOver({ body: ask, title: splitTitle(ask) });
        }}
        onStartOver={() => startOver()}
        pendingAsks={pendingAsks}
        result={result}
      />
    );

  return (
    <form className="flex flex-col gap-8" onSubmit={submit}>
      <RequestFields fields={fields} set={set} />

      <fieldset aria-describedby="matches-status" className="flex flex-col gap-3">
        <legend className="mb-3 text-base font-medium">2. Is it one of these?</legend>
        <PreviewNotices data={data} preview={preview} />
        <div className="flex flex-col gap-2">
          {options.map((need) => (
            <MatchOption
              checked={isChosen(effectiveChoice, need.needId)}
              key={need.needId}
              need={need}
              onSelect={() => {
                setChoice({ kind: "need", needId: need.needId });
                setChosenNeed(need);
              }}
            />
          ))}
          <NoneOfTheseOption
            checked={effectiveChoice?.kind === "new"}
            onSelect={() => {
              setChoice({ kind: "new" });
              setChosenNeed(undefined);
            }}
          />
        </div>
        {effectiveChoice?.kind === "new" ? (
          <NewNeedStatement
            drafted={drafted}
            onChange={(value) => {
              setStatementEdited(true);
              setFields((current) => ({ ...current, newStatement: value }));
            }}
            value={newStatement}
          />
        ) : null}
      </fieldset>

      <ContextFields fields={fields} set={set} />

      <div aria-live="assertive">
        <SubmitErrorNotice error={submitError} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={submitting || !effectiveChoice} type="submit">
          {submitting ? <Spinner aria-hidden /> : null}
          {effectiveChoice?.kind === "need" ? "Add my voice" : "Submit request"}
        </Button>
        {effectiveChoice ? null : (
          <p className="text-muted-foreground text-sm">
            Choose a matching need or “None of these” to continue.
          </p>
        )}
      </div>
    </form>
  );
}
