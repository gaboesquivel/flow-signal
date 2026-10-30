"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeftIcon, InfoIcon } from "lucide-react";
import type { Ref } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/alert";
import { Button } from "@/components/button";
import { LoadingLine } from "@/components/loading-line";
import { ReadingPair, ReadingPane } from "@/components/reading-pair";
import type { SignalClientError } from "@/lib/signal/client";

import { SignalErrorAlert } from "../_components/signal/error-alert";
import { InkNote } from "../_components/signal/ink-note";
import { DecisionNote, PeopleCount } from "../_components/signal/need-card";
import { Pencil } from "../_components/signal/pencil";
import { Status } from "../_components/signal/status";
import { signalClient } from "./signal-client";
import type { ChosenNeed, PreviewOutput } from "./submit-model";
import { StepFoot, StepTitle, TextButton, primaryButton } from "./wizard-parts";

export type CheckState =
  | { status: "loading" }
  | { error: SignalClientError; status: "error" }
  | { data: PreviewOutput; status: "ready" };

/** A compact radio list of up to three matches: statement and people, one selected. */
function MatchList({
  onSelect,
  options,
  selectedId,
}: {
  onSelect: (needId: string) => void;
  options: ChosenNeed[];
  selectedId: string | undefined;
}) {
  return (
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="sr-only">Needs like yours</legend>
      <ol className="border-rule-strong m-0 list-none border-t p-0">
        {options.map((need) => {
          const selected = need.needId === selectedId;
          return (
            <li className="border-border min-w-0 border-b" key={need.needId}>
              <label className="has-focus-visible:ring-ring/50 grid min-w-0 cursor-pointer grid-cols-[18px_minmax(0,1fr)_auto] items-start gap-3.5 rounded-sm py-3 has-focus-visible:ring-3 sm:items-center">
                <input
                  checked={selected}
                  className="accent-primary mt-1 size-4 sm:mt-0"
                  name="match"
                  onChange={() => onSelect(need.needId)}
                  type="radio"
                  value={need.needId}
                />
                <span
                  className={`line-clamp-2 font-serif text-base leading-snug sm:line-clamp-1 ${selected ? "text-foreground" : "text-muted-foreground"}`}
                  title={need.statement}
                >
                  {need.statement}
                </span>
                <span className="text-muted-foreground font-mono text-[13px] whitespace-nowrap">
                  {need.supporterCount} {need.supporterCount === 1 ? "person" : "people"}
                </span>
              </label>
            </li>
          );
        })}
      </ol>
    </fieldset>
  );
}

/** The selected need: statement, status, people, approved summary or decision, why it matches. */
function SelectedNeed({ need }: { need: ChosenNeed }) {
  // The approved summary and decision note come from the need itself; matches carry neither.
  const detail = useQuery({
    queryFn: ({ signal }) => signalClient.getNeed({ id: need.needId }, { signal }),
    queryKey: ["need", need.needId],
    staleTime: 60_000,
  });
  const publicNeed = detail.data?.ok ? detail.data.data : undefined;
  return (
    <ReadingPane aria-label="The selected need" label="The selected need">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2.5">
          <p className="font-serif text-lg leading-snug">{need.statement}</p>
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
            <Status status={need.status} />
            <PeopleCount count={need.supporterCount} />
          </div>
        </div>
        {publicNeed?.publicSummary ? (
          <InkNote label="Summary">{publicNeed.publicSummary}</InkNote>
        ) : null}
        {!publicNeed?.publicSummary && publicNeed?.decision ? (
          <DecisionNote decision={publicNeed.decision} />
        ) : null}
        {publicNeed && !publicNeed.publicSummary && !publicNeed.decision ? (
          <p className="text-muted-foreground text-sm">No summary yet.</p>
        ) : null}
        {need.reason ? (
          <Pencil label="Why it matches" state="suggested">
            <p className="font-serif text-base leading-normal">{need.reason}</p>
          </Pencil>
        ) : null}
      </div>
    </ReadingPane>
  );
}

