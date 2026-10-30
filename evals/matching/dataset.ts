/**
 * Matching eval set (spec 001 → Seed and eval, task 03): a fixture need catalog and labeled
 * submissions. The catalog reuses the seed's live needs (`lib/signal/seed/demo-data.ts`, same
 * keys and statements) plus a few needs that share solutions with them, so the set has hard
 * negatives. It is a fixture: edit it deliberately, never to make a run pass.
 *
 * Labels: `expected` lists every catalog need that is a correct match (any one shown counts as a
 * hit); empty means the submission is a new need and no match should be shown. Kinds:
 * - `paraphrase`: an existing need in other words, often naming a solution.
 * - `same_solution`: names a solution a catalog need also lists, but the underlying need is a
 *   different catalog need or a new one (matching is on the problem, not the solution).
 * - `multi_ask`: two asks in one submission; either ask's catalog need is a correct match and
 *   the extractor should return the second ask in `additionalAsks`.
 * - `new`: a need the catalog does not have, including off-topic noise.
 */

export type CaseKind = "multi_ask" | "new" | "paraphrase" | "same_solution";

export interface CatalogNeed {
  key: string;
  solutions: string[];
  statement: string;
}

export interface LabeledSubmission {
  body: string;
  expected: string[];
  id: string;
  kind: CaseKind;
  title: string;
}

export const catalog: CatalogNeed[] = [
  // From the seed (live needs; merged duplicates are not retrievable, so they are left out).
  {
    key: "n1",
    solutions: ["PDF export", "Scheduled email digest"],
    statement:
      "Executives need to share dashboard snapshots outside the product so that board meetings use current numbers",
  },
  {
    key: "n2",
    solutions: ["PDF export", "Report snapshots with retention"],
    statement:
      "Compliance teams need to archive monthly reports so that audits have a fixed record",
  },
  {
    key: "scheduled-delivery",
    solutions: ["Scheduled email digest"],
    statement:
      "Managers need to receive key dashboards on a schedule so that they act on numbers without logging in",
  },
  {
    key: "pivot",
    solutions: ["Pivot tables", "Multi-dimension grouping"],
    statement:
      "Analysts need to break down metrics by two dimensions at once so that they find which segment drives a change",
  },
  {
    key: "annotations",
    solutions: ["Chart annotations"],
    statement:
      "Analysts need to explain changes directly on charts so that teammates understand why numbers moved",
  },
  {
    key: "crm-sync",
    solutions: ["Salesforce connector", "HubSpot connector"],
    statement:
      "Revenue teams need CRM data to flow in automatically so that pipeline dashboards are never stale",
  },
  {
    key: "chat-alerts",
    solutions: ["Slack integration", "Microsoft Teams integration"],
    statement:
      "Operations teams need threshold alerts in their team chat so that they react before customers notice",
  },
  {
    key: "webhooks",
    solutions: ["Webhooks"],
    statement:
      "Developers need to be notified when data changes so that their systems stay in sync without polling",
  },
  {
    key: "warehouse",
    solutions: ["Snowflake connector", "BigQuery connector"],
    statement:
      "Data teams need to query their warehouse directly so that dashboards use one source of truth",
  },
  {
    key: "sso",
    solutions: ["SAML SSO", "Okta integration"],
    statement:
      "IT admins need to control sign-in through their identity provider so that access follows company policy",
  },
  {
    key: "permissions",
    solutions: ["Role-based access control", "Folder permissions"],
    statement:
      "Admins need to limit who can see each dashboard so that sensitive numbers stay with the right people",
  },
  {
    key: "audit-log",
    solutions: ["Audit log export"],
    statement:
      "Security teams need a record of who accessed and changed reports so that they can answer audit questions",
  },
  {
    key: "provisioning",
    solutions: ["SCIM provisioning"],
    statement:
      "IT admins need accounts created and removed automatically so that leavers lose access the same day",
  },
  {
    key: "co-editing",
    solutions: ["Real-time co-editing"],
    statement:
      "Teams need to edit dashboards together without overwriting work so that building reports is not serialized",
  },
  {
    key: "mentions",
    solutions: ["@mentions"],
    statement:
      "Analysts need to pull a colleague into a specific chart so that questions get answered in context",
  },
  {
    key: "dark-mode",
    solutions: ["Dark theme"],
    statement:
      "Operators need a low-glare display so that they can watch dashboards on wall screens all day",
  },
  {
    key: "mobile",
    solutions: ["Responsive dashboards", "Mobile app"],
    statement:
      "Field managers need to read dashboards on their phones so that they decide on the spot",
  },
  {
    key: "metric-layer",
    solutions: ["Semantic layer"],
    statement:
      "Analysts need one shared definition per metric so that every dashboard reports the same number",
  },
  {
    key: "sheets",
    solutions: ["Google Sheets connector"],
    statement:
      "Small teams need spreadsheet data to refresh automatically so that dashboards stay current without uploads",
  },
  {
    key: "freshness",
    solutions: ["Data freshness indicator"],
    statement:
      "Report readers need to know when data is stale so that they don't decide on yesterday's numbers",
  },
  {
    key: "embed",
    solutions: ["Embeddable charts"],
    statement:
      "Product teams need to show live charts inside their own app so that customers see their usage",
  },
  {
    key: "localization",
    solutions: ["Dashboard translations"],
    statement:
      "International teams need dashboards in their language so that local managers read them without help",
  },
  {
    key: "support-lookup",
    solutions: ["Support sidebar app"],
    statement:
      "Support agents need to see a customer's open requests while replying so that they set honest expectations",
  },
  // Eval-only needs: share solutions with the seed's needs to create hard negatives.
  {
    key: "csv-export",
    solutions: ["CSV export", "Excel export", "Google Sheets connector"],
    statement:
      "Analysts need the raw data behind a chart in a spreadsheet so that they can run their own ad-hoc analysis",
  },
  {
    key: "api-access",
    solutions: ["REST API"],
    statement:
      "Developers need to read metric values programmatically so that they can use the numbers in their own scripts and tools",
  },
  {
    key: "goal-tracking",
    solutions: ["Goals", "Target lines", "Chart annotations"],
    statement:
      "Managers need to compare metrics against targets so that they see whether the team is on pace",
  },
  {
    key: "white-label",
    solutions: ["White-labeling", "Custom themes"],
    statement:
      "Agencies need dashboards branded with their clients' logos and colors so that client reports look like their own work",
  },
  {
    key: "two-factor",
    solutions: ["Two-factor authentication", "Authenticator app"],
    statement:
      "Security teams need sign-ins to require a second factor so that a stolen password cannot open an account",
  },
  {
    key: "row-level-security",
    solutions: ["Row-level security", "Role-based access control"],
    statement:
      "Admins need each viewer of a shared dashboard to see only their own rows so that one dashboard serves everyone safely",
  },
  {
    key: "version-history",
    solutions: ["Version history"],
    statement:
      "Dashboard owners need to see and restore earlier versions so that an accidental change can be undone",
  },
];

