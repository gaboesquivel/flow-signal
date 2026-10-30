"use client";

import { ArrowLeftIcon, LockIcon } from "lucide-react";
import { useState } from "react";
import type { Ref } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/alert";
import { Button } from "@/components/button";
import { Input } from "@/components/input";
import { Textarea } from "@/components/textarea";
import type { SignalClientError } from "@/lib/signal/client";

import { SignalErrorAlert } from "../_components/signal/error-alert";
import { MIN_NEW_NEED_STATEMENT } from "./submit-model";
import type { ChosenNeed, SubmitFields } from "./submit-model";
import { FieldLabel, StepFoot, StepTitle, TextButton, primaryButton } from "./wizard-parts";

type ContactField = "company" | "email" | "name" | "urgency" | "useCase";

const urgencies = [
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
] as const;

const submitLabel = (submitting: boolean, existing: boolean) => {
  if (submitting) return "Sending…";
  return existing ? "Add my voice" : "Submit request";
};

const submitErrorText = (error: SignalClientError) => {
  if (error.code === "validation_failed") return `Please check the form: ${error.message}`;
  if (error.code === "not_found")
    return "That need no longer exists. Change where it lands, or submit it as a new need.";
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

/** Where the words will go, with a way to change it; a new need's statement can be reworded. */
function Lands({
  need,
  newStatement,
  onChange,
  onStatementChange,
}: {
  need: ChosenNeed | undefined;
  newStatement: string;
  onChange: () => void;
  onStatementChange: (value: string) => void;
}) {
  const [editing, setEditing] = useState(newStatement.trim().length < MIN_NEW_NEED_STATEMENT);
  return (
    <section
      aria-label="Where it lands"
      className="grid grid-cols-1 items-baseline gap-x-5 gap-y-2 border-b pb-7 sm:grid-cols-[minmax(0,1fr)_auto]"
    >
      <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase sm:col-span-2">
        {need ? "Adding your voice to" : "New need"}
      </p>
      {need || !editing ? (
        <p className="font-serif text-lg leading-snug break-words" data-testid="lands-statement">
          {need ? need.statement : newStatement}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <label className="sr-only" htmlFor="new-statement">
            The need, in one sentence
          </label>
          <Textarea
            aria-describedby="new-statement-help"
            id="new-statement"
            maxLength={500}
            minLength={MIN_NEW_NEED_STATEMENT}
            onChange={(event) => onStatementChange(event.target.value)}
            required
            rows={2}
            value={newStatement}
          />
          <p className="text-muted-foreground text-xs" id="new-statement-help">
            Who needs to do what, so that what happens? At least {MIN_NEW_NEED_STATEMENT}{" "}
            characters.
          </p>
        </div>
      )}
      <div className="flex gap-5">
        {need || editing ? null : <TextButton onClick={() => setEditing(true)}>Reword</TextButton>}
        <TextButton onClick={onChange}>Change</TextButton>
      </div>
    </section>
  );
}

/** Step 3: how it affects them, urgency, and who they are (only the product team sees it). */
export function DetailsStep({
  error,
  fields,
  headingRef,
  linkCleared,
  need,
  newStatement,
  onBack,
  onChangeTarget,
  onField,
  onStartNewLink,
  onStatementChange,
  onSubmit,
  rememberedLink,
  submitting,
}: {
  error: SignalClientError | undefined;
  fields: SubmitFields;
  headingRef: Ref<HTMLHeadingElement>;
  linkCleared: boolean;
  need: ChosenNeed | undefined;
  newStatement: string;
  onBack: () => void;
  onChangeTarget: () => void;
  onField: (name: ContactField, value: string) => void;
  onStartNewLink: () => void;
  onStatementChange: (value: string) => void;
  onSubmit: () => void;
  rememberedLink: string | undefined;
  submitting: boolean;
}) {
  return (
    <form
      className="flex flex-col gap-8"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <StepTitle headingRef={headingRef}>A few details</StepTitle>
      <Lands
        need={need}
        newStatement={newStatement}
        onChange={onChangeTarget}
        onStatementChange={onStatementChange}
      />

      <div className="flex flex-col gap-2">
        <FieldLabel htmlFor="use-case" optional>
          How does this affect you?
        </FieldLabel>
        <Input
          className="h-10"
          id="use-case"
          maxLength={2000}
          onChange={(event) => onField("useCase", event.target.value)}
          placeholder="e.g. board pack every month, ~2 hours of manual work"
          value={fields.useCase}
        />
      </div>

      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
        <legend className="mb-2 text-sm font-medium">
          Urgency
          <span className="text-muted-foreground ml-1.5 text-xs font-normal">Optional</span>
        </legend>
        <div className="border-input grid w-full grid-cols-3 overflow-hidden rounded-md border sm:w-[300px]">
          {urgencies.map((item) => (
            <label
              className="has-checked:bg-foreground has-checked:text-background has-focus-visible:ring-ring/50 relative flex h-10 cursor-pointer items-center justify-center border-l text-sm font-medium first:border-l-0 has-focus-visible:ring-3 has-focus-visible:ring-inset"
              key={item.value}
            >
              <input
                checked={fields.urgency === item.value}
                className="sr-only"
                name="urgency"
                onChange={() => onField("urgency", item.value)}
                onClick={() => {
                  // Clicking the chosen urgency again clears it: urgency is optional.
                  if (fields.urgency === item.value) onField("urgency", "");
                }}
                type="radio"
                value={item.value}
              />
              {item.label}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-2">
        <FieldLabel htmlFor="email">Email</FieldLabel>
        <Input
          autoComplete="email"
          className="h-10"
          id="email"
          maxLength={254}
          onChange={(event) => onField("email", event.target.value)}
          required
          type="email"
          value={fields.email}
        />
      </div>
      <div className="grid gap-8 sm:grid-cols-2 sm:gap-5">
        <div className="flex flex-col gap-2">
          <FieldLabel htmlFor="name" optional>
            Name
          </FieldLabel>
          <Input
            autoComplete="name"
            className="h-10"
            id="name"
            maxLength={120}
            onChange={(event) => onField("name", event.target.value)}
            value={fields.name}
          />
        </div>
        <div className="flex flex-col gap-2">
          <FieldLabel htmlFor="company" optional>
            Company
          </FieldLabel>
          <Input
            autoComplete="organization"
            className="h-10"
            id="company"
            maxLength={120}
            onChange={(event) => onField("company", event.target.value)}
            value={fields.company}
          />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <p className="text-muted-foreground flex items-start gap-2 text-sm">
          <LockIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          Your words are kept as you wrote them and shown only to the product team. Your email is
          never public.
        </p>
        {rememberedLink ? (
          <p className="text-muted-foreground text-sm" data-testid="link-line">
            Filing under your{" "}
            <a
              className="text-foreground underline underline-offset-4"
              href={`/my/${rememberedLink}`}
              rel="noreferrer"
              target="_blank"
            >
              My signals page
            </a>{" "}
            ·{" "}
            <TextButton className="inline" onClick={onStartNewLink}>
              Start a new link
            </TextButton>
          </p>
        ) : null}
        {!rememberedLink && linkCleared ? (
          <p className="text-muted-foreground text-sm" data-testid="link-line">
            This request starts a new My signals link.
          </p>
        ) : null}
      </div>

      <div aria-live="assertive">
        <SubmitErrorNotice error={error} />
      </div>

      <StepFoot>
        <TextButton className="self-start" onClick={onBack}>
          <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
          Back
        </TextButton>
        <Button className={primaryButton} disabled={submitting} type="submit">
          {submitLabel(submitting, Boolean(need))}
        </Button>
      </StepFoot>
    </form>
  );
}