function YourWords({ body, data, title }: { body: string; data: PreviewOutput; title: string }) {
  return (
    <ReadingPane aria-label="What you wrote" label="What you wrote">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <p className="font-serif text-lg leading-snug font-medium">{title.trim()}</p>
          <p className="font-serif text-base leading-normal whitespace-pre-line">{body.trim()}</p>
        </div>
        {data.ai === "ok" && data.draftNeed.statement ? (
          <Pencil label="Your need, as we understand it" state="suggested">
            <p className="font-serif text-base leading-normal">{data.draftNeed.statement}</p>
          </Pencil>
        ) : null}
      </div>
    </ReadingPane>
  );
}

/** Other asks found in the words: offered in one quiet line, filed after this one. */
function AdditionalAsks({ asks }: { asks: string[] }) {
  if (asks.length === 0) return null;
  return (
    <p className="text-muted-foreground text-sm" data-testid="additional-asks">
      You also mentioned {asks.map((ask) => `“${ask}”`).join(" and ")}. After this one, you can file{" "}
      {asks.length === 1 ? "it" : "them"} separately so each counts where it belongs.
    </p>
  );
}

/** Step 2: the duplicate check's result, read side by side, and the one decision to make. */
export function CheckStep({
  body,
  check,
  headingRef,
  onAddVoice,
  onBack,
  onNewNeed,
  onRetry,
  onSelect,
  options,
  selected,
  title,
}: {
  body: string;
  check: CheckState;
  headingRef: Ref<HTMLHeadingElement>;
  onAddVoice: (need: ChosenNeed) => void;
  onBack: () => void;
  onNewNeed: () => void;
  onRetry: () => void;
  onSelect: (needId: string) => void;
  options: ChosenNeed[];
  selected: ChosenNeed | undefined;
  title: string;
}) {
  const back = (
    <TextButton className="self-start" onClick={onBack}>
      <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
      Back to your words
    </TextButton>
  );

  if (check.status === "loading")
    return (
      <div className="flex flex-col gap-8">
        <h1 className="sr-only" ref={headingRef} tabIndex={-1}>
          Checking for needs like yours
        </h1>
        <LoadingLine>Looking for needs like yours…</LoadingLine>
      </div>
    );

  if (check.status === "error")
    return (
      <div className="flex flex-col gap-8">
        <StepTitle headingRef={headingRef}>We couldn&apos;t check right now</StepTitle>
        <SignalErrorAlert error={check.error} />
        <StepFoot>
          {back}
          <Button className={primaryButton} onClick={onRetry} type="button">
            Try again
          </Button>
        </StepFoot>
      </div>
    );

  const { data } = check;
  const unavailable = data.ai === "unavailable";
  const asks = data.draftNeed.additionalAsks;

  if (!selected)
    return (
      <div className="flex flex-col gap-8">
        <StepTitle
          headingRef={headingRef}
          sub={
            unavailable
              ? undefined
              : "Nobody has asked for this yet. Your request starts a new need."
          }
        >
          {unavailable ? "Matching is unavailable right now" : "This looks new"}
        </StepTitle>
        {unavailable ? <MatchingUnavailable /> : null}
        <AdditionalAsks asks={asks} />
        <StepFoot>
          {back}
          <Button className={primaryButton} onClick={onNewNeed} type="button">
            Submit as a new need
          </Button>
        </StepFoot>
      </div>
    );

  return (
    <div className="flex flex-col gap-8">
      <StepTitle
        headingRef={headingRef}
        sub="Pick the one that fits and read it next to what you wrote."
      >
        Others may have asked for this already.
      </StepTitle>
      {unavailable ? <MatchingUnavailable /> : null}
      <MatchList onSelect={onSelect} options={options} selectedId={selected.needId} />
      <ReadingPair>
        <YourWords body={body} data={data} title={title} />
        <SelectedNeed need={selected} />
      </ReadingPair>
      <AdditionalAsks asks={asks} />
      <StepFoot>
        <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:gap-6">
          {back}
          <TextButton onClick={onNewNeed}>None of these — it&apos;s a new need</TextButton>
        </div>
        <Button className={primaryButton} onClick={() => onAddVoice(selected)} type="button">
          Add my voice to this need
        </Button>
      </StepFoot>
    </div>
  );
}

function MatchingUnavailable() {
  return (
    <Alert>
      <InfoIcon aria-hidden />
      <AlertTitle>We can&apos;t look for similar needs at the moment</AlertTitle>
      <AlertDescription>
        You can still submit: your request starts a new need, and the product team groups duplicates
        later.
      </AlertDescription>
    </Alert>
  );
}
