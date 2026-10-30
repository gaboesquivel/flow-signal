"use client";

import { CheckCircle2Icon, SplitIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/alert";
import { Button, buttonVariants } from "@/components/button";
import { Input } from "@/components/input";
import { Label } from "@/components/label";

import type { SubmitOutput } from "./submit-model";

export type SubmitResult = SubmitOutput & { statement: string; trackingLink: string };

/** After submitting: where the signal landed, the private link, and any asks to file separately. */
export function SubmitSuccess({
  onSplit,
  onStartOver,
  pendingAsks,
  result,
}: {
  onSplit: (ask: string) => void;
  onStartOver: () => void;
  pendingAsks: string[];
  result: SubmitResult;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => headingRef.current?.focus(), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.trackingLink);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section aria-labelledby="submitted" className="flex flex-col gap-5">
      <Alert>
        <CheckCircle2Icon aria-hidden />
        <AlertTitle>
          <h2 className="outline-none" id="submitted" ref={headingRef} tabIndex={-1}>
            {result.attachedTo === "existing"
              ? "Your voice was added"
              : "Thanks, your request started a new need"}
          </h2>
        </AlertTitle>
        <AlertDescription>
          <p>
            {result.attachedTo === "existing"
              ? "Your request now counts toward this need, in your own words:"
              : "It shows as New on the board until a product manager reviews it:"}{" "}
            <Link className="underline underline-offset-4" href={`/needs/${result.needId}`}>
              {result.statement}
            </Link>
          </p>
        </AlertDescription>
      </Alert>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="tracking-link">Your private link</Label>
        <p className="text-muted-foreground text-sm" id="tracking-link-help">
          Keep this link to follow status changes and decision notes. It is the only way back to
          your request, and anyone with it can read it.
        </p>
        <div className="flex gap-2">
          <Input
            aria-describedby="tracking-link-help"
            id="tracking-link"
            onFocus={(event) => event.currentTarget.select()}
            readOnly
            value={result.trackingLink}
          />
          <Button onClick={copy} type="button" variant="outline">
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <div>
          <Link
            className={buttonVariants({ variant: "link" })}
            href={new URL(result.trackingLink).pathname}
          >
            Open my signals
          </Link>
        </div>
      </div>

      {pendingAsks.length > 0 ? (
        <Alert>
          <SplitIcon aria-hidden />
          <AlertTitle>You also asked for something else</AlertTitle>
          <AlertDescription>
            <p>File each ask on its own so it counts where it belongs.</p>
            <ul className="mt-2 flex flex-col gap-2">
              {pendingAsks.map((ask) => (
                <li className="flex flex-wrap items-center gap-2" key={ask}>
                  <span className="text-foreground">{ask}</span>
                  <Button onClick={() => onSplit(ask)} size="sm" type="button" variant="outline">
                    File this separately
                  </Button>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <div>
        <Button onClick={onStartOver} type="button" variant="ghost">
          Submit another request
        </Button>
      </div>
    </section>
  );
}
