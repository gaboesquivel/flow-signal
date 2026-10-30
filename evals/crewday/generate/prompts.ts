import { z } from "zod";

import type { Account, Need, Persona, Recipe } from "../format";
import type { Slot } from "./plan";
import { sha256 } from "./llm";

/**
 * Prompt templates for writing signal text (spec 004 → generation step 2). The model sees a
 * persona and a scenario (the need's `who`, `problem`, and one of its `scenarios`), optionally a
 * solution the persona has in mind, and how to frame the ask. It never sees a need statement.
 */

export const WRITER_INSTRUCTIONS = `You write realistic product feedback that people send to Crewday, a fictional B2B SaaS company that sells shift scheduling, time and attendance, payroll exports, compliance, integrations, and a mobile app for frontline teams. Everyone and everything is fictional.

You get a list of submissions to write. Each has a persona (role, writing style, company) and a situation from their work week. Write each submission as that person would type it into a feedback form: a title and a body, plus a short use case when asked.

Rules:
- Write from the situation in your own words with fresh concrete details (a store, a shift, a day, a number). Never copy the situation text; vary wording between submissions in the list so no two read alike.
- Stay in the persona's writing style, including typos, missing punctuation, lowercase, non-native English, or mixed languages when the style says so. Keep it plausible, not a caricature.
- People describe their problem, not a product spec. Never write "X needs to Y so that Z".
- Title: what the person would type as a subject line, at most 12 words (terse styles may be 2-4 words).
- Body: 1 to 6 sentences, longer only for rambling styles. Plain text.
- Framing per item:
  - "plain": describe the situation and what they wish they could do. If a solution is given, the person names it as what they want; otherwise they do not name a feature.
  - "symptom": describe only what goes wrong and how it hurts. Do not ask for a feature or suggest a fix.
  - "same_solution": the person asks for the given solution by name, and their situation shows why they want it.
  - "multi_ask": one submission that raises both situations (the first is the main ask), as two asks in one note.
- If an item lists details to include, include each of them exactly as written (they come from a support ticket or the person's own message).
- useCase: when asked, one short phrase (3-12 words) in the persona's voice about the job they are trying to get done; otherwise null.
- Return every item with its id unchanged.`;

export const STRICT_ADDENDUM = `
Extra rule for this list: each item gives words to avoid. Do not use those words or close variants of them, and do not name any product feature, export, report, or integration. Describe the situation through what happened and its consequences, the way a person who does not know the product's vocabulary would.`;

export const promptsHash = () => sha256(`${WRITER_INSTRUCTIONS}\n---\n${STRICT_ADDENDUM}`);

export const writtenSchema = z.object({
  items: z.array(
    z.object({
      body: z.string(),
      id: z.string(),
      title: z.string(),
      useCase: z.string().nullable(),
    }),
  ),
});
export type Written = z.infer<typeof writtenSchema>["items"][number];

const companyContext = (account: Account) =>
  `${account.name} (${account.plan} plan${account.arrCents === 0 ? ", a prospect evaluating Crewday" : ""})`;

export interface WriteContext {
  accounts: Account[];
  needs: Need[];
  personas: Persona[];
  recipe: Recipe;
}

const situation = (need: Need, scenario: string) =>
  `${need.who}. Their problem: ${need.problem} This week: ${scenario}`;

export const itemPrompt = (slot: Slot, context: WriteContext, avoid?: string[]) => {
  const persona = context.personas.find((p) => p.key === slot.personaKey);
  const account = context.accounts.find((a) => a.key === slot.accountKey);
  if (!persona || !account) throw new Error(`slot ${slot.slot}: unknown persona or account`);
  const style =
    context.recipe.personaMix.roles.find((role) => role.role === persona.role)?.writingStyle ?? "";
  const situations = slot.needKeys.map((key, index) => {
    const need = context.needs.find((n) => n.key === key);
    if (!need) throw new Error(`slot ${slot.slot}: unknown need ${key}`);
    return situation(need, slot.scenarios[index] ?? need.scenarios[0] ?? "");
  });
  return {
    company: companyContext(account),
    ...(slot.pii?.length ? { detailsToInclude: slot.pii } : {}),
    framing: slot.intent,
    id: String(slot.slot),
    persona: {
      name: persona.actorKind === "agent" ? "support copilot" : persona.name,
      role: persona.role,
      writingStyle: style,
    },
    situations,
    ...(slot.solution ? { solution: slot.solution } : {}),
    useCase: slot.useCase ? "write one" : "null",
    ...(avoid?.length ? { wordsToAvoid: avoid } : {}),
  };
};

export const batchPrompt = (items: ReturnType<typeof itemPrompt>[]) =>
  `Write these ${items.length} submissions. Input as JSON:\n${JSON.stringify(items, null, 1)}`;