type Row = [id: string, expected: string[], title: string, body: string];

const rows = (kind: CaseKind, list: Row[]): LabeledSubmission[] =>
  list.map(([id, expected, title, body]) => ({ body, expected, id, kind, title }));

const paraphrases = rows("paraphrase", [
  [
    "p01",
    ["n1"],
    "Board pack export",
    "Before every board meeting our CFO rebuilds the revenue charts in Keynote by hand. Let us send the board a snapshot of the dashboard directly.",
  ],
  [
    "p02",
    ["n1"],
    "Share numbers with investors who have no seat",
    "We send a monthly investor update and want to include the current KPI dashboard in a way that works without a login.",
  ],
  [
    "p03",
    ["n1"],
    "Leadership snapshot for the QBR",
    "Our VP of Sales wants to drop the live pipeline dashboard into the quarterly business review deck without screenshotting six charts.",
  ],
  [
    "p04",
    ["n2"],
    "Month-end report freeze",
    "Our auditors want to see the revenue recognition report exactly as it looked on the last day of each month, not today's version.",
  ],
  [
    "p05",
    ["n2"],
    "Keep compliance evidence",
    "For our SOC 2 audit we must retain an unchangeable copy of the monthly KPI report for every month of the audit period.",
  ],
  [
    "p06",
    ["scheduled-delivery"],
    "Weekly email of the sales dashboard",
    "Our regional managers never log in. Email them the sales dashboard every Monday at 8am so they see where they stand.",
  ],
  [
    "p07",
    ["scheduled-delivery"],
    "Daily digest",
    "Can I subscribe to a dashboard and get it in my inbox each morning? I don't want to open the app just to check three numbers.",
  ],
  [
    "p08",
    ["pivot"],
    "Group by two fields",
    "I need to see revenue by region and by plan at the same time, like a pivot table in Excel.",
  ],
  [
    "p09",
    ["pivot"],
    "Cross-tab support",
    "Charts only let me group by one column. I want churn split by segment and by acquisition channel to find which combination is driving it.",
  ],
  [
    "p10",
    ["annotations"],
    "Notes on charts",
    "When signups dropped last week I wanted to mark the outage right on the line chart so the team knows why.",
  ],
  [
    "p11",
    ["annotations"],
    "Explain spikes",
    "Let us add a label to a point on a chart, like 'pricing change', so whoever reads it later understands the jump.",
  ],
  [
    "p12",
    ["crm-sync"],
    "HubSpot integration",
    "We upload a CSV export from HubSpot every week to update our pipeline dashboard. Please connect to HubSpot directly.",
  ],
  [
    "p13",
    ["crm-sync"],
    "Salesforce opportunities are out of date",
    "Our pipeline numbers are always a few days behind because someone has to sync Salesforce manually.",
  ],
  [
    "p14",
    ["chat-alerts"],
    "Slack alert when a KPI crosses a limit",
    "Post in our #ops channel when the order error rate goes above 2%.",
  ],
  [
    "p15",
    ["chat-alerts"],
    "Teams notifications for thresholds",
    "We're on Microsoft Teams. When inventory falls below the reorder point, the warehouse channel should get a message right away.",
  ],
  [
    "p16",
    ["webhooks"],
    "Webhook on data change",
    "We want our backend to get a callback whenever a metric is updated instead of polling your API every minute.",
  ],
  [
    "p17",
    ["webhooks"],
    "Push changes to our ERP",
    "When a dataset refreshes, our ERP needs to know so orders stay consistent. Today we poll on a cron job and miss changes.",
  ],
  [
    "p18",
    ["warehouse"],
    "Snowflake connector",
    "All our data is in Snowflake. Copying it into your tool creates a second version of the truth.",
  ],
  [
    "p19",
    ["warehouse"],
    "Query BigQuery live",
    "Let dashboards run directly against BigQuery so finance and product see the same numbers.",
  ],
  [
    "p20",
    ["sso"],
    "Okta login",
    "Our IT policy requires every SaaS tool to use Okta for sign-in. We can't roll out to more teams until you support it.",
  ],
  [
    "p21",
    ["sso"],
    "SAML with Azure AD",
    "We need SAML single sign-on with Azure AD before security will approve the purchase.",
  ],
  [
    "p22",
    ["permissions"],
    "Hide the payroll dashboard",
    "Everyone in the workspace can see the payroll dashboard. We need to restrict it to the finance team.",
  ],
  [
    "p23",
    ["permissions"],
    "Folder-level access",
    "Let me put sensitive dashboards in a folder that only the leadership team can open.",
  ],
  [
    "p24",
    ["audit-log"],
    "Who looked at the revenue report",
    "Our security team must be able to show which users opened the customer revenue report last quarter.",
  ],
  [
    "p25",
    ["audit-log"],
    "Export access logs",
    "We need an exportable log of logins, views and edits to feed into our SIEM for the yearly audit.",
  ],
  [
    "p26",
    ["provisioning"],
    "SCIM support",
    "When someone leaves, their account stays active until an admin remembers to remove it. Please support SCIM.",
  ],
  [
    "p27",
    ["provisioning"],
    "Auto-create users from HR",
    "New hires should get an account automatically on their first day, and leavers should lose it on their last.",
  ],
  [
    "p28",
    ["co-editing"],
    "Two people editing at once",
    "My colleague and I edited the same dashboard and her changes wiped mine. We need to work on it together.",
  ],
  [
    "p29",
    ["co-editing"],
    "Google Docs-style editing",
    "Let several analysts build one dashboard at the same time and see each other's changes live.",
  ],
  [
    "p30",
    ["mentions"],
    "@mention on a chart",
    "I want to tag Priya on the conversion chart and ask why March looks off, right there on the chart.",
  ],
  [
    "p31",
    ["mentions"],
    "Ask a teammate about a number",
    "Today I paste screenshots into Slack to ask about a chart and the context gets lost. Let me loop someone in on the chart itself.",
  ],
  [
    "p32",
    ["dark-mode"],
    "Dark theme for the NOC screens",
    "Our operations center has dashboards on TVs 24/7 and the white background is harsh.",
  ],
  [
    "p33",
    ["dark-mode"],
    "Night mode please",
    "Staring at the bright dashboards on the wall display for a whole night shift is tiring. Please add a dark mode.",
  ],
  [
    "p34",
    ["mobile"],
    "Phone app for store managers",
    "Our store managers walk the floor all day and need to check today's sales on their phones.",
  ],
  [
    "p35",
    ["mobile"],
    "Dashboards are unreadable on mobile",
    "Charts get cut off on my iPhone when I'm at a customer site and need to check a number before I answer.",
  ],
  [
    "p36",
    ["metric-layer"],
    "Revenue means three different things",
    "Sales, finance and product each compute ARR differently and the dashboards disagree in every meeting. We want one definition everyone uses.",
  ],
  [
    "p37",
    ["metric-layer"],
    "Reusable metric definitions",
    "Define 'active user' once and reuse it in every chart instead of rewriting the formula each time.",
  ],
  [
    "p38",
    ["sheets"],
    "Google Sheets sync",
    "Our budget lives in a Google Sheet. Every week I re-upload it so the dashboard is current.",
  ],
  [
    "p39",
    ["sheets"],
    "Auto-refresh from our shared spreadsheet",
    "Let a dashboard pull from our shared Excel Online sheet automatically instead of manual CSV uploads.",
  ],
  [
    "p40",
    ["freshness"],
    "Last updated timestamp",
    "I presented numbers to the exec team that turned out to be two days old because a sync had failed. Show when data was last refreshed.",
  ],
  [
    "p41",
    ["freshness"],
    "Warn on stale data",
    "Flag a dashboard when its source hasn't updated in 24 hours so nobody trusts old numbers.",
  ],
  [
    "p42",
    ["embed"],
    "Embed charts in our product",
    "We want to show each of our customers their usage charts inside our own web app.",
  ],
  [
    "p43",
    ["embed"],
    "iframe embedding",
    "Can we embed a live dashboard in our customer portal so clients see their numbers there?",
  ],
  [
    "p44",
    ["localization"],
    "German translation",
    "Our managers in Munich and Vienna need dashboards in German; many of them don't read English well.",
  ],
  [
    "p45",
    ["localization"],
    "Spanish and Portuguese labels",
    "We operate in Brazil and Mexico; dashboard titles and labels should appear in Portuguese and Spanish.",
  ],
  [
    "p46",
    ["support-lookup"],
    "See requests in Zendesk",
    "When I answer a ticket I want to see what this customer has already asked for and the status of each request.",
  ],
  [
    "p47",
    ["support-lookup"],
    "Tell customers what's planned",
    "Our support team can't tell customers whether their feature request is planned without leaving the help desk and digging around.",
  ],
  [
    "p48",
    ["csv-export"],
    "Export chart data to Excel",
    "I need the numbers behind this chart in Excel to do my own analysis.",
  ],
  [
    "p49",
    ["csv-export"],
    "Download as CSV",
    "Add a download button for the underlying table so I can slice it in a spreadsheet.",
  ],
  [
    "p50",
    ["api-access"],
    "Metrics API",
    "I want to pull our weekly KPIs into a Python script without scraping the UI.",
  ],
  [
    "p51",
    ["goal-tracking"],
    "Targets on charts",
    "Show our monthly sales target on the revenue chart so reps see whether they're on pace.",
  ],
  [
    "p52",
    ["white-label"],
    "Our client's logo, not yours",
    "We're an agency and send dashboards to clients. They should carry the client's logo and colors, not your branding.",
  ],
  [
    "p53",
    ["two-factor"],
    "Require 2FA",
    "Please let us require two-factor authentication for every user in our workspace.",
  ],
  [
    "p54",
    ["row-level-security"],
    "Each rep sees their own territory",
    "One sales dashboard for all reps, but each rep should only see the rows for their own territory.",
  ],
  [
    "p55",
    ["version-history"],
    "Undo a bad change",
    "Someone deleted half the charts on our main dashboard. Let us roll back to yesterday's version.",
  ],
]);

