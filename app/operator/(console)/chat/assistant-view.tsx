"use client";

import { useChat } from "@ai-sdk/react";
import { APICallError, DefaultChatTransport } from "ai";
import { ArrowRight, Search } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useRef, useState } from "react";

import { Pencil } from "@/app/_components/signal/pencil";
import { Button } from "@/components/button";
import { LoadingLine } from "@/components/loading-line";
import { ReportView } from "@/components/report/report-view";

import { ConsoleHeading } from "../_components/console-bits";
import { isProposeTool, SHOW_DATA_TOOL } from "../_lib/assistant";
import type { AssistantUIMessage, ProposeOutput, ShowDataOutput } from "../_lib/assistant";
import { toolSourceLine } from "../_lib/chat";
import { ActionCard } from "./action-card";
import { AnswerProse } from "./chat-view";

/**
 * The experimental Operator assistant (spec 014 → UI): the spec 006 question → pencil answer
 * layout over `useChat`, with inline report views, action cards, and a warnings line. The
 * conversation lives in the page, unsaved.
 */

const sampleQuestion = "What are enterprise accounts blocked on?";
const SESSION_ENDED = "Your Operator session has ended. Sign in again on the access page.";

/** The route's limits (40 messages, 256 KB): send the newest messages that fit. */
const MAX_MESSAGES = 40;
const MAX_BODY_BYTES = 240 * 1024;

const bodySize = (messages: AssistantUIMessage[]) =>
  new TextEncoder().encode(JSON.stringify({ messages })).byteLength;

const recentMessages = (messages: AssistantUIMessage[]) => {
  let recent = messages.slice(-MAX_MESSAGES);
  while (recent.length > 1 && bodySize(recent) > MAX_BODY_BYTES) recent = recent.slice(1);
  return recent;
};

const transport = new DefaultChatTransport<AssistantUIMessage>({
  api: "/api/operator/assistant",
  prepareSendMessagesRequest: ({ messages }) => ({
    body: { messages: recentMessages(messages) },
  }),
});

/** The `code` of a JSON error body (`jsonError`'s shape), if any. */
const codeOf = (body: string | undefined): unknown => {
  try {
    const { code } = JSON.parse(body ?? "{}") as { code?: unknown };
    return code;
  } catch {
    return undefined;
  }
};

const failureText = (error: Error) => {
  if (!APICallError.isInstance(error))
    return "The assistant could not answer right now. Try again in a moment.";
  const { statusCode: status } = error;
  if (status === 401 || status === 403) return SESSION_ENDED;
  if (codeOf(error.responseBody) === "chat_unavailable")
    return "The Operator agent can’t answer right now: the AI model is unavailable. The Needs table has the same numbers.";
  if (status === 404) return "The assistant is turned off. Reload the page for Chat.";
  return "Something went wrong. Try again in a moment.";
};

type Part = AssistantUIMessage["parts"][number];

interface ToolPart {
  input: unknown;
  name: string;
  output: unknown;
  state: string;
  toolCallId: string;
}

const toolPartOf = (part: Part): ToolPart | null => {
  if (part.type === "dynamic-tool")
    return {
      input: part.input,
      name: part.toolName,
      output: "output" in part ? part.output : undefined,
      state: part.state,
      toolCallId: part.toolCallId,
    };
  if (!part.type.startsWith("tool-") || !("toolCallId" in part)) return null;
  return {
    input: part.input,
    name: part.type.slice("tool-".length),
    output: "output" in part ? part.output : undefined,
    state: part.state,
    toolCallId: part.toolCallId,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface Turn {
  answer: AssistantUIMessage | null;
  question: string;
  id: string;
}

const turnsOf = (messages: AssistantUIMessage[]): Turn[] => {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const question = message.parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
        .trim();
      turns.push({ answer: null, id: message.id, question });
    } else if (message.role === "assistant") {
      const last = turns.at(-1);
      if (last && !last.answer) last.answer = message;
      else turns.push({ answer: message, id: message.id, question: "" });
    }
  }
  return turns;
};

