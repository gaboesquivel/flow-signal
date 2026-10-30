# Design round 1 — brief

## Surface and purpose

Signal has two surfaces that must read as one product:

1. **Public board + submit** (customers, support/sales staff): *complete a task* — describe a need, see AI-matched existing needs with reasons, add their voice or submit new. Also browse the board.
2. **Operator console** (PMs): *decide and act* — review AI suggestions (draft needs, merges, themes, public summaries, priority scores), accept / edit / reject, publish decisions.

## What the design must convey

- **AI proposes, people decide.** An AI suggestion must look visibly different from a human-confirmed fact, everywhere, with one consistent treatment. Accepted, edited, and rejected states are distinct.
- **Customers' own words are kept.** Verbatim signals (quotes) are first-class, not hidden.
- **Demand is legible at a glance**: supporter count and demand band (high / medium / low); status follows a need's life (New → Open → Planned → In progress → Shipped / Declined).
- Calm, trustworthy, fast. A tool used daily by PMs; a page a customer uses once in a while.

## Constraints

- Next.js + Tailwind v4 + shadcn (`base-nova`), theme as CSS variables in `styles/globals.css` (shadcn token names: background, foreground, card, primary, secondary, muted, accent, destructive, border, input, ring, chart-1..5, sidebar-*). Light and dark themes both required.
- WCAG AA contrast for text; status never conveyed by colour alone.
- Renders at phone (390 px) and desktop (1280 px). Lucide icons.
- Fonts from Google Fonts only.

## Avoid

- Generic "AI" clichés: sparkles, purple gradients, glowing orbs.
- Marks that read as Wi‑Fi / cell-signal / RSS / podcast icons or the Signal messenger logo (blue speech bubble).
- Dashboard noise; decoration that competes with the text.

## Shared content (use exactly, every direction)

### Screen 1a — Public board (`/`)

Header: wordmark, nav "Board", primary button "Submit a request". Search field "Search needs", status filter chips: All, New, Open, Planned, In progress, Shipped, Declined. Theme filter: Reporting, Integrations, Administration and security, Collaboration.

Needs (statement · theme · status · supporters · demand · proposed solutions · public summary / decision):

1. "Executives need to share dashboard snapshots outside the product so that board meetings use current numbers" · Reporting · Open · 11 people · High demand · PDF export, Scheduled email digest · Summary: "Leaders want current dashboard numbers in board and leadership meetings without rebuilding slides by hand."
2. "Managers need to receive key dashboards on a schedule so that they act on numbers without logging in" · Reporting · Planned · 12 people · High demand · Scheduled email digest · Decision (Planned · Sep 30): "Scheduled delivery is planned for the next quarter, starting with weekly email."
3. "Revenue teams need CRM data to flow in automatically so that pipeline dashboards are never stale" · Integrations · In progress · 12 people · High demand · Salesforce connector, HubSpot connector · Decision (In progress · Oct 10): "A two-way CRM sync is in progress; beta opens next month."
4. "Operations teams need threshold alerts in their team chat so that they react before customers notice" · Integrations · Open · 9 people · Medium demand · Slack integration, Microsoft Teams integration
5. "Analysts need to break down metrics by two dimensions at once so that they find which segment drives a change" · Reporting · Shipped · 10 people · Medium demand · Decision (Shipped · Oct 18): "Two-level grouping shipped in the 4.2 release."
6. "Compliance teams need to archive monthly reports so that audits have a fixed record" · Reporting · New · 1 person · Low demand · PDF export

### Screen 1b — Submit with live duplicate check (`/submit`)

Fields: "What do you need?" textarea containing: "Our CFO wants a PDF of the revenue dashboard every month for the board pack." · Email "dana@acme.example" · Company "Acme" · Urgency (Low / Medium / High, Medium selected).

Live panel "Looks like these needs" (AI, updates while typing), 2 matches + "None of these":
- Match 1 (selected): need #1 above, 11 people · High demand. Why it matches: "Same problem: getting current dashboard numbers into board meetings. You asked for a PDF; others asked for PDF or email." 
- Match 2: need #6 (Compliance archive), New · 1 person. Why it matches: "Also asks for PDF export, but to keep a fixed audit record, not to share current numbers."
- "None of these — submit it as a new need. It shows as New on the board."
AI restatement shown above matches: "The underlying need: Finance leaders need to share current dashboard numbers in the board pack."
Primary button "Add my voice" (changes to "Submit new need" if None is chosen). Note: "Your words are kept and shown to the product team."

### Screen 2 — Operator triage (`/operator/triage`)

Operator shell: nav Triage (badge 5), Needs, Criteria, Metrics, Chat. Queue of AI suggestions, each with Accept / Edit / Reject:

1. **Merge suggestion** — merge "Board members need to see dashboards without an account" (2 signals) into need #1 (11 signals). Reason: "Both describe sharing current dashboard numbers with people outside the product." Confidence: High.
2. **Draft need** — from a new signal by Dana (Acme, Enterprise, $480k ARR): AI statement "Finance leaders need to share current dashboard numbers in the board pack so that the board sees this month's revenue." Verbatim quote: "Our CFO wants a PDF of the revenue dashboard every month for the board pack." Suggested theme: Reporting.
3. **Priority score** for need #4 (chat alerts): Demand 4/5 ("9 people across 5 accounts"), Business value 3/5 ("$132k ARR, no open deals"), Strategic fit 3/5 ("Integrations, weight 0.7"), Effort 2/5 (lower = harder) ("Two chat platforms"). Overall 3.1. One criterion shows a PM override: Strategic fit AI 3 → PM 4, "Ops is a Q1 focus".
4. **Public summary** for need #6 (compliance): "Compliance teams keep immutable monthly copies of reports for auditors." Check line: "No names, emails, or companies found."
5. An already-resolved item collapsed: "Theme 'Reporting' accepted · edited by you · 2h ago" — shows how accepted/edited looks after resolution.

## Each direction must render

- **Identity sheet**: wordmark in a header; mark at 16 px and 32 px (favicon), and 64 px; on light and dark backgrounds.
- **Screen 1a + 1b** at desktop (1280 wide frame) and phone (390 wide frame).
- **Screen 2** at desktop and phone.
- Light **and** dark: render each screen frame twice (light frame and dark frame side by side or stacked), using the same token names in both themes (scope tokens with `.theme-light` / `.theme-dark` wrappers).
- A token table at the end: every shadcn token with light and dark hex values, plus any extra semantic tokens (e.g. `--ai`, `--ai-foreground`, status colours, demand colours), and font choices.
