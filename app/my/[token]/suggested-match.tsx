"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ConsoleError } from "@/app/operator/(console)/_components/console-bits";
import { Button } from "@/components/button";
import { createSignalClient } from "@/lib/signal/client";
import type { SignalClientError, SignalOperations } from "@/lib/signal/client";

import { PeopleCount } from "../../_components/signal/need-card";
import { Pencil } from "../../_components/signal/pencil";

type SuggestedMatchView =
  SignalOperations["get_my_signals"]["output"]["signals"][number]["suggestedMatches"][number];

const signal = createSignalClient();

/**
 * Spec 009 follow-up: Signal thinks this request duplicates an existing need. The holder adds
 * their voice there (their draft is merged into it) or says theirs is different.
 */
export function SuggestedMatch({ match, token }: { match: SuggestedMatchView; token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"join" | "decline" | null>(null);
  const [error, setError] = useState<SignalClientError | null>(null);

  const answer = async (choice: "join" | "decline") => {
    setBusy(choice);
    setError(null);
    const result = await signal.answerSuggestedMatch({
      answer: choice,
      suggestionId: match.suggestionId,
      token,
    });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.refresh();
  };

  return (
    <Pencil label="Is this the same need?" state="suggested">
      <div className="flex flex-col gap-3" data-testid="suggested-match">
        <p className="text-foreground text-[15px]">
          Others already asked for something that sounds the same. Add your voice there and your
          request counts toward it, in your own words.
        </p>
        <Link
          className="text-foreground font-serif text-lg leading-snug break-words not-italic underline-offset-4 hover:underline"
          href={`/needs/${match.need.id}`}
        >
          {match.need.statement}
        </Link>
        <PeopleCount count={match.need.supporterCount} />
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy !== null} onClick={() => answer("join")} size="sm">
            {busy === "join" ? "Adding…" : "Add my voice there"}
          </Button>
          <Button
            disabled={busy !== null}
            onClick={() => answer("decline")}
            size="sm"
            variant="outline"
          >
            {busy === "decline" ? "Saving…" : "No, mine is different"}
          </Button>
        </div>
        {error ? <ConsoleError error={error} /> : null}
      </div>
    </Pencil>
  );
}