/** Question → pencil answer with linked needs, views, and action cards; no chat bubbles. */
export function AssistantView() {
  const { error, messages, sendMessage, status } = useChat<AssistantUIMessage>({ transport });
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const lastRef = useRef<HTMLDivElement>(null);
  const busy = status === "submitted" || status === "streaming";
  const turns = turnsOf(messages);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    void sendMessage({ text: trimmed });
    requestAnimationFrame(() =>
      lastRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <ConsoleHeading marker="Experimental" title="Chat">
        Ask about demand, see it charted, and confirm changes. Nothing changes until you confirm.
      </ConsoleHeading>

      {turns.length > 0 ? (
        <div className="flex flex-col gap-10" data-testid="chat-thread">
          {turns.map((turn, index) => {
            const last = index === turns.length - 1;
            return (
              <div className="flex flex-col gap-4" key={turn.id} ref={last ? lastRef : undefined}>
                {turn.question ? (
                  <div>
                    <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase">
                      You asked
                    </p>
                    <p className="mt-1 font-serif text-xl leading-snug">{turn.question}</p>
                  </div>
                ) : null}
                <AssistantAnswer
                  busy={busy}
                  message={turn.answer}
                  onSend={send}
                  waiting={last && busy}
                />
                {last && error ? <Failure message={failureText(error)} /> : null}
              </div>
            );
          })}
        </div>
      ) : null}

      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-center"
        onSubmit={(event) => {
          event.preventDefault();
          send(input);
          setInput("");
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

function Failure({ message }: { message: string }) {
  return (
    <p className="text-destructive text-sm" role="alert">
      {message}
      {message === SESSION_ENDED ? (
        <>
          {" "}
          <Link className="underline underline-offset-4" href="/operator/access">
            Operator access
          </Link>
        </>
      ) : null}
    </p>
  );
}

/**
 * A tool part as an answer item: a report view or an action card, `"read"` for the source line,
 * or `null` for nothing to show (still running; `show_data` issues the model repairs; a refused
 * proposal, which has nothing to confirm).
 */
const toolItem = (
  tool: ToolPart,
  busy: boolean,
  onSend: (text: string) => void,
): ReactNode | "read" => {
  const done = tool.state === "output-available";
  if (tool.name === SHOW_DATA_TOOL) {
    const view = tool.output as ShowDataOutput;
    if (!done || !isRecord(view) || !("spec" in view)) return null;
    return (
      <div className="flex min-w-0 flex-col gap-3" data-testid="chat-view" key={tool.toolCallId}>
        <ReportView asOf={view.asOf} data={view.data} spec={view.spec} />
        <p className="m-0 text-[13px]">
          <button
            className="text-muted-foreground decoration-input hover:text-foreground underline underline-offset-4 disabled:opacity-50"
            disabled={busy}
            onClick={() => onSend("Save this as a report")}
            type="button"
          >
            Save as report
          </button>
        </p>
      </div>
    );
  }
  if (!isProposeTool(tool.name)) return "read";
  const output = tool.output as ProposeOutput;
  if (!done || !isRecord(output) || "error" in output) return null;
  if (!("actionId" in output))
    return (
      <p className="text-muted-foreground text-[13px]" key={tool.toolCallId}>
        This proposal is no longer available.
      </p>
    );
  return (
    <ActionCard
      busy={busy}
      input={isRecord(tool.input) ? tool.input : undefined}
      key={tool.toolCallId}
      onSend={onSend}
      output={output}
    />
  );
};

/**
 * One assistant message in order: runs of text as pencil prose, `show_data` as an inline report,
 * `propose_*` as action cards; reads collapse into the "Read: …" line, warnings sit under it.
 */
function AssistantAnswer({
  busy,
  message,
  onSend,
  waiting,
}: {
  busy: boolean;
  message: AssistantUIMessage | null;
  onSend: (text: string) => void;
  /** This is the turn being answered. */
  waiting: boolean;
}) {
  const items: ReactNode[] = [];
  const sources: { input: unknown; name: string }[] = [];
  const figures: string[] = [];
  let text = "";
  let proseCount = 0;

  const flushText = (key: string) => {
    if (!text.trim()) return;
    items.push(
      <Pencil
        key={key}
        label={proseCount === 0 ? "Answer · AI, not reviewed" : "AI, not reviewed"}
        state="suggested"
      >
        <AnswerProse text={text} />
      </Pencil>,
    );
    proseCount += 1;
    text = "";
  };

  for (const [index, part] of (message?.parts ?? []).entries()) {
    const tool = toolPartOf(part);
    if (part.type === "text") text += part.text;
    else if (part.type === "data-warnings") figures.push(...part.data.figures);
    else if (tool) {
      const item = toolItem(tool, busy, onSend);
      if (item === "read") sources.push({ input: tool.input, name: tool.name });
      else if (item) {
        flushText(`text-${index}`);
        items.push(item);
      }
    }
  }
  flushText("text-end");

  return (
    <div className="flex flex-col gap-6" data-testid="chat-answer">
      {items}
      {waiting && items.length === 0 ? <LoadingLine>Reading demand…</LoadingLine> : null}
      {figures.length > 0 ? (
        <p className="text-muted-foreground text-[13px]" data-testid="chat-warnings">
          Figures not found in the data: <span className="font-mono">{figures.join(", ")}</span>
        </p>
      ) : null}
      {sources.length > 0 ? (
        <p
          className="text-muted-foreground font-mono text-[11px] break-words"
          data-testid="chat-sources"
        >
          Read: {toolSourceLine(sources)}
        </p>
      ) : null}
    </div>
  );
}
