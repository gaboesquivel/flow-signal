import { eq, isNotNull } from "drizzle-orm";
import { z } from "zod";

import { accounts, needs, submitters } from "@/lib/db/schema";

import type { SignalQueryable } from "../db";
import { SignalError } from "../errors";

/**
 * Identifying-text check (spec 006 → check_public_text): before a PM approves a public summary
 * or publishes a decision note, flag submitter names, account names, and emails from the
 * workspace that appear in the text. Deterministic (no model) so the same text always gives the
 * same findings; findings warn, they never fail `publish_decision`.
 *
 * - Candidates: every submitter and account in the workspace, with or without `needId`
 *   (published text must not name any customer).
 * - Matching is case-insensitive. Names and accounts match as whole words (no letter or digit
 *   on either side); an account also matches without a legal suffix ("Acme Corp" → "Acme").
 *   A person matches by full name only: single first names collide with ordinary words.
 * - A match inside a longer one (the account inside an email) is reported once, as the longer
 *   match. Repeats are reported once, in order of first appearance, with the text's own casing.
 */

const findingKinds = ["person", "account", "email"] as const;
type FindingKind = (typeof findingKinds)[number];

export const publicTextFindingSchema = z.object({
  kind: z.enum(findingKinds),
  /** The text as it appears in the checked text. */
  match: z.string(),
});
type PublicTextFinding = z.infer<typeof publicTextFindingSchema>;

export const MAX_PUBLIC_TEXT_LENGTH = 10_000;

interface IdentifyingCandidate {
  kind: FindingKind;
  value: string;
}

const legalSuffix =
  /[\s,]+(?:inc|incorporated|corp|corporation|co|company|ltd|limited|llc|plc|gmbh|ag|sa|sas|bv|pty)\.?$/iu;

/** Shorter forms a candidate may appear under (an account without its legal suffix). */
const aliasesOf = ({ kind, value }: IdentifyingCandidate) => {
  const trimmed = value.trim();
  if (kind !== "account") return [trimmed];
  const core = trimmed.replace(legalSuffix, "").trim();
  return core && core !== trimmed ? [trimmed, core] : [trimmed];
};

const escapeRegExp = (value: string) => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Whole-word for names; an email may not continue into more address characters. */
const patternFor = (kind: FindingKind, value: string) => {
  const body = escapeRegExp(value).replaceAll(/\s+/gu, "\\s+");
  return kind === "email"
    ? new RegExp(`(?<![\\p{L}\\p{N}._%+-])${body}(?![\\p{L}\\p{N}_-])`, "giu")
    : new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, "giu");
};

/** Minimum length of a name or account to look for; shorter strings are noise. */
const MIN_CANDIDATE_LENGTH = 2;

export const findIdentifyingText = (
  text: string,
  candidates: readonly IdentifyingCandidate[],
): PublicTextFinding[] => {
  const lowered = text.toLowerCase();
  const spans: { end: number; kind: FindingKind; start: number }[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates)
    for (const alias of aliasesOf(candidate)) {
      const key = `${candidate.kind}:${alias.toLowerCase()}`;
      if (alias.length < MIN_CANDIDATE_LENGTH || seen.has(key)) continue;
      seen.add(key);
      // Cheap prefilter before building a regex (whitespace inside names may differ).
      const firstWord = alias.toLowerCase().split(/\s+/u)[0] ?? "";
      if (!lowered.includes(firstWord)) continue;
      for (const match of text.matchAll(patternFor(candidate.kind, alias)))
        spans.push({
          end: match.index + match[0].length,
          kind: candidate.kind,
          start: match.index,
        });
    }

  // Longest first at each position; drop any span overlapping one already kept.
  const kept: typeof spans = [];
  for (const span of spans.toSorted((a, b) => a.start - b.start || b.end - a.end))
    if (!kept.some((other) => span.start < other.end && other.start < span.end)) kept.push(span);

  const findings: PublicTextFinding[] = [];
  const reported = new Set<string>();
  for (const span of kept.toSorted((a, b) => a.start - b.start)) {
    const match = text.slice(span.start, span.end);
    const key = `${span.kind}:${match.toLowerCase().replaceAll(/\s+/gu, " ")}`;
    if (reported.has(key)) continue;
    reported.add(key);
    findings.push({ kind: span.kind, match });
  }
  return findings;
};

/**
 * Names, accounts, and emails to look for: always every submitter and account in the workspace,
 * because published text must not name any customer, not only the need's own supporters (spec 006
 * → `check_public_text`). A given `needId` is only checked to exist.
 */
const loadCandidates = async (
  db: SignalQueryable,
  needId: string | undefined,
): Promise<IdentifyingCandidate[]> => {
  if (needId) {
    const [need] = await db.select({ id: needs.id }).from(needs).where(eq(needs.id, needId));
    if (!need) throw new SignalError("not_found", `No need with id ${needId}.`);
  }
  const people = await db
    .select({ email: submitters.email, name: submitters.name })
    .from(submitters);
  const accountRows = await db
    .select({ name: accounts.name })
    .from(accounts)
    .where(isNotNull(accounts.name));
  const accountNames = [
    ...new Set(accountRows.map((row) => row.name).filter((name): name is string => Boolean(name))),
  ];
  return [
    ...people.flatMap((person): IdentifyingCandidate[] => [
      { kind: "email", value: person.email },
      ...(person.name ? [{ kind: "person" as const, value: person.name }] : []),
    ]),
    ...accountNames.map((name): IdentifyingCandidate => ({ kind: "account", value: name })),
  ];
};

export const checkPublicText = async (
  db: SignalQueryable,
  { needId, text }: { needId?: string; text: string },
) => ({ findings: findIdentifyingText(text, await loadCandidates(db, needId)) });
