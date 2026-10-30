"use client";

import { useEffect, useState } from "react";

import { createSignalClient } from "@/lib/signal/client";
import type { SignalClientError } from "@/lib/signal/client";

import { PREVIEW_DEBOUNCE_MS, previewQuery } from "./submit-model";
import type { PreviewOutput } from "./submit-model";

/** The browser's Signal client: relative URLs on this origin, through the public REST API. */
export const signalClient = createSignalClient();

type Settled =
  | { data: PreviewOutput; status: "ready" }
  | { error: SignalClientError; status: "error" };

export type PreviewState =
  | { status: "idle" }
  | { previous?: PreviewOutput; status: "loading" }
  | Settled;

/**
 * `preview_signal` for the current title and body, debounced while the person types. A newer
 * text aborts the older request; the last matches stay visible while the next ones load.
 */
export const usePreview = (title: string, body: string): PreviewState => {
  const [settled, setSettled] = useState<{ key: string; state: Settled }>();
  const query = previewQuery(title, body);
  const key = query ? JSON.stringify(query) : "";

  useEffect(() => {
    if (!key) return;
    const input = JSON.parse(key) as { body: string; title: string };
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const result = await signalClient.previewSignal(input, { signal: controller.signal });
        setSettled({
          key,
          state: result.ok
            ? { data: result.data, status: "ready" }
            : { error: result.error, status: "error" },
        });
      } catch {
        // Aborted: a newer text replaced this preview.
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key]);

  if (!key) return { status: "idle" };
  if (settled?.key === key) return settled.state;
  return {
    previous: settled?.state.status === "ready" ? settled.state.data : undefined,
    status: "loading",
  };
};
