# Agents, MCP, and chat

Source: `agents/*/agent/`, `lib/signal/adapters/agent.ts`, `lib/mcp/`, `app/api/`, `lib/ai/models.ts`, [docs/INTEROP.md](../INTEROP.md).

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
      OT2[signal.ts · defineDynamic<br/>all 17 operations; 6 writes gated by approval]
    end
  end
  subgraph MCPs[MCP Streamable HTTP]
    P[/api/mcp and /mcp · public<br/>health · catalog · compose_ui + public ops<br/>GenUI preview MCP App resource/]
    O[/api/mcp/operator · secret<br/>diagnostics + all ops/]
  end
  subgraph Chat[HTTP chat · streamText, no tools]
    C1[/api/chat/]
    C2[/api/operator/chat · secret/]
  end
```

Note: the two HTTP chat routes are plain `streamText` with a short system prompt and no tools; Signal actions go through Eve agents or MCP.

## How a Signal tool reaches an agent

```mermaid
sequenceDiagram
  participant Eve as Eve session
  participant Dyn as tools/signal.ts (defineDynamic)
  participant Ad as signalAgentTools(agent)
  participant Reg as registry
  participant Ex as executeOperation
  Eve->>Dyn: session.started
  Dyn->>Ad: resolve tools for assistant | operator
  Ad->>Reg: public ops, or all ops
  Ad-->>Eve: one defineTool per op<br/>durable callback + durable schema<br/>approval: always() if operator write
  Eve->>Ad: model calls tool(input)
  alt operator write
    Ad->>Eve: park, ask PM to approve
    Eve-->>Ad: approved
  end
  Ad->>Ex: run as actor kind agent, client eve:assistant or eve:operator
  Ex-->>Ad: data, or { error } envelope (never throws)
  Ad-->>Eve: tool result
```

Durable callbacks capture only the operation name, so a parked call replays in a fresh process.

## Prompt-injection guardrails

```mermaid
flowchart LR
  TR[Tool result<br/>signals, statements, briefs, customer text] --> R{Agent rule}
  R -->|treated as data| OK[Read, summarize, answer]
  R -->|asks for a write| NO[Ignored: write only when<br/>the person in chat asked]
  W[Operator write tool] --> APP[PM approval per call]
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

## Model routing

```mermaid
flowchart LR
  subgraph Ids[lib/ai/models.ts · env overrides]
    CH[Chat · CHAT_MODEL<br/>claude-sonnet-5.5]
    EV[Eve · EVE_AGENT_MODEL / EVE_OPERATOR_MODEL<br/>claude-sonnet-5.5]
    FA[Signal fast · SIGNAL_FAST_MODEL<br/>claude-haiku-5.5: extract, judge]
    RE[Signal reasoning · SIGNAL_REASONING_MODEL<br/>claude-sonnet-5.5: scores, briefs, summaries]
    EM[Embeddings · SIGNAL_EMBEDDING_MODEL<br/>text-embedding-3-small, 1536 d]
    GU[GenUI · GENUI_MODEL<br/>claude-sonnet-4.6]
  end
  Ids --> GW{Gateway available?<br/>AI_GATEWAY_API_KEY or VERCEL=1 OIDC}
  GW -->|yes| VG[Vercel AI Gateway]
  GW -->|no, FLOW_ALLOW_DIRECT_ANTHROPIC=1 + key| DA[Direct Anthropic, chat only]
  GW -->|no| DEG[Degrade: chat 503, preview ai: unavailable,<br/>GenUI fixtures only]
```

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
