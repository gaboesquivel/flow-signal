"use client";

import { useQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

import { createSignalClient } from "@/lib/signal/client";
import type { SignalClient, SignalResult } from "@/lib/signal/client";

/** Same-origin client: the browser sends the PM's HttpOnly session cookie with every call. */
export const browserSignal: SignalClient = createSignalClient();

/** React Query keys shared by the console's pages and its top bar. */
export const pendingCountKey = ["operator", "pending-count"] as const;
export const needDetailPrefix = ["operator", "need-detail"] as const;
export const needDetailKey = (id: string) => [...needDetailPrefix, id] as const;
export const operatorNeedsKey = ["operator", "needs", "all"] as const;

/** After any console write: the Triage count, need details, and the needs table may change. */
export const invalidateAfterWrite = (queryClient: QueryClient) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: pendingCountKey }),
    queryClient.invalidateQueries({ queryKey: needDetailPrefix }),
    queryClient.invalidateQueries({ queryKey: operatorNeedsKey }),
  ]);

/** A failed call, kept whole so the view can explain it. */
export class OperatorCallError extends Error {
  override readonly name = "OperatorCallError";
  readonly error: Extract<SignalResult<unknown>, { ok: false }>["error"];

  constructor(error: Extract<SignalResult<unknown>, { ok: false }>["error"]) {
    super(error.message);
    this.error = error;
  }
}

/** For React Query: the data, or throw the call's error. */
export const unwrap = async <T>(call: Promise<SignalResult<T>>): Promise<T> => {
  const result = await call;
  if (!result.ok) throw new OperatorCallError(result.error);
  return result.data;
};

/** One need's private view (get_need_detail), shared by every row that reads it. */
export function useNeedDetail(needId: string | null | undefined, enabled = true) {
  return useQuery({
    enabled: Boolean(needId) && enabled,
    queryFn: () => unwrap(browserSignal.getNeedDetail({ id: needId ?? "" })),
    queryKey: needDetailKey(needId ?? ""),
    staleTime: 30_000,
  });
}
