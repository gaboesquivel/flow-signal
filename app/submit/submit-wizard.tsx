"use client";

import { useQuery } from "@tanstack/react-query";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import { useCallback, useEffect, useRef, useState } from "react";

import type { SignalClientError } from "@/lib/signal/client";

import { CheckStep } from "./check-step";
import type { CheckState } from "./check-step";
import { DescribeStep } from "./describe-step";
import { DetailsStep } from "./details-step";
import { DoneStep } from "./done-step";
import type { SubmitResult } from "./done-step";
import { signalClient } from "./signal-client";
import {
  attemptFingerprint,
  checkOptions,
  linkOutcome,
  newIdempotencyKey,
  previewInput,
  previewKey,
  splitTitle,
  toSubmitInput,
  tokenFromTrackingUrl,
  trackingLinkFor,
  visibleStep,
  wizardSteps,
} from "./submit-model";
import type { ChosenNeed, Choice, SubmitFields, WizardStep } from "./submit-model";
import { useRememberedLink } from "./use-remembered-link";
import { StepRule } from "./wizard-parts";

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

/** What the person decided on Check, for the words that were checked (`key`). */
interface Decision {
  key: string;
  need?: ChosenNeed;
}

const stepParser = parseAsStringLiteral(wizardSteps)
  .withDefault("describe")
  .withOptions({ history: "push", scroll: true });