const sameSolution = rows("same_solution", [
  [
    "s01",
    ["n2"],
    "PDF export for audits",
    "Auditors require a PDF of the monthly compliance report exactly as it stood at month end.",
  ],
  [
    "s02",
    [],
    "PDF export for the warehouse floor",
    "Our pickers don't use computers. We print the picking dashboard every morning and pin it on the wall, and the print layout is broken.",
  ],
  [
    "s03",
    ["mentions"],
    "Slack integration for questions",
    "Let me start a Slack thread from a chart so I can ask a colleague about that exact number.",
  ],
  [
    "s04",
    ["scheduled-delivery"],
    "Slack integration for the weekly numbers",
    "Post the weekly KPI dashboard into our #leadership Slack channel every Monday so managers don't have to log in.",
  ],
  [
    "s05",
    ["audit-log"],
    "Webhooks for our SIEM",
    "Send a webhook every time someone views or exports a sensitive report so our security team has a record of it.",
  ],
  [
    "s06",
    [],
    "Salesforce connector to show charts in Salesforce",
    "Our reps live in Salesforce. Show the account health chart on the Salesforce account page so they don't switch tools.",
  ],
  [
    "s07",
    ["provisioning"],
    "Okta integration for onboarding",
    "Use our Okta groups to create accounts automatically when someone joins and remove them when they leave.",
  ],
  [
    "s08",
    ["two-factor"],
    "Authenticator app at login",
    "We don't have an identity provider, and users reuse passwords. We want an authenticator app prompt at every login.",
  ],
  [
    "s09",
    [],
    "Dark theme for embedded charts",
    "Our app has a dark UI and embedded charts with a white background look broken inside it.",
  ],
  [
    "s10",
    ["n2"],
    "CSV export for the month-end archive",
    "Every month end we need a CSV copy of each finance report stored for seven years for our auditors.",
  ],
  [
    "s11",
    [],
    "Full export if we cancel",
    "Procurement requires that we can export all our data and dashboards in a standard format if we ever cancel the contract.",
  ],
  [
    "s12",
    ["provisioning"],
    "API to manage users",
    "Give us an API to add and remove users so our HR system manages accounts on its own.",
  ],
  [
    "s13",
    ["embed"],
    "API to render charts in our app",
    "We want an API that renders live charts inside our customer-facing product.",
  ],
  [
    "s14",
    [],
    "API to push events in",
    "We need an API to push events into a dataset from our backend in real time instead of batch uploads.",
  ],
  [
    "s15",
    ["n2"],
    "Version history for auditors",
    "We need to prove to auditors what the revenue report showed at each month end, and keep that record.",
  ],
  [
    "s16",
    ["row-level-security"],
    "Permissions on embedded dashboards",
    "Customers viewing the embedded dashboard in our portal must only ever see their own data.",
  ],
  [
    "s17",
    ["permissions"],
    "Row-level permissions for contractors",
    "We need row-level permissions so contractors can't open the HR dashboards at all.",
  ],
  [
    "s18",
    ["goal-tracking"],
    "Annotation line for quota",
    "Let me draw a line annotation at our quota so the team sees whether we're ahead or behind this month.",
  ],
  [
    "s19",
    [],
    "Comments for sign-off",
    "We want comments on dashboards so the CFO can sign off that the monthly numbers are final before they're published.",
  ],
  [
    "s20",
    ["csv-export"],
    "Google Sheets connector to send data out",
    "Send the numbers from a chart to Google Sheets so finance can model scenarios on them.",
  ],
  [
    "s21",
    [],
    "Snowflake connector for write-back",
    "We want to write our forecast adjustments back into Snowflake from the dashboard.",
  ],
  [
    "s22",
    ["freshness"],
    "Audit log of sync runs",
    "Show a log of each data sync with its failures so we know when the numbers can't be trusted.",
  ],
  [
    "s23",
    ["sso"],
    "MFA through Okta",
    "We need MFA enforced, and our Okta already does that. Just let us sign in through Okta.",
  ],
  [
    "s24",
    ["support-lookup"],
    "Embed a widget in Zendesk",
    "Embed a widget in Zendesk that shows the requests the customer on the ticket has already filed.",
  ],
  [
    "s25",
    ["chat-alerts"],
    "Webhook for Mattermost alerts",
    "Give us a generic webhook so we can post alerts to our Mattermost channel when a metric crosses a limit.",
  ],
  [
    "s26",
    ["permissions", "provisioning"],
    "SCIM groups for dashboard access",
    "Sync our Okta groups so group membership decides which dashboards each person can open.",
  ],
]);

