import type { SignalOperations } from "@/lib/signal/client";

/** Pure helpers for the submit wizard, kept apart from React so they are cheap to test. */

export type PreviewOutput = SignalOperations["preview_signal"]["output"];
export type PreviewMatch = PreviewOutput["matches"][number];
type SubmitInput = SignalOperations["submit_signal"]["input"];
export type SubmitOutput = SignalOperations["submit_signal"]["output"];

/** A need the submitter can add their voice to: a preview match or the need they came from. */
export type ChosenNeed = Pick<
  PreviewMatch,
  "demandBand" | "needId" | "statement" | "status" | "supporterCount"
> & { reason?: string };

export type Choice = { kind: "need"; needId: string } | { kind: "new" };

const MIN_PREVIEW_TITLE = 3;
export const MIN_NEW_NEED_STATEMENT = 10;
const MAX_MATCHES = 3;

/** Describe → Check → Details → Done; the step lives in the URL (`?step=`). */
export const wizardSteps = ["describe", "check", "details", "done"] as const;
export type WizardStep = (typeof wizardSteps)[number];

/** Describe can continue once there is a title of 3 characters and some words about it. */
export const describeReady = (title: string, body: string) =>
  title.trim().length >= MIN_PREVIEW_TITLE && body.trim().length > 0;

/**
 * Identifies the words that were checked. Check runs `preview_signal` once per key, so going
 * back and continuing again only checks again when the words changed.
 */
export const previewKey = (title: string, body: string) =>
  describeReady(title, body)
    ? JSON.stringify({ body: body.trim(), title: title.trim() })
    : undefined;

/** The `preview_signal` input for a key from `previewKey`. */
export const previewInput = (key: string) => JSON.parse(key) as { body: string; title: string };

/**
 * The matches Check lists, at most three: the need the person came from (from a need page's
 * "Add my voice") first, then the check's matches in order.
 */
export const checkOptions = (
  matches: readonly PreviewMatch[],
  pinned?: ChosenNeed,
): ChosenNeed[] => {
  const found = pinned && matches.find((match) => match.needId === pinned.needId);
  const first = found ?? pinned;
  const rest = matches.filter((match) => match.needId !== first?.needId);
  return [...(first ? [first] : []), ...rest].slice(0, MAX_MATCHES);
};

/**
 * The step to show for the one in the URL: a step whose inputs are missing (a reload, a pasted
 * URL) falls back to the last one that has them, and Done stays until the person starts over.
 */
export const visibleStep = (
  requested: WizardStep,
  { choice, described, done }: { choice: Choice | undefined; described: boolean; done: boolean },
): WizardStep => {
  if (done) return "done";
  if (requested === "describe" || !described) return "describe";
  if (requested === "check" || !choice) return "check";
  return "details";
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
  {
    idempotencyKey,
    previewId,
    trackingToken,
  }: { idempotencyKey: string; previewId?: string; trackingToken?: string },
): SubmitInput | undefined => {
  if (!choice) return;
  return {
    ...(trackingToken ? { trackingToken } : {}),
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

/** The localStorage key holding the token of the My signals link this device files under. */
const MY_LINK_KEY = "signal.myLink";

const TOKEN_PATTERN = /^[\w-]{16,128}$/u;

/** The token in a `/my/<token>` tracking URL, or undefined. */
export const tokenFromTrackingUrl = (trackingUrl: string): string | undefined => {
  let pathname = "";
  try {
    ({ pathname } = new URL(trackingUrl));
  } catch {
    // Not a URL: no token.
  }
  const token = /^\/my\/(?<token>[^/]+)\/?$/u.exec(pathname)?.groups?.token;
  return token && TOKEN_PATTERN.test(token) ? token : undefined;
};

type LinkStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

/**
 * Every read and write is guarded: private windows and blocked storage throw, and the wizard
 * works the same without a remembered link.
 */
export const readRememberedLink = (
  storage: Pick<Storage, "getItem"> | undefined,
): string | undefined => {
  let value: string | null | undefined;
  try {
    value = storage?.getItem(MY_LINK_KEY);
  } catch {
    // Blocked storage: no remembered link.
  }
  return value && TOKEN_PATTERN.test(value) ? value : undefined;
};

export const rememberLink = (storage: LinkStorage | undefined, token: string) => {
  try {
    storage?.setItem(MY_LINK_KEY, token);
  } catch {
    // Not remembered: the next submission gets a new link.
  }
};

export const forgetLink = (storage: LinkStorage | undefined) => {
  try {
    storage?.removeItem(MY_LINK_KEY);
  } catch {
    // Nothing to forget.
  }
};

/**
 * What Done says about the link: joined the remembered one, a first link, or a new link because
 * the remembered one no longer resolves.
 */
export const linkOutcome = (
  { linkReused }: Pick<SubmitOutput, "linkReused">,
  sentToken: string | undefined,
): "new" | "replaced" | "reused" => {
  if (linkReused) return "reused";
  return sentToken ? "replaced" : "new";
};
