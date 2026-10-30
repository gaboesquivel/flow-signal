/**
 * Hand-written demo workspace content for `pnpm db:seed` (spec 001 → Seed and eval).
 * Statements follow "who needs to do what so that outcome". `supporters` is the number of
 * signals (each from a different person); asks are the verbatim texts those signals cycle
 * through. Keys are stable handles used by tests and the acceptance scenario (n1, n2).
 */

interface DemoAccount {
  arrCents: number;
  domain: string;
  key: string;
  name: string;
  openDealCents: number;
  plan: "Enterprise" | "Growth" | "Starter";
}

export const demoAccounts: DemoAccount[] = [
  {
    arrCents: 48_000_000,
    domain: "acme.example",
    key: "acme",
    name: "Acme",
    openDealCents: 12_000_000,
    plan: "Enterprise",
  },
  {
    arrCents: 36_000_000,
    domain: "northwind.example",
    key: "northwind",
    name: "Northwind Traders",
    openDealCents: 0,
    plan: "Enterprise",
  },
  {
    arrCents: 29_000_000,
    domain: "globex.example",
    key: "globex",
    name: "Globex",
    openDealCents: 8_000_000,
    plan: "Enterprise",
  },
  {
    arrCents: 9_600_000,
    domain: "initech.example",
    key: "initech",
    name: "Initech",
    openDealCents: 2_400_000,
    plan: "Growth",
  },
  {
    arrCents: 7_200_000,
    domain: "brightline.example",
    key: "brightline",
    name: "Brightline Health",
    openDealCents: 0,
    plan: "Growth",
  },
  {
    arrCents: 6_000_000,
    domain: "harbor.example",
    key: "harbor",
    name: "Harbor Logistics",
    openDealCents: 3_000_000,
    plan: "Growth",
  },
  {
    arrCents: 1_200_000,
    domain: "pinecone-cafe.example",
    key: "pinecone",
    name: "Pinecone Cafe Group",
    openDealCents: 0,
    plan: "Starter",
  },
  {
    arrCents: 900_000,
    domain: "lumen.example",
    key: "lumen",
    name: "Lumen Studio",
    openDealCents: 600_000,
    plan: "Starter",
  },
];

interface DemoTheme {
  description: string;
  key: string;
  name: string;
  strategicWeight: number;
}

export const demoThemes: DemoTheme[] = [
  {
    description: "Dashboards, exports, and getting numbers in front of people.",
    key: "reporting",
    name: "Reporting",
    strategicWeight: 0.9,
  },
  {
    description: "Moving data in and out of other tools.",
    key: "integrations",
    name: "Integrations",
    strategicWeight: 0.7,
  },
  {
    description: "Access control, audit, and compliance for admins.",
    key: "admin",
    name: "Administration and security",
    strategicWeight: 0.6,
  },
  {
    description: "Working together inside the product.",
    key: "collaboration",
    name: "Collaboration",
    strategicWeight: 0.4,
  },
];

export interface DemoNeed {
  asks: { body: string; title: string }[];
  /** Days before the seed date the need's first signal arrived. */
  createdDaysAgo: number;
  decision?: {
    daysAgo: number;
    note: string;
    status: "planned" | "in_progress" | "shipped" | "declined";
  };
  key: string;
  /** Merged into another need (by key) this many days ago; its signals move there. */
  mergedInto?: { daysAgo: number; key: string };
  publicSummary?: { status: "approved" | "pending"; text: string };
  /** AI priority scores (0–5) per criterion. */
  scores?: { business_value: number; demand: number; effort: number; strategic_fit: number };
  solutions: string[];
  statement: string;
  status: "draft" | "open" | "planned" | "in_progress" | "shipped" | "declined" | "merged";
  supporters: number;
  theme: string;
  useCases: string[];
}

