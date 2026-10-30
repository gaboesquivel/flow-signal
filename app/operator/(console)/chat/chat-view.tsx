"use client";

import { ArrowRight, Search } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";

import { Pencil } from "@/app/_components/signal/pencil";
import { Button } from "@/components/button";
import { LoadingLine } from "@/components/loading-line";

import { ConsoleHeading, ConsoleStatus } from "../_components/console-bits";
import type { AnswerSegment, ChatAnswer, CitedNeed } from "../_lib/chat";
import { answerBlocks, toolSourceLine } from "../_lib/chat";
import type { OperatorNeedStatus } from "../_lib/console";
import { operatorStatusLabels } from "../_lib/console";

const sampleQuestion = "What are enterprise accounts blocked on?";

type Turn =
  | { id: number; question: string; state: "loading" }
  | { answer: ChatAnswer; id: number; question: string; state: "answered" }
  | { error: string; id: number; question: string; state: "failed" };

const failureText = (status: number, code: string | undefined, message: string | undefined) => {
  if (status === 401 || status === 403)
    return "Your Operator session has ended. Sign in again on the access page.";
  if (code === "chat_unavailable")
    return "The Operator agent can’t answer right now: the AI model is unavailable. The Needs table has the same numbers.";
  return message ?? "Something went wrong. Try again in a moment.";
};

const ask = async (
  history: readonly Turn[],
  question: string,
): Promise<{ answer: ChatAnswer } | { error: string }> => {
  const messages = [
    ...history.flatMap((turn) =>
      turn.state === "answered"
        ? [
            { content: turn.question, role: "user" as const },
            { content: turn.answer.answer, role: "assistant" as const },
          ]
        : [],
    ),
    { content: question, role: "user" as const },
  ].slice(-20);
  try {
    const response = await fetch("/api/operator/chat", {
      body: JSON.stringify({ messages }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const body = (await response.json().catch(() => ({}))) as Partial<ChatAnswer> & {
      code?: string;
      message?: string;
    };
    if (!response.ok || typeof body.answer !== "string")
      return { error: failureText(response.status, body.code, body.message) };
    return {
      answer: { answer: body.answer, cited: body.cited ?? [], sources: body.sources ?? [] },
    };
  } catch {
    return { error: "Couldn’t reach Signal. Check your connection and try again." };
  }
};

/** Question → pencil answer with linked needs and a cited-needs list; no chat bubbles. */
export function ChatView() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const nextId = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastRef = useRef<HTMLDivElement>(null);
  const busy = turns.some((turn) => turn.state === "loading");

  const showLast = () =>
    requestAnimationFrame(() =>
      lastRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
    );

  const submit = async (question: string) => {
    const trimmed = question.trim();
    if (!trimmed || busy) return;
    const id = nextId.current;
    nextId.current += 1;
    const history = turns;
    setTurns([...history, { id, question: trimmed, state: "loading" }]);
    setInput("");
    showLast();
    const result = await ask(history, trimmed);
    const settled: Turn =
      "answer" in result
        ? { answer: result.answer, id, question: trimmed, state: "answered" }
        : { error: result.error, id, question: trimmed, state: "failed" };
    setTurns((current) => current.map((turn) => (turn.id === id ? settled : turn)));
    inputRef.current?.focus();
    showLast();
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <ConsoleHeading title="Chat">
        Ask about demand. Answers cite needs and accounts from this workspace.
      </ConsoleHeading>

      {turns.length > 0 ? (
        <div className="flex flex-col gap-10" data-testid="chat-thread">
          {turns.map((turn, index) => (
            <div
              className="flex flex-col gap-4"
              data-turn={turn.state}
              key={turn.id}
              ref={index === turns.length - 1 ? lastRef : undefined}
            >
              <div>
                <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase">
                  You asked
                </p>
                <p className="mt-1 font-serif text-xl leading-snug">{turn.question}</p>
              </div>
              {turn.state === "loading" ? <LoadingLine>Reading demand…</LoadingLine> : null}
              {turn.state === "failed" ? (
                <p className="text-destructive text-sm" role="alert">
                  {turn.error}
                  {turn.error.startsWith("Your Operator session") ? (
                    <>
                      {" "}
                      <Link className="underline underline-offset-4" href="/operator/access">
                        Operator access
                      </Link>
                    </>
                  ) : null}
                </p>
              ) : null}
              {turn.state === "answered" ? <Answer answer={turn.answer} /> : null}
            </div>
          ))}
        </div>
      ) : null}

      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-center"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(input);
        }}
      >
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Ask a question</span>
          <Search
            aria-hidden="true"
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          />
          <input
            autoComplete="off"
            className="border-input focus-visible:border-ring focus-visible:ring-ring/50 h-10 w-full rounded-lg border bg-transparent pr-3 pl-9 text-sm outline-none focus-visible:ring-3"
            maxLength={2000}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Ask about needs, accounts, or demand"
            ref={inputRef}
            value={input}
          />
        </label>
        <Button className="h-10 px-4" disabled={busy || !input.trim()} type="submit">
          Ask <ArrowRight aria-hidden="true" data-icon="inline-end" />
        </Button>
      </form>
      {turns.length === 0 ? (
        <p className="text-muted-foreground -mt-4 text-sm">
          Try{" "}
          <button
            className="text-foreground decoration-input font-medium underline underline-offset-4"
            onClick={() => {
              setInput(sampleQuestion);
              inputRef.current?.focus();
            }}
            type="button"
          >
            {sampleQuestion}
          </button>
        </p>
      ) : null}
    </div>
  );
}

