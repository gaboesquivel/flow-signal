# Signal — design

Product goals, users, and journeys live in [PRODUCT.md](./PRODUCT.md); this file is the visual and interaction direction every surface follows.

## Purpose and expression

Signal is a ledger of what customers need. It should feel calm, exact, and quick: a customer files a request in a minute without being talked out of writing, and a PM reviews and decides without organizing.

- **Lean, goal-first.** Every screen has one job and one primary action. If an element doesn't help the person finish that job, it goes. No dashboards for their own sake, no decoration.
- **AI proposes, people decide — visibly.** AI output is written in *pencil*; a person's confirmation turns it to *ink*. The difference is visible everywhere, with one treatment.
- **People's words are kept.** Customer text is shown verbatim, as quotes, never blended with AI text.

## Identity

- **Name:** Signal. Wordmark set in Newsreader Semibold.
- **Mark:** three short rules; the outer two converge into the middle one, which continues as one line — many voices into one need. Never resembles Wi‑Fi/cell bars, RSS, or a speech bubble.
- **Assets:** `public/brand/mark.svg` (mark, `currentColor`), `app/icon.svg` (favicon: white mark on an indigo `#4a42a0` tile, legible on light and dark tabs). Both draw the same three paths on a 32×32 grid; change them together.

## Tokens

Defined once in `styles/globals.css` (`:root` light, `.dark` dark) with shadcn names; Tailwind utilities come from `@theme inline`.

| Role | Token | Light | Dark |
| --- | --- | --- | --- |
| Paper | `background` | `#f7f7f2` | `#141614` |
| Ink | `foreground` | `#1e2320` | `#e8e7de` |
| Primary action, selection | `primary` | `#4a42a0` | `#aaa4f2` |
| Secondary text | `muted-foreground` | `#5b635d` | `#a2a9a3` |
| Hairline rules | `border` | `#dad8cc` | `#33362f` |
| Ink rule (confirmed, selected) | `rule-strong` | `#1e2320` | `#e8e7de` |
| Customer quote rule | `quote-rule` | `#1e2320` | `#e8e7de` |
| AI pencil rule | `ai` | `#8f89bb` | `#7a75a6` |
| AI pencil text | `ai-foreground` | `#534e78` | `#c0bbe0` |
| AI loading/working surface | `ai-surface` | `#f1f0f6` | `#1d1c26` |
| Status: New / Open / Planned / In progress / Shipped / Declined | `status-*` | `#5b635d` `#23698a` `#4a42a0` `#8a5700` `#2c6a37` `#a3261b` | `#a2a9a3` `#7cc0de` `#b3adf6` `#e2b35a` `#8ccf96` `#f0897c` |
| Demand high / medium / low | `demand-*` | `#1e2320` `#5b635d` `#a7aca5` | `#e8e7de` `#a2a9a3` `#4e534d` |

Radius `0.375rem`. Status is always a word plus a small shape, never colour alone.

## Type

- **Newsreader** (`font-serif`, also `font-heading`): need statements, page headings, quotes, AI labels in italic small caps.
- **Inter** (`font-sans`): interface text, forms, buttons. Body 15px public, 14px console.
- **JetBrains Mono** (`font-mono`): counts, scores, dates, money, keyboard hints; tabular figures, right-aligned in tables.

## Layout and components

- **Ruled lists, not cards.** One-line rows separated by hairlines. Exactly one row expands inline to show what's needed to decide.
- **Side-by-side reading** is the one rich layout, used wherever someone judges "are these the same need?": submit step 2 (what you wrote ↔ the selected need) and merge suggestions (from ↔ into). On phone it stacks, need first.
- **Pencil / ink:** pencil = 1.5px dashed `ai` left rule, `ai-foreground` text, italic small-caps label ("Suggested", "Why it matches", "Your need, as we understand it"). Ink = solid `rule-strong` left rule, normal text. Edited adds a small italic "edited by you"; rejected is struck and faded with its label at full contrast.
- **Quotes:** customer words in serif italic behind a solid `quote-rule`, with person · account · plan in muted text (PM only).
- **Actions:** one primary button per screen; secondary actions are ghost or text buttons. Console keyboard: J/K move, A accept, E edit, R reject, Esc cancel — hints in small muted mono.
- **Loading:** a calm one-line state ("Looking for needs like yours…") with a thin progress rule; no spinners over content.

## Surfaces

### Public

- **Board (`/`):** search, a quiet status filter, a ruled list (statement, status word, people count). No submitter, account, or verbatim text.
- **Submit (`/submit`)** — a wizard; nothing is suggested while typing:
  1. **Describe:** title and "What's getting in the way?". Continue.
  2. **Check:** after Continue, the duplicate check runs. A compact ruled list of up to 3 matches (first selected), then side-by-side: what you wrote with the AI restatement (pencil) ↔ the selected need (statement, approved summary or decision note, status, people, why it matches in pencil). Primary "Add my voice to this need"; text button "None of these — it's a new need". A second ask, if found, is offered as a separate submission in one quiet line.
  3. **Details:** where it lands ("Adding your voice to …" / "New need: …", Change), optional "How does this affect you?", urgency, email, optional name and company. "Your words are kept as you wrote them and shown only to the product team."
  4. **Done:** where it landed and the private My signals link (Copy).
- **My signals (`/my/[token]`):** every signal filed under that link, newest first, each with its need's status and decision notes. **The link carries forward:** a submitter who already holds a link (remembered on the device, or pasted) files new requests onto it, so one person's signals collect on one page. Links are never grouped by email: emails are unverified.

### PM console (`/operator`)

Top bar: mark, Triage (count) · Needs · Criteria · Metrics · Chat.

- **Triage:** one ruled list of pending suggestions; one row open. Accept / Edit / Reject per kind (merge → pick target; draft need → statement; split → statement and signals; summary → text, with a check line for names, accounts, emails; theme → existing or new). Accepted merges keep "Undo merge" on the row and in the need's history. Ends in a calm "All caught up".
- **Needs:** ruled table sorted by priority (mono, right-aligned numbers: people, accounts, ARR, score), theme/status filters, a pencil "n pending" marker; a row expands to top verbatim signals and the score breakdown.
- **Need → decide:** need detail with every signal verbatim, merge history, priority breakdown (PM overrides one criterion with a required note) → Draft decision brief (pencil) → edit → Decide side by side (brief ↔ status and public note) → Publish → confirmation of what supporters see.
- **Criteria:** four weights summing to 1.00; a preview list re-ranks live before Save; Undo after Save.
- **Metrics:** a few large mono numbers with one-line definitions; people and agents counted separately; unknown baselines say so. No chart unless it shows something the number doesn't.
- **Chat:** question, then a pencil answer with linked needs and accounts and a cited-needs list. No chat bubbles.

## Avoid

Boxed cards for list items, badge/pill clutter, sparkles or purple gradients for AI, live suggestions while someone is typing, more than one primary action per screen, colour-only status.

## Checking rendered output

- Every AI-generated string renders in pencil until a PM resolves it; confirmed text renders in ink.
- Public pages show no submitter name, email, company, account, revenue, or verbatim text of others.
- Light and dark both pass WCAG AA for text; check the status and pencil colours in both.
- At 390px wide nothing scrolls sideways; side-by-side layouts stack.
- Favicon (`app/icon.svg`) and `public/brand/mark.svg` show the same mark.