/** `preview_signal` once per checked text: cached by the words, so Back → Continue reuses it. */
const usePreviewCheck = (key: string | undefined) =>
  useQuery({
    enabled: Boolean(key),
    gcTime: Number.POSITIVE_INFINITY,
    queryFn: ({ signal }) => signalClient.previewSignal(previewInput(key ?? ""), { signal }),
    queryKey: ["preview_signal", key],
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

const toCheckState = (query: ReturnType<typeof usePreviewCheck>): CheckState => {
  if (query.isFetching || !query.data) return { status: "loading" };
  return query.data.ok
    ? { data: query.data.data, status: "ready" }
    : { error: query.data.error, status: "error" };
};

/** What the wizard shows, derived from the check and the person's choices. */
const deriveView = ({
  check,
  checkedKey,
  decision,
  described,
  initialNeed,
  selection,
}: {
  check: CheckState;
  checkedKey: string | undefined;
  decision: Decision | undefined;
  described: boolean;
  initialNeed: ChosenNeed | undefined;
  selection: { key: string; needId: string } | undefined;
}) => {
  const data = check.status === "ready" ? check.data : undefined;
  const options = data ? checkOptions(data.matches, initialNeed) : [];
  const selectedId =
    selection && selection.key === checkedKey ? selection.needId : options[0]?.needId;
  const activeDecision = described && decision?.key === checkedKey ? decision : undefined;
  let choice: Choice | undefined;
  if (activeDecision)
    choice = activeDecision.need
      ? { kind: "need", needId: activeDecision.need.needId }
      : { kind: "new" };
  return {
    activeDecision,
    choice,
    data,
    options,
    selected: options.find((need) => need.needId === selectedId) ?? options[0],
  };
};

/** Focuses each step's heading as it mounts (not on first load), so screen readers hear it. */
const useStepFocus = () => {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  return useCallback((node: HTMLHeadingElement | null) => {
    if (node && mounted.current) node.focus({ preventScroll: true });
  }, []);
};

/**
 * `/submit`: Describe → Check → Details → Done. The step is in the URL (`?step=`); what was typed
 * stays in memory, so Back keeps it. Nothing is checked while typing: Continue runs the check.
 */
export function SubmitWizard({ initialNeed }: { initialNeed?: ChosenNeed }) {
  const [requestedStep, setStep] = useQueryState("step", stepParser);
  const [fields, setFields] = useState<SubmitFields>(emptyFields);
  const [checkedKey, setCheckedKey] = useState<string>();
  const [selection, setSelection] = useState<{ key: string; needId: string }>();
  const [decision, setDecision] = useState<Decision>();
  const [statementEdited, setStatementEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<SignalClientError>();
  const [result, setResult] = useState<SubmitResult>();
  const [pendingAsks, setPendingAsks] = useState<string[]>([]);
  const [linkCleared, setLinkCleared] = useState(false);
  const attempt = useRef<{ fingerprint: string; key: string }>(undefined);
  const headingRef = useStepFocus();
  const link = useRememberedLink();

  const currentKey = previewKey(fields.title, fields.body);
  const described = Boolean(checkedKey) && checkedKey === currentKey;
  const preview = usePreviewCheck(described ? checkedKey : undefined);
  const check = toCheckState(preview);
  const { activeDecision, choice, data, options, selected } = deriveView({
    check,
    checkedKey,
    decision,
    described,
    initialNeed,
    selection,
  });
  const step = visibleStep(requestedStep, { choice, described, done: Boolean(result) });
  const newStatement = statementEdited
    ? fields.newStatement
    : data?.draftNeed.statement || fields.title.trim();

  const goTo = (next: WizardStep) => {
    setStep(next).catch(() => {
      // The URL could not change; the step still follows the in-memory state.
    });
  };

  const resetFor = (next: Partial<SubmitFields>) => {
    setFields((current) => ({
      ...emptyFields,
      company: current.company,
      email: current.email,
      name: current.name,
      ...next,
    }));
    setCheckedKey(undefined);
    setSelection(undefined);
    setDecision(undefined);
    setStatementEdited(false);
    setSubmitError(undefined);
    setResult(undefined);
    setLinkCleared(false);
    attempt.current = undefined;
    goTo("describe");
  };

  const submit = async () => {
    if (submitting || !choice) return;
    const sentToken = link.token;
    const input = toSubmitInput({ ...fields, newStatement }, choice, {
      idempotencyKey: "",
      previewId: data?.previewId,
      trackingToken: sentToken,
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
    if (!response.ok) {
      // A conflict means the key was used for different content: the next try gets a new key.
      if (response.error.code === "conflict") attempt.current = undefined;
      setSubmitError(response.error);
      return;
    }
    const token = tokenFromTrackingUrl(response.data.trackingUrl);
    if (token) link.remember(token);
    setPendingAsks(data?.draftNeed.additionalAsks ?? []);
    setResult({
      ...response.data,
      link: linkOutcome(response.data, sentToken),
      statement: activeDecision?.need?.statement ?? newStatement,
      trackingLink: trackingLinkFor(response.data.trackingUrl, window.location.origin),
    });
    goTo("done");
  };

  return (
    <div className="flex flex-col gap-10 sm:gap-14">
      <StepRule step={step} />
      {step === "describe" ? (
        <DescribeStep
          fields={fields}
          headingRef={headingRef}
          initialNeed={initialNeed}
          onChange={(name, value) => setFields((current) => ({ ...current, [name]: value }))}
          onContinue={() => {
            setCheckedKey(currentKey);
            goTo("check");
          }}
        />
      ) : null}
      {step === "check" ? (
        <CheckStep
          body={fields.body}
          check={check}
          headingRef={headingRef}
          onAddVoice={(need) => {
            setDecision({ key: checkedKey ?? "", need });
            goTo("details");
          }}
          onBack={() => goTo("describe")}
          onNewNeed={() => {
            setDecision({ key: checkedKey ?? "" });
            goTo("details");
          }}
          onRetry={() => {
            preview.refetch().catch(() => {
              // A failed retry shows as an error state.
            });
          }}
          onSelect={(needId) => setSelection({ key: checkedKey ?? "", needId })}
          options={options}
          selected={selected}
          title={fields.title}
        />
      ) : null}
      {step === "details" ? (
        <DetailsStep
          error={submitError}
          fields={fields}
          headingRef={headingRef}
          linkCleared={linkCleared}
          need={activeDecision?.need}
          newStatement={newStatement}
          onBack={() => goTo("check")}
          onChangeTarget={() => goTo("check")}
          onField={(name, value) => setFields((current) => ({ ...current, [name]: value }))}
          onStartNewLink={() => {
            link.forget();
            setLinkCleared(true);
          }}
          onStatementChange={(value) => {
            setStatementEdited(true);
            setFields((current) => ({ ...current, newStatement: value }));
          }}
          onSubmit={() => {
            submit().catch(() => {
              setSubmitting(false);
            });
          }}
          rememberedLink={link.token}
          submitting={submitting}
        />
      ) : null}
      {step === "done" && result ? (
        <DoneStep
          headingRef={headingRef}
          name={fields.name}
          onFileAsk={(ask) => {
            setPendingAsks((asks) => asks.filter((item) => item !== ask));
            resetFor({ body: ask, title: splitTitle(ask) });
          }}
          onStartOver={() => {
            setPendingAsks([]);
            resetFor({});
          }}
          pendingAsks={pendingAsks}
          result={result}
        />
      ) : null}
    </div>
  );
}