const multiAsk = rows("multi_ask", [
  [
    "m01",
    ["n1", "sso"],
    "PDF for the board, and Okta",
    "We need to send the board our KPI dashboard every quarter without rebuilding slides. Also, IT won't approve a wider rollout until we can log in with Okta.",
  ],
  [
    "m02",
    ["chat-alerts", "dark-mode"],
    "Slack alerts and a dark theme",
    "Post to #ops when error rate goes over 1%. Separately, the wall TVs in the ops room really need a dark theme.",
  ],
  [
    "m03",
    ["pivot", "csv-export"],
    "Pivot and download",
    "Let me group revenue by region and plan together, and then download the result to Excel.",
  ],
  [
    "m04",
    ["crm-sync"],
    "HubSpot sync and a forecast",
    "Connect HubSpot so the pipeline dashboard updates on its own. It would also be great to get a revenue forecast for next quarter.",
  ],
  [
    "m05",
    ["mobile", "localization"],
    "Mobile and German",
    "Our field managers in Germany check numbers on their phones, and they'd like the dashboards in German.",
  ],
  [
    "m06",
    ["permissions", "audit-log"],
    "Restrict and log",
    "Restrict the payroll dashboard to HR, and keep a log of everyone who opens it.",
  ],
  [
    "m07",
    ["co-editing", "version-history"],
    "Overwrites and lost work",
    "My edits keep getting overwritten when a colleague works on the same dashboard. And when that happens I can't get my old version back.",
  ],
  [
    "m08",
    ["annotations", "mentions"],
    "Mark the outage and tag the data team",
    "I want to mark last week's outage on the chart and tag the data team on it so they explain the drop.",
  ],
  [
    "m09",
    ["warehouse", "metric-layer"],
    "Snowflake and one ARR",
    "Query Snowflake directly instead of copying data, and let us define ARR once so every dashboard agrees.",
  ],
  [
    "m10",
    ["embed", "white-label"],
    "Embed with our branding",
    "Embed charts in our customer portal, and show our clients' branding on them instead of yours.",
  ],
  [
    "m11",
    ["scheduled-delivery", "freshness"],
    "Morning email and stale warning",
    "Email the ops dashboard to managers every morning, and warn them if the data didn't refresh overnight.",
  ],
  [
    "m12",
    ["provisioning", "two-factor"],
    "Offboarding and 2FA",
    "Automatically remove accounts when people leave, and require two-factor authentication for everyone else.",
  ],
  [
    "m13",
    ["sheets", "goal-tracking"],
    "Targets from our sheet",
    "Pull our targets from the Google Sheet automatically and show them as goal lines on the sales charts.",
  ],
  [
    "m14",
    ["webhooks", "api-access"],
    "Notify us and let us read",
    "Notify our backend when data changes, and give us an API to read the latest metric values.",
  ],
  [
    "m15",
    ["n2"],
    "Audit PDF and a fiscal calendar",
    "Auditors need the month-end report frozen exactly as it was. Also, our fiscal year starts in February and the charts should respect that.",
  ],
  [
    "m16",
    ["dark-mode"],
    "Dark mode and shortcuts",
    "Dark mode for the NOC wall screens please. Also, keyboard shortcuts for switching dashboards would help our power users.",
  ],
  [
    "m17",
    ["support-lookup"],
    "Requests next to the ticket",
    "Show the customer's open feature requests next to the ticket in Zendesk, and let agents file a new request from the ticket in one click.",
  ],
  [
    "m18",
    ["row-level-security", "localization"],
    "Franchise data and French",
    "Each franchise owner should only see their own stores' numbers in the shared dashboard, and our Quebec owners need it in French.",
  ],
  [
    "m19",
    ["mentions", "chat-alerts"],
    "Tag teammates and alert Slack",
    "Let me tag a teammate on a chart, and send an alert to our Slack channel when churn spikes above 3%.",
  ],
  [
    "m20",
    ["n1", "annotations"],
    "Board snapshot with notes",
    "Before board meetings I want to send the directors a snapshot of the dashboard, with notes on the charts explaining the dips.",
  ],
]);