function Segments({ segments }: { segments: AnswerSegment[] }) {
  return segments.map((segment, index) =>
    segment.type === "need" ? (
      <Link
        className="text-ai-foreground decoration-ai font-medium underline underline-offset-4"
        data-need-link={segment.id}
        href={`/operator/needs/${segment.id}`}
        // oxlint-disable-next-line react/no-array-index-key -- segments are positional text
        key={index}
      >
        {segment.text}
      </Link>
    ) : (
      // oxlint-disable-next-line react/no-array-index-key -- segments are positional text
      <span key={index}>{segment.text}</span>
    ),
  );
}

const isStatus = (status: string | null): status is OperatorNeedStatus =>
  status !== null && status !== "merged" && status in operatorStatusLabels;

function Answer({ answer }: { answer: ChatAnswer }) {
  const blocks = answerBlocks(answer.answer);
  return (
    <div className="flex flex-col gap-6" data-testid="chat-answer">
      <Pencil label="Answer · AI, not reviewed" state="suggested">
        <div className="flex flex-col gap-3 text-[15px] leading-relaxed">
          {blocks.length === 0 ? (
            <p>The agent returned no answer. Try asking another way.</p>
          ) : null}
          {blocks.map((block, index) =>
            block.kind === "paragraph" ? (
              // oxlint-disable-next-line react/no-array-index-key -- blocks are positional
              <p className="m-0" key={index}>
                <Segments segments={block.segments} />
              </p>
            ) : (
              // oxlint-disable-next-line react/no-array-index-key -- blocks are positional
              <ul className="m-0 flex list-disc flex-col gap-1 pl-5" key={index}>
                {block.items.map((item, itemIndex) => (
                  // oxlint-disable-next-line react/no-array-index-key -- items are positional
                  <li key={itemIndex}>
                    <Segments segments={item} />
                  </li>
                ))}
              </ul>
            ),
          )}
        </div>
      </Pencil>
      {answer.cited.length > 0 ? <CitedList needs={answer.cited} /> : null}
      {answer.sources.length > 0 ? (
        <p
          className="text-muted-foreground font-mono text-[11px] break-words"
          data-testid="chat-sources"
        >
          Read: {toolSourceLine(answer.sources)}
        </p>
      ) : null}
    </div>
  );
}

function CitedList({ needs }: { needs: CitedNeed[] }) {
  return (
    <section aria-label="Cited needs" className="flex flex-col gap-2">
      <h3 className="text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase">
        Cited needs · {needs.length}
      </h3>
      <ol className="border-rule-strong m-0 list-none border-t p-0" data-testid="cited-needs">
        {needs.map((need) => (
          <li className="border-border flex min-w-0 flex-col gap-1 border-b py-3" key={need.id}>
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
              {isStatus(need.status) ? <ConsoleStatus status={need.status} /> : null}
              <Link
                className="min-w-0 font-serif text-[15px] leading-snug underline-offset-4 hover:underline"
                href={`/operator/needs/${need.id}`}
              >
                {need.statement}
              </Link>
              {need.people === null ? null : (
                <span className="text-muted-foreground ml-auto font-mono text-xs tabular-nums">
                  {need.people} {need.people === 1 ? "person" : "people"}
                </span>
              )}
            </div>
            {need.accounts.length > 0 ? (
              <p className="text-muted-foreground text-[13px]">{need.accounts.join(", ")}</p>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
