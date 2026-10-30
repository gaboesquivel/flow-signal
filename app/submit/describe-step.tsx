"use client";

import { ArrowRightIcon } from "lucide-react";
import type { Ref } from "react";

import { Button } from "@/components/button";
import { Input } from "@/components/input";
import { Textarea } from "@/components/textarea";

import type { ChosenNeed, SubmitFields } from "./submit-model";
import { describeReady } from "./submit-model";
import { FieldLabel, StepFoot, StepTitle, primaryButton } from "./wizard-parts";

/** Step 1: only the person's words. Nothing is checked or suggested while they type. */
export function DescribeStep({
  fields,
  headingRef,
  initialNeed,
  onChange,
  onContinue,
}: {
  fields: SubmitFields;
  headingRef: Ref<HTMLHeadingElement>;
  initialNeed?: ChosenNeed;
  onChange: (name: "body" | "title", value: string) => void;
  onContinue: () => void;
}) {
  const ready = describeReady(fields.title, fields.body);
  return (
    <form
      className="flex flex-col gap-8"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onContinue();
      }}
    >
      <StepTitle
        headingRef={headingRef}
        sub={
          initialNeed ? (
            <>
              You came from{" "}
              <span className="text-foreground font-serif">“{initialNeed.statement}”</span>. Say it
              in your own words; we&apos;ll show that need first.
            </>
          ) : (
            "Say it in your own words. Next, we check whether others have asked for this."
          )
        }
      >
        Tell us what you need
      </StepTitle>
      <div className="flex flex-col gap-2">
        <FieldLabel htmlFor="title">In a few words, what do you need?</FieldLabel>
        <Input
          autoComplete="off"
          className="h-11 text-base md:text-base"
          id="title"
          maxLength={200}
          minLength={3}
          name="title"
          onChange={(event) => onChange("title", event.target.value)}
          placeholder="e.g. Monthly PDF of the revenue dashboard"
          required
          value={fields.title}
        />
      </div>
      <div className="flex flex-col gap-2">
        <FieldLabel htmlFor="body">
          What&apos;s getting in the way? What were you trying to do?
        </FieldLabel>
        <Textarea
          className="min-h-36 text-base md:text-base"
          id="body"
          maxLength={5000}
          name="body"
          onChange={(event) => onChange("body", event.target.value)}
          required
          rows={6}
          value={fields.body}
        />
      </div>
      <StepFoot>
        <p className="text-muted-foreground text-sm">Your words are kept as you wrote them.</p>
        <Button className={primaryButton} disabled={!ready} type="submit">
          Continue
          <ArrowRightIcon aria-hidden="true" />
        </Button>
      </StepFoot>
    </form>
  );
}