export const demoNeeds: DemoNeed[] = [
  {
    asks: [
      {
        body: "Our exec team wants the KPI dashboard as a PDF they can drop into the board deck.",
        title: "Export dashboards to PDF",
      },
      {
        body: "Every month I screenshot six charts for our leadership review. A shareable snapshot would save hours.",
        title: "Share dashboard snapshot with leadership",
      },
      {
        body: "Board members don't have accounts. We need to send them the current numbers somehow.",
        title: "Send dashboards to people without logins",
      },
    ],
    createdDaysAgo: 84,
    key: "n1",
    publicSummary: {
      status: "approved",
      text: "Leaders want current dashboard numbers in board and leadership meetings without rebuilding slides by hand.",
    },
    solutions: ["PDF export", "Scheduled email digest"],
    statement:
      "Executives need to share dashboard snapshots outside the product so that board meetings use current numbers",
    status: "open",
    supporters: 11,
    theme: "reporting",
    useCases: [
      "monthly board deck",
      "quarterly business review",
      "weekly leadership sync",
      "investor update",
    ],
  },
  {
    asks: [
      {
        body: "Auditors ask for the monthly compliance report exactly as it was at month end. Please add PDF export.",
        title: "PDF export for audit archive",
      },
      {
        body: "We need a frozen copy of each month's report stored for seven years.",
        title: "Archive monthly reports",
      },
    ],
    createdDaysAgo: 70,
    key: "n2",
    publicSummary: {
      status: "pending",
      text: "Compliance teams keep immutable monthly copies of reports for auditors.",
    },
    solutions: ["PDF export", "Report snapshots with retention"],
    statement:
      "Compliance teams need to archive monthly reports so that audits have a fixed record",
    status: "open",
    supporters: 6,
    theme: "reporting",
    useCases: ["SOC 2 audit", "financial audit evidence", "regulator request"],
  },
  {
    asks: [
      {
        body: "Let me get the sales dashboard in my inbox every Monday at 8am.",
        title: "Scheduled dashboard emails",
      },
      {
        body: "Our regional managers never log in. Emailing them the numbers weekly would fix that.",
        title: "Weekly email of key charts",
      },
    ],
    createdDaysAgo: 88,
    decision: {
      daysAgo: 30,
      note: "Scheduled delivery is planned for the next quarter, starting with weekly email.",
      status: "planned",
    },
    key: "scheduled-delivery",
    scores: { business_value: 4, demand: 4, effort: 3, strategic_fit: 5 },
    solutions: ["Scheduled email digest"],
    statement:
      "Managers need to receive key dashboards on a schedule so that they act on numbers without logging in",
    status: "planned",
    supporters: 12,
    theme: "reporting",
    useCases: ["Monday sales review", "regional managers", "daily ops check"],
  },
  {
    asks: [
      {
        body: "We need to see revenue split by region and product on one chart.",
        title: "Group charts by two dimensions",
      },
      {
        body: "Pivoting by two fields is impossible today; we export to Excel to do it.",
        title: "Pivot tables in dashboards",
      },
    ],
    createdDaysAgo: 75,
    decision: {
      daysAgo: 12,
      note: "Two-level grouping shipped in the 4.2 release.",
      status: "shipped",
    },
    key: "pivot",
    solutions: ["Pivot tables", "Multi-dimension grouping"],
    statement:
      "Analysts need to break down metrics by two dimensions at once so that they find which segment drives a change",
    status: "shipped",
    supporters: 10,
    theme: "reporting",
    useCases: ["regional revenue analysis", "product mix review"],
  },
  {
    asks: [
      {
        body: "When a number jumps I want to leave a note on the chart explaining why.",
        title: "Annotate charts",
      },
      {
        body: "Comments on data points so the team knows the spike was a promo.",
        title: "Comments on data points",
      },
    ],
    createdDaysAgo: 40,
    key: "annotations",
    solutions: ["Chart annotations"],
    statement:
      "Analysts need to explain changes directly on charts so that teammates understand why numbers moved",
    status: "open",
    supporters: 6,
    theme: "collaboration",
    useCases: ["campaign spikes", "incident explanations"],
  },
  {
    asks: [
      {
        body: "Push new deals from Salesforce into the dashboard automatically.",
        title: "Salesforce sync",
      },
      {
        body: "We copy CRM exports in by hand every week. A native CRM connector please.",
        title: "CRM connector",
      },
      {
        body: "Our support copilot keeps asking for live opportunity data from the CRM.",
        title: "Live CRM data",
      },
    ],
    createdDaysAgo: 86,
    decision: {
      daysAgo: 20,
      note: "A two-way CRM sync is in progress; beta opens next month.",
      status: "in_progress",
    },
    key: "crm-sync",
    scores: { business_value: 5, demand: 4, effort: 2, strategic_fit: 4 },
    solutions: ["Salesforce connector", "HubSpot connector"],
    statement:
      "Revenue teams need CRM data to flow in automatically so that pipeline dashboards are never stale",
    status: "in_progress",
    supporters: 12,
    theme: "integrations",
    useCases: ["pipeline review", "forecast call", "account health"],
  },
  {
    asks: [
      {
        body: "Send a Slack message to #ops when inventory drops below the threshold.",
        title: "Slack alerts",
      },
      {
        body: "Alerts should go where the team already talks, which is Slack or Teams.",
        title: "Alerts in chat tools",
      },
    ],
    createdDaysAgo: 65,
    key: "chat-alerts",
    publicSummary: {
      status: "approved",
      text: "Operations teams want threshold alerts delivered to their team chat.",
    },
    solutions: ["Slack integration", "Microsoft Teams integration"],
    statement:
      "Operations teams need threshold alerts in their team chat so that they react before customers notice",
    status: "open",
    supporters: 9,
    theme: "integrations",
    useCases: ["low inventory", "failed shipments", "SLA breach"],
  },
  {
    asks: [
      {
        body: "Give us a webhook when a record changes so our own systems can react.",
        title: "Webhooks on record changes",
      },
      {
        body: "We poll the API every minute. Event webhooks would be much better.",
        title: "Event webhooks",
      },
    ],
    createdDaysAgo: 58,
    key: "webhooks",
    solutions: ["Webhooks"],
    statement:
      "Developers need to be notified when data changes so that their systems stay in sync without polling",
    status: "open",
    supporters: 8,
    theme: "integrations",
    useCases: ["ERP sync", "internal tooling"],
  },
  {
    asks: [
      {
        body: "Our Snowflake warehouse is the source of truth. Query it directly please.",
        title: "Connect to Snowflake",
      },
      {
        body: "Uploading CSV extracts from BigQuery every day is error prone.",
        title: "BigQuery connection",
      },
    ],
    createdDaysAgo: 80,
    key: "warehouse",
    scores: { business_value: 4, demand: 3, effort: 2, strategic_fit: 4 },
    solutions: ["Snowflake connector", "BigQuery connector"],
    statement:
      "Data teams need to query their warehouse directly so that dashboards use one source of truth",
    status: "open",
    supporters: 8,
    theme: "integrations",
    useCases: ["finance reporting", "product analytics"],
  },
  {
    asks: [
      {
        body: "IT requires all tools to use Okta single sign-on before we can roll out further.",
        title: "SSO with Okta",
      },
      {
        body: "We need SAML SSO for procurement to approve the renewal.",
        title: "SAML single sign-on",
      },
    ],
    createdDaysAgo: 89,
    decision: { daysAgo: 45, note: "SAML SSO shipped for Enterprise plans.", status: "shipped" },
    key: "sso",
    solutions: ["SAML SSO", "Okta integration"],
    statement:
      "IT admins need to control sign-in through their identity provider so that access follows company policy",
    status: "shipped",
    supporters: 8,
    theme: "admin",
    useCases: ["security review", "procurement requirement"],
  },
  {
    asks: [
      {
        body: "Contractors should only see the dashboards for their project.",
        title: "Restrict dashboards per group",
      },
      {
        body: "Finance dashboards must be hidden from the rest of the company.",
        title: "Dashboard permissions",
      },
    ],
    createdDaysAgo: 62,
    key: "permissions",
    scores: { business_value: 4, demand: 3, effort: 3, strategic_fit: 3 },
    solutions: ["Role-based access control", "Folder permissions"],
    statement:
      "Admins need to limit who can see each dashboard so that sensitive numbers stay with the right people",
    status: "open",
    supporters: 8,
    theme: "admin",
    useCases: ["contractor access", "finance data", "board-only metrics"],
  },
  {
    asks: [
      {
        body: "Security wants a log of who viewed or exported which report.",
        title: "Audit log of report access",
      },
      {
        body: "For our ISO audit we must show who changed dashboard definitions.",
        title: "Change history for auditors",
      },
    ],
    createdDaysAgo: 55,
    key: "audit-log",
    solutions: ["Audit log export"],
    statement:
      "Security teams need a record of who accessed and changed reports so that they can answer audit questions",
    status: "open",
    supporters: 6,
    theme: "admin",
    useCases: ["ISO 27001 audit", "incident review"],
  },
  {
    asks: [
      {
        body: "Create users automatically when they join in Azure AD and remove them when they leave.",
        title: "SCIM provisioning",
      },
    ],
    createdDaysAgo: 35,
    key: "provisioning",
    solutions: ["SCIM provisioning"],
    statement:
      "IT admins need accounts created and removed automatically so that leavers lose access the same day",
    status: "open",
    supporters: 4,
    theme: "admin",
    useCases: ["onboarding", "offboarding"],
  },
  {
    asks: [
      {
        body: "Two people editing the same dashboard overwrite each other.",
        title: "Real-time co-editing",
      },
      {
        body: "Let me see who else is editing the dashboard right now.",
        title: "Show who is editing",
      },
    ],
    createdDaysAgo: 50,
    key: "co-editing",
    solutions: ["Real-time co-editing"],
    statement:
      "Teams need to edit dashboards together without overwriting work so that building reports is not serialized",
    status: "open",
    supporters: 6,
    theme: "collaboration",
    useCases: ["quarter-end crunch", "team workshops"],
  },
  {
    asks: [
      {
        body: "Mention a colleague on a chart and have them get notified.",
        title: "@mentions on dashboards",
      },
    ],
    createdDaysAgo: 30,
    key: "mentions",
    solutions: ["@mentions"],
    statement:
      "Analysts need to pull a colleague into a specific chart so that questions get answered in context",
    status: "open",
    supporters: 4,
    theme: "collaboration",
    useCases: ["data questions", "review requests"],
  },
  {
    asks: [
      {
        body: "Dark mode for the dashboard would be easier on the eyes in our ops room.",
        title: "Dark mode",
      },
    ],
    createdDaysAgo: 72,
    decision: {
      daysAgo: 25,
      note: "Not planned: we are focusing on accessibility contrast first.",
      status: "declined",
    },
    key: "dark-mode",
    solutions: ["Dark theme"],
    statement:
      "Operators need a low-glare display so that they can watch dashboards on wall screens all day",
    status: "declined",
    supporters: 5,
    theme: "reporting",
    useCases: ["ops room wall screen"],
  },
  {
    asks: [
      {
        body: "Our field team checks numbers on phones and the charts are unreadable.",
        title: "Mobile-friendly dashboards",
      },
      {
        body: "Please make dashboards work on an iPad for store managers.",
        title: "Tablet layout",
      },
    ],
    createdDaysAgo: 45,
    key: "mobile",
    solutions: ["Responsive dashboards", "Mobile app"],
    statement:
      "Field managers need to read dashboards on their phones so that they decide on the spot",
    status: "open",
    supporters: 6,
    theme: "reporting",
    useCases: ["store visits", "site inspections"],
  },
  {
    asks: [
      {
        body: "Let me define a metric once and reuse it everywhere so numbers match.",
        title: "Shared metric definitions",
      },
    ],
    createdDaysAgo: 28,
    key: "metric-layer",
    solutions: ["Semantic layer"],
    statement:
      "Analysts need one shared definition per metric so that every dashboard reports the same number",
    status: "open",
    supporters: 5,
    theme: "reporting",
    useCases: ["revenue definition disputes"],
  },
  {
    asks: [
      {
        body: "Upload a spreadsheet and have it refresh from Google Sheets daily.",
        title: "Google Sheets sync",
      },
    ],
    createdDaysAgo: 24,
    key: "sheets",
    solutions: ["Google Sheets connector"],
    statement:
      "Small teams need spreadsheet data to refresh automatically so that dashboards stay current without uploads",
    status: "open",
    supporters: 4,
    theme: "integrations",
    useCases: ["budget tracking", "marketing spend"],
  },
  {
    asks: [
      {
        body: "When the data is late, tell us before the morning meeting instead of showing yesterday's numbers.",
        title: "Freshness warnings",
      },
    ],
    createdDaysAgo: 18,
    key: "freshness",
    solutions: ["Data freshness indicator"],
    statement:
      "Report readers need to know when data is stale so that they don't decide on yesterday's numbers",
    status: "open",
    supporters: 4,
    theme: "reporting",
    useCases: ["morning stand-up"],
  },
  // Merged away: duplicates of chat-alerts and webhooks, written differently.
  {
    asks: [
      {
        body: "Post a message in our Slack ops channel when a job fails.",
        title: "Slack notification on failures",
      },
    ],
    createdDaysAgo: 60,
    key: "slack-digest-dup",
    mergedInto: { daysAgo: 40, key: "chat-alerts" },
    solutions: ["Slack integration"],
    statement: "Ops leads need alerts posted to Slack so that the team sees problems quickly",
    status: "merged",
    supporters: 2,
    theme: "integrations",
    useCases: ["incident response"],
  },
  {
    asks: [
      { body: "Notify our ERP when an order record is updated.", title: "Push updates to ERP" },
    ],
    createdDaysAgo: 52,
    key: "erp-push-dup",
    mergedInto: { daysAgo: 33, key: "webhooks" },
    solutions: ["Webhooks"],
    statement: "Integrators need updates pushed to their ERP so that orders stay consistent",
    status: "merged",
    supporters: 2,
    theme: "integrations",
    useCases: ["ERP sync"],
  },
  // Draft needs from "none of these" submissions, awaiting PM review.
  {
    asks: [
      {
        body: "Let us embed a live chart in our customer portal.",
        title: "Embed charts in our portal",
      },
    ],
    createdDaysAgo: 9,
    key: "embed",
    solutions: ["Embeddable charts"],
    statement:
      "Product teams need to show live charts inside their own app so that customers see their usage",
    status: "draft",
    supporters: 2,
    theme: "integrations",
    useCases: ["customer usage portal"],
  },
  {
    asks: [
      {
        body: "Translate the dashboard labels into German and French for our EU offices.",
        title: "Localized dashboards",
      },
    ],
    createdDaysAgo: 6,
    key: "localization",
    solutions: ["Dashboard translations"],
    statement:
      "International teams need dashboards in their language so that local managers read them without help",
    status: "draft",
    supporters: 1,
    theme: "reporting",
    useCases: ["EU offices"],
  },
  {
    asks: [
      {
        body: "Our support copilot wants to look up a customer's open requests before replying.",
        title: "Customer request lookup for support",
      },
    ],
    createdDaysAgo: 3,
    key: "support-lookup",
    solutions: ["Support sidebar app"],
    statement:
      "Support agents need to see a customer's open requests while replying so that they set honest expectations",
    status: "draft",
    supporters: 1,
    theme: "collaboration",
    useCases: ["support replies"],
  },
];

export const demoCriteria = [
  { description: "Supporters, weighted by account.", key: "demand", weight: 0.35 },
  {
    description: "Revenue of requesting accounts and open deals.",
    key: "business_value",
    weight: 0.3,
  },
  { description: "Match to PM-set themes.", key: "strategic_fit", weight: 0.2 },
  { description: "Rough effort estimate (5 = small).", key: "effort", weight: 0.15 },
] as const;
