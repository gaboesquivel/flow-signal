"use client";

import { CopyIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { Ref } from "react";

import { Button } from "@/components/button";

import type { SubmitOutput } from "./submit-model";
import { StepFoot, TextButton, primaryButton } from "./wizard-parts";

export type SubmitResult = SubmitOutput & {
  /** What happened to the link this device filed under. */
  link: "new" | "replaced" | "reused";
  statement: string;
  trackingLink: string;
};

const linkNote: Record<SubmitResult["link"], string> = {
  new: "This is a new private link. No email is sent, so keep it. Your next requests from this browser are filed on the same page.",
  replaced:
    "The link remembered in this browser no longer works, so this request started a new one. Keep this link instead.",
  reused:
    "Filed on the My signals page you already have: the same link as before, now with this request too.",
};

/** Step 4: where it landed, and the private My signals link to keep. */
export function DoneStep({
  headingRef,
  name,
  onFileAsk,
  onStartOver,
  pendingAsks,
  result,
}: {
  headingRef: Ref<HTMLHeadingElement>;
  name: string;
  onFileAsk: (ask: string) => void;
  onStartOver: () => void;
  pendingAsks: string[];
  result: SubmitResult;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.trackingLink);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const path = new URL(result.trackingLink).pathname;

  return (
    <section aria-labelledby="done-title" className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1
          className="font-serif text-[25px] leading-tight font-medium tracking-tight outline-none sm:text-[30px]"
          id="done-title"
          ref={headingRef}
          tabIndex={-1}
        >
          {name.trim() ? `Thanks, ${name.trim()}.` : "Thanks."}
        </h1>
        <p className="text-muted-foreground text-[15px]">
          {result.attachedTo === "existing"
            ? "Your voice was added to"
            : "Your request started a new need, shown as New until the product team reviews it:"}
        </p>
        <Link
          className="font-serif text-lg leading-snug break-words underline-offset-4 hover:underline"
          href={`/needs/${result.needId}`}
        >
          {result.statement}
        </Link>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium" htmlFor="tracking-link">
          Your private link, My signals
        </label>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
          <input
            aria-describedby="tracking-link-help"
            className="border-input bg-background h-10 min-w-0 flex-1 rounded-md border px-3 font-mono text-sm outline-none"
            data-link={result.link}
            id="tracking-link"
            onFocus={(event) => event.currentTarget.select()}
            readOnly
            value={result.trackingLink}
          />
          <Button className={primaryButton} onClick={copy} type="button">
            <CopyIcon aria-hidden="true" />
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p
          className="text-muted-foreground text-sm"
          data-testid="link-note"
          id="tracking-link-help"
        >
          {linkNote[result.link]} Anyone with the link can read it.
        </p>
        <Link
          className="text-primary self-start text-sm underline-offset-4 hover:underline"
          href={path}
        >
          Open My signals
        </Link>
      </div>

      {pendingAsks.length > 0 ? (
        <section aria-labelledby="also-asked" className="flex flex-col gap-2">
          <h2 className="text-sm font-medium" id="also-asked">
            You also asked for
          </h2>
          <ul className="border-rule-strong m-0 list-none border-t p-0">
            {pendingAsks.map((ask) => (
              <li
                className="border-border flex flex-col gap-2 border-b py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6"
                key={ask}
              >
                <span className="font-serif text-base break-words">{ask}</span>
                <TextButton className="shrink-0" onClick={() => onFileAsk(ask)}>
                  File this separately
                </TextButton>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <StepFoot className="sm:justify-start sm:gap-6">
        <Link
          className="text-primary text-sm font-medium underline-offset-4 hover:underline"
          href="/"
        >
          ← Back to the board
        </Link>
        <TextButton onClick={onStartOver}>Submit another request</TextButton>
      </StepFoot>
    </section>
  );
}
