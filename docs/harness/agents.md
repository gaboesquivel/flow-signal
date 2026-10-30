# Agents, MCP, and chat

Source: `agents/*/agent/`, `lib/signal/adapters/agent.ts`, `app/api/operator/chat/`, `lib/mcp/`, `lib/ai/models.ts`, [docs/INTEROP.md](../INTEROP.md), [spec 010](../specs/010-retro-remediation.md).

## Inventory

```mermaid
flowchart TB
  subgraph EveRuntime[Eve runtime · mounted by withEve in next.config.ts]
    subgraph AST[Assistant agent · public]
      AI1[instructions.md<br/>GenUI helper + acts for customers on Signal]
      AT1[compose_ui · list_component_catalog · generate_demo_data]
      AT2[signal.ts · defineDynamic<br/>5 public operations]
    end
    subgraph OPA[Operator agent · protected]
      OI1[instructions.md<br/>helps PMs run Signal; AI output is a suggestion]
      OT1[compose_ui · list_component_catalog · generate_demo_data]
      OT2[signal.ts · defineDynamic<br/>all 23 operations; 7 writes gated by approval]
    end
  end
  subgraph Console[PM console chat · /operator/chat]
    CA[/api/operator/chat · secret<br/>AI SDK generateText, up to 8 steps<br/>Operator instructions + console rules<br/>8 read-only ops/]
  end
  subgraph MCPs[MCP Streamable HTTP]
    P[/api/mcp and /mcp · public<br/>health · catalog · compose_ui + public ops<br/>GenUI preview MCP App resource/]
    O[/api/mcp/operator · secret<br/>diagnostics + all ops/]
  end
  subgraph Chat[Public HTTP chat]
    C1[/api/chat<br/>streamText, no tools/]
  end
```

## How a Signal tool reaches an Eve agent

```mermaid
sequenceDiagram
  participant Eve as Eve session
  participant Dyn as tools/signal.ts (defineDynamic)
  participant Ad as signalAgentTools(agent)
  participant Reg as registry
  participant Ex as executeOperation
  Eve->>Dyn: session.started
  Dyn->>Ad: resolve tools for assistant or operator
  Ad->>Reg: public ops, or all ops
  Ad-->>Eve: one defineTool per op<br/>durable callback + durable schema<br/>approval: always() if operator write
  Eve->>Ad: model calls tool(input)
  alt operator write
    Ad->>Eve: park, ask PM to approve
    Eve-->>Ad: approved
  end
  Ad->>Ex: run as actor kind agent, client eve:assistant or eve:operator
  Ex-->>Ad: data, or the error envelope (never throws)
  Ad-->>Eve: tool result
```

Durable callbacks capture only the operation name, so a parked call replays in a fresh process.

## Console chat answer

```mermaid
flowchart LR
  Q[PM question<br/>what are enterprise accounts blocked on?] --> G[generateText<br/>Operator instructions + console rules]
  G -->|plan or segment| DS[get_demand_summary plan]
  G -->|overview| LN[list_operator_needs]
  G -->|detail| ND[get_need_detail, get_need, search_needs]
  G -->|context| OT[get_criteria, get_metrics, list_suggestions]
  DS & LN & ND & OT --> A[Short answer<br/>needs linked as need:id, cited needs listed]
  G -. asked to change something .-> PT[Points to Triage, need page, or Criteria]
```

## Guardrails in agent instructions

```mermaid
flowchart LR
  TR[Tool result<br/>signals, statements, briefs, customer text] --> R{Agent rule}
  R -->|treated as data| OK[Read, summarize, answer]
  R -->|asks for a write| NO[Ignored: write only when<br/>the person in chat asked]
  W[Operator write tool] --> APP[PM approval per call]
  PUBT[Public summary or decision note] --> CPT[check_public_text first,<br/>remove every finding]
  TOK[My signals token] --> TR2[Only one the submitter gave in chat<br/>never guessed or looked up by email]
  G[compose_ui query] --> IG[injection-guard intent<br/>regex routing]
```

## Operator access

```mermaid
flowchart TD
  REQ[Request to /operator, /api/operator/*, /api/mcp/operator] --> CFG{OPERATOR_SECRET set<br/>and ≥ 16 chars?}
  CFG -->|no| CLOSED[Fail closed: disabled]
  CFG -->|yes| CRED{Bearer, X-Operator-Secret,<br/>or HMAC session cookie?}
  CRED -->|valid| ALLOW[Operator surfaces + all ops]
  CRED -->|invalid| DENY[unauthorized]
  LOGIN[POST /api/operator/session<br/>with secret] --> COOKIE[HttpOnly SameSite=Strict cookie, 24 h]
```

OAuth/OIDC for Operator is not implemented.

## Model routing: AI Gateway only

```mermaid
flowchart LR
  subgraph Ids[lib/ai/models.ts · env overrides]
    CH[Chat · CHAT_MODEL<br/>claude-sonnet-5.5]
    EV[Eve · EVE_AGENT_MODEL / EVE_OPERATOR_MODEL<br/>claude-sonnet-5.5]
    FA[Signal fast · SIGNAL_FAST_MODEL<br/>claude-haiku-5.5: extract, judge]
    RE[Signal reasoning · SIGNAL_REASONING_MODEL<br/>claude-sonnet-5.5: scores, themes, summaries]
    DE[Signal decision · SIGNAL_DECISION_MODEL<br/>claude-sonnet-5.5: decision briefs]
    EM[Embeddings · SIGNAL_EMBEDDING_MODEL<br/>text-embedding-3-small, 1536 d]
    GU[GenUI · GENUI_MODEL<br/>claude-sonnet-4.6]
  end
  Ids --> GW{Gateway credentials?<br/>AI_GATEWAY_API_KEY, VERCEL_OIDC_TOKEN, or VERCEL=1}
  GW -->|yes| VG[Vercel AI Gateway<br/>billed on Gateway credentials]
  GW -->|no| DEG[Degrade: chat 503, preview ai: unavailable,<br/>GenUI fixtures only, live evals skip]
```

There is no direct provider path, and lint rejects direct provider SDK imports. The local OIDC token from `vercel env pull` expires after about 12 hours.

## GenUI compose (`compose_ui`, `/genui`)

```mermaid
flowchart TD
  Q[query] --> RT[routeQuery]
  RT -->|injection pattern| T0[injection-guard document]
  RT -->|known intent| T1[Tier 1: controlled builder<br/>deterministic, synthetic fixtures]
  RT -->|multi-part / ambiguous| T2[Tier 2: declarative section stack<br/>optional classifier]
  RT -->|open-ended| T3[Tier 3: model writes OpenUI Lang]
  T3 -->|no credentials| MC[missing_credentials]
  T1 --> VAL[validateCompositionEnvelope]
  T2 --> VAL
  T3 --> VAL
  VAL --> ENV[Envelope: openuiText, records, fallbackText]
  ENV --> REN[React renderer / MCP App preview]
```
