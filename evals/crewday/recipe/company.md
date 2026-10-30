# Crewday

Crewday is a fictional company. Every account, person, and number in this recipe is invented.

## What it sells

Crewday is a mid-market B2B SaaS product for scheduling frontline teams: people who work shifts, not desks. One product covers the shift lifecycle:

- **Scheduling.** Build rotas from demand forecasts and staff availability, publish them, and handle shift swaps, open shifts, and time-off requests.
- **Time and attendance.** Clock in and out on the mobile app, a shared kiosk tablet, or a badge reader. Timesheets, breaks, and manager approvals.
- **Payroll exports.** Approved hours, pay rules (overtime, night and weekend differentials, premiums), and exports to the customer's payroll provider. Crewday does not run payroll.
- **Compliance.** Labour-law rules (predictive scheduling, rest periods, minors, break rules), credential and certification tracking, and audit trails.
- **Integrations.** HRIS and payroll connectors, POS and WMS demand feeds, SSO and SCIM, a REST API, and webhooks.
- **Mobile.** The Crewday app for frontline staff (iOS and Android) and a manager view.

## Who buys it

About 1,100 customers and roughly $41M ARR. Five segments:

| Segment             | Typical customer                                      | Why they buy                                                    |
| ------------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| Hospitality         | Hotel groups, restaurant chains, catering             | Volatile demand, high turnover, tip and premium pay rules       |
| Retail              | Store chains with 20 to 600 locations                 | Fair-workweek laws, holiday peaks, part-time availability       |
| Logistics           | Warehouses, 3PLs, last-mile delivery depots           | Shift bidding, overtime control, peak-season ramp-ups           |
| Healthcare staffing | Staffing agencies, care homes, clinics                | Credentials that must be valid before a shift, agency pay rates |
| Field services      | Cleaning, security, facilities, home-care field crews | Multi-site travel, geofenced clock-in, client-site rules        |

Inside a customer, the people who touch Crewday are ops admins (configure it), shift managers (build and run rotas), frontline staff (see shifts, swap, clock in), HR and payroll (approve hours, export pay), and IT and security (sign-in, provisioning, data).

## Plans

| Plan       | Price (per scheduled employee, per month)  | Includes                                                                                                          |
| ---------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Starter    | $4                                         | Scheduling, mobile app, shift swaps, one location group, CSV exports                                              |
| Growth     | $7                                         | Everything in Starter, time and attendance, pay rules, payroll connectors, multiple locations, basic integrations |
| Enterprise | $11, annual contract, from about $120k ARR | Everything in Growth, compliance packs, SSO and SCIM, API and webhooks, multi-entity, audit log, a named CSM      |

A few Enterprise accounts hold most of the revenue. Growth is the volume of the business. Starter customers are many and small, and they churn when a cheaper tool appears.

## How requests reached Crewday before Signal

Feature requests came through CSMs, sales reps, the support desk, and a shared spreadsheet that product managers sorted by hand. The spreadsheet was the backlog. It has solution-named rows, duplicates, and almost no record of who asked or why. When Crewday adopts Signal, that spreadsheet is imported as-is and the support copilot (an AI assistant inside the support desk) starts filing requests over MCP on customers' behalf.