const newNeeds = rows("new", [
  [
    "u01",
    [],
    "Revenue forecasting",
    "Project next quarter's revenue from our historical trend so we can plan hiring.",
  ],
  [
    "u02",
    [],
    "Spot unusual changes",
    "Automatically point out unusual changes in our metrics that nobody thought to set a threshold for.",
  ],
  [
    "u03",
    [],
    "Dashboard templates",
    "Give us starter dashboards for common SaaS metrics so new teams don't build everything from scratch.",
  ],
  [
    "u04",
    [],
    "Download past invoices",
    "Our finance team needs to download past invoices from the billing settings for expense reports.",
  ],
  [
    "u05",
    [],
    "Fiscal calendar",
    "Our fiscal year starts in July; quarter filters and comparisons should follow it.",
  ],
  [
    "u06",
    [],
    "Ask questions in plain English",
    "Let people type questions like 'what was churn last month' and get a chart back.",
  ],
  [
    "u07",
    [],
    "Slow dashboard loading",
    "Our main dashboard takes 30 seconds to load once it covers a year of data.",
  ],
  [
    "u08",
    [],
    "Currency conversion",
    "We sell in EUR, GBP and USD and need revenue shown in one currency using daily exchange rates.",
  ],
  [
    "u09",
    [],
    "Delete personal data on request",
    "When a customer asks to be forgotten under GDPR, we need to delete their personal data from every dataset.",
  ],
  [
    "u10",
    [],
    "Cohort retention charts",
    "We need a cohort chart showing what share of each month's signups is still active after N months.",
  ],
  [
    "u11",
    [],
    "Map visualization",
    "Plot our store sales on a map by location so regional leads see hot spots.",
  ],
  [
    "u12",
    [],
    "Large file uploads fail",
    "Uploads over 50 MB fail, and our monthly transaction export is 200 MB.",
  ],
  [
    "u13",
    [],
    "Cheaper viewer seats",
    "People who only look at dashboards once a month shouldn't cost a full seat.",
  ],
  [
    "u14",
    [],
    "Guided onboarding",
    "New users get lost in the editor; a guided tour for building a first chart would help.",
  ],
  ["u15", [], "Drill down to the rows", "Click a bar to see the individual orders behind it."],
  [
    "u16",
    [],
    "EU data residency",
    "Our legal team requires that all our data is stored and processed in the EU.",
  ],
  [
    "u17",
    [],
    "Keyboard shortcuts",
    "Power users want keyboard shortcuts to switch between dashboards and apply filters.",
  ],
  [
    "u18",
    [],
    "Idle session timeout",
    "Security wants users logged out automatically after 15 minutes of inactivity.",
  ],
  [
    "u19",
    [],
    "Create Jira tickets from a chart",
    "When a metric needs follow-up, let us create a Jira ticket from the dashboard with the chart attached.",
  ],
  [
    "u20",
    [],
    "Screen reader support",
    "Our blind analyst can't use the charts with a screen reader; charts need text alternatives.",
  ],
  ["u21", [], "Coffee machine", "The coffee machine on the third floor is broken again."],
  [
    "u22",
    [],
    "Charged twice",
    "We were charged twice for October. Please refund the duplicate payment.",
  ],
  ["u23", [], "test", "asdf test test please ignore"],
  [
    "u24",
    [],
    "A/B test analysis",
    "Compare conversion between experiment variants and tell us whether the difference is significant.",
  ],
  [
    "u25",
    [],
    "Custom SQL for a chart",
    "Let analysts write raw SQL for a chart when the visual builder can't express the query.",
  ],
  [
    "u26",
    [],
    "Staging workspace",
    "We need a staging workspace to test dashboard changes before they go live to the whole company.",
  ],
  [
    "u27",
    [],
    "Colorblind-safe palettes",
    "Our red/green charts are unreadable for colorblind teammates; we need accessible color palettes.",
  ],
  [
    "u28",
    [],
    "Find unused dashboards",
    "Show which dashboards are actually viewed so we can clean up the hundreds nobody uses.",
  ],
  [
    "u29",
    [],
    "Bulk move dashboards",
    "We reorganized teams and need to move 40 dashboards to another workspace at once.",
  ],
  [
    "u30",
    [],
    "Real-time updates",
    "Our ops metrics should update every few seconds instead of once an hour.",
  ],
]);

export const submissions: LabeledSubmission[] = [
  ...paraphrases,
  ...sameSolution,
  ...multiAsk,
  ...newNeeds,
];
