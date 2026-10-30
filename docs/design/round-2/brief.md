# Design round 2 — brief

Round 1 chose the **Ledger** family (`../round-1/a-ledger.html`): warm paper, deep indigo, hairline rules, serif need statements, Inter UI, mono numbers, AI in "pencil" that turns to "ink" when a person confirms it. Round 1's Instrument and Chorus were rejected as **too busy**.

Round 2 explores three **minimal** variants inside that family. Reuse Ledger's tokens, fonts, and pencil/ink rule exactly (copy the `:root`/theme variables from `../round-1/a-ledger.html`); variants differ in layout, flow, and density, not palette.

## Principles (from the user)

- **Minimalist, helps people get things done.** No bloat: every element earns its place. Fewer labels, fewer pills, fewer borders. One primary action per screen.
- Writing is welcome. We are not trying to stop people writing; we are preventing duplicate needs for the PM while gathering what the person experiences.
- The same taste applies to the **PM management console**.

## Submit: a wizard, not a live panel

No matches are shown while typing. The flow:

1. **Describe** — only the person's words. Fields: title "In a few words, what do you need?" (`title`, required) and "What's getting in the way? What were you trying to do?" (`body`, required). Example: title "Monthly PDF of the revenue dashboard", body "Our CFO wants a PDF of the revenue dashboard every month for the board pack. Today I screenshot six charts and paste them into slides." Primary: **Continue**.
2. **Check** — on Continue, `preview_signal` runs (show a short, calm loading state: "Looking for needs like yours…", ~1–2 s). Then: "Others may have asked for this already." Up to 3 matches, each given **enough room to read**: the need statement (serif), the AI-written public summary excerpt (pencil until PM-approved; approved summaries are ink), supporter count and status, and a one-line "why it matches" (pencil). Plus the AI's restatement of *their* need ("Your need, as we understand it: …", pencil). Choice: **Add my voice to this need** (select one) or **None of these — it's a new need**. If the AI found a second ask, a quiet line offers to submit it separately.
3. **Details** — what lands where: "Adding your voice to: <need>" or "New need: <draft statement>" with a Change link. Fields: "How does this affect you?" (`useCase`, optional, 1–2 lines, placeholder "e.g. board pack every month, ~2 hours of manual work"), urgency (Low/Medium/High, optional), email (required), name and company (optional). Note: "Your words are kept as you wrote them and shown only to the product team. Your email is never public." Primary: **Add my voice** / **Submit new need**.
4. **Done** — "Thanks, Dana. Your voice was added to …" + the private My signals link (copy button) and "No email is sent; keep this link." Secondary: back to the board.

System rules to respect: there are **no comments or file attachments** in the MVP. Adding your voice creates a **signal** on the existing need: the person's title, body, use case, and urgency are kept verbatim and shown to PMs; the public sees only the supporter count and an anonymized, PM-approved summary. Submitters are not signed in.

Match content (step 2):
- Match 1 (best): "Executives need to share dashboard snapshots outside the product so that board meetings use current numbers" · Open · 11 people · Summary (approved, ink): "Leaders want current dashboard numbers in board and leadership meetings without rebuilding slides by hand." · Why (pencil): "Same problem: getting current dashboard numbers into board meetings. You asked for a PDF; others asked for PDF or email."
- Match 2: "Managers need to receive key dashboards on a schedule so that they act on numbers without logging in" · Planned · 12 people · Decision note: "Scheduled delivery is planned for the next quarter, starting with weekly email." · Why: "Related: a monthly PDF could arrive on a schedule, but this need is about managers acting on numbers, not board packs."
- Match 3: "Compliance teams need to archive monthly reports so that audits have a fixed record" · New · 1 person · no summary yet · Why: "Also asks for a monthly PDF, but to keep a fixed audit record."
- AI restatement (pencil): "Finance leaders need to share current dashboard numbers in the board pack so that the board sees this month's revenue."

## Public board (`/`)

Minimal: search, a quiet status filter, a ruled list of needs (statement, status word, people count). Content: the six needs from `../round-1/brief.md`.

## PM management console

Same taste. Render two screens:

- **Triage** (`/operator/triage`): the suggestion queue from `../round-1/brief.md` (merge, draft need with Dana's verbatim quote, priority score with one PM override, public summary for the compliance need, one resolved item). Accept / Edit / Reject per item, quiet; keyboard hints allowed if they stay unobtrusive.
- **Needs** (`/operator/needs`): the management board — every need as a ruled row: statement, theme, status, people, accounts, ARR of requesting accounts, priority score (e.g. 3.8), pending-suggestion marker. Sort by priority. Data: need #1 (11 people, 4 accounts, $1.07M ARR, 4.1), Scheduled delivery (12, 5, $1.18M, 4.0, Planned), CRM sync (12, 6, $1.30M, 3.9, In progress), Chat alerts (9, 5, $132k, 3.1), Pivot (10, 4, $852k, 3.4, Shipped), Compliance archive (1, 1, $480k, —, New, 2 suggestions pending).

## Render requirements (each variant, one HTML file)

- Header block: variant name, one-line idea, how it serves the principles, risks.
- Submit wizard: **all four steps** at desktop (1280) and phone (390), light. Step 2 also in dark at desktop.
- Public board: desktop + phone, light.
- Triage and Needs: desktop light + desktop dark; triage also at phone.
- Reuse the round-1 mark and wordmark.
- Self-contained; Google Fonts only; inline SVG icons (Lucide style).
