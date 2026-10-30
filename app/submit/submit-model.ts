import type { SignalOperations } from "@/lib/signal/client";

/** Pure helpers for the submit form, kept apart from React so they are cheap to test. */

export type PreviewOutput = SignalOperations["preview_signal"]["output"];
export type PreviewMatch = PreviewOutput["matches"][number];
export type SubmitInput = SignalOperations["submit_signal"]["input"];
export type SubmitOutput = SignalOperations["submit_signal"]["output"];

/** A need the submitter can add their voice to: a preview match or the need they came from. */
export type ChosenNeed = Pick<
  PreviewMatch,
  "demandBand" | "needId" | "statement" | "status" | "supporterCount"
> & { reason?: string };

export type Choice = { kind: "need"; needId: string } | { kind: "new" };

export const MIN_PREVIEW_TITLE = 3;
export const MIN_NEW_NEED_STATEMENT = 10;
export const PREVIEW_DEBOUNCE_MS = 600;

/** Preview once the title is long enough; the body is optional context. */
export const previewQuery = (title: string, body: string) => {
  const trimmed = title.trim();
  return trimmed.length >= MIN_PREVIEW_TITLE ? { body: body.trim(), title: trimmed } : undefined;
};

/** Options to choose from: the latest matches, then a chosen or preselected need no longer in them. */
export const needOptions = (
  matches: readonly PreviewMatch[],
  pinned: readonly (ChosenNeed | undefined)[],
): ChosenNeed[] => {
  const options: ChosenNeed[] = [...matches];
  for (const need of pinned)
    if (need && !options.some((option) => option.needId === need.needId)) options.push(need);
  return options;
};

export interface SubmitFields {
  body: string;
  company: string;
  email: string;
  name: string;
  newStatement: string;
  title: string;
  urgency: "" | "low" | "medium" | "high";
  useCase: string;
}

const optional = (value: string) => value.trim() || undefined;

/** The `submit_signal` input for the form, or undefined when no target is chosen. */
export const toSubmitInput = (
  fields: SubmitFields,
  choice: Choice | undefined,
  { idempotencyKey, previewId }: { idempotencyKey: string; previewId?: string },
): SubmitInput | undefined => {
  if (!choice) return;
  return {
    body: fields.body.trim(),
    company: optional(fields.company),
    email: fields.email.trim(),
    idempotencyKey,
    name: optional(fields.name),
    previewId,
    target:
      choice.kind === "need"
        ? { needId: choice.needId }
        : { newNeed: { statement: fields.newStatement.trim() } },
    title: fields.title.trim(),
    urgency: fields.urgency || undefined,
    useCase: optional(fields.useCase),
  };
};

/**
 * Identifies one submit attempt. Retrying the same content reuses the idempotency key, so a
 * retry after a lost response returns the same signal; changing anything starts a new attempt.
 */
export const attemptFingerprint = (input: Omit<SubmitInput, "idempotencyKey">) =>
  JSON.stringify(input);

export const newIdempotencyKey = () => `web-${crypto.randomUUID()}`;

/** The tracking link on the origin the submitter is using. */
export const trackingLinkFor = (trackingUrl: string, origin: string) => {
  try {
    const { pathname } = new URL(trackingUrl);
    return `${origin}${pathname}`;
  } catch {
    return trackingUrl;
  }
};

/** A title for filing one of the preview's additional asks on its own. */
export const splitTitle = (ask: string) => {
  const trimmed = ask.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 197)}...` : trimmed;
};
