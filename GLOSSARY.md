# Signal — glossary

| Term                  | Meaning                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Portless host**     | Local dev URL host (`signal.localhost`) used by the template's Portless configuration                                         |
| **Public MCP**        | Unauthenticated MCP tools at `/api/mcp`: the template's (health, catalog, compose_ui) plus Signal's public operations         |
| **Operator**          | Protected console (`/operator`) and MCP (`/api/mcp/operator`); requires `OPERATOR_SECRET`; fails closed when unset            |
| **Signal**            | One person's submission, kept verbatim (their words, email, account, urgency, date); always attached to a need                |
| **Need**              | The underlying problem ("who needs to do what so that outcome"); AI-drafted, PM-edited; what people support and PMs decide on |
| **Draft need**        | A need created by a new signal; public as "new" until a PM approves it or merges it                                           |
| **Theme**             | PM-defined area grouping related needs (e.g. "Reporting")                                                                     |
| **Proposed solution** | A solution extracted by AI from signals and listed on a need; matching is on the need, not the solution                       |
| **Merge**             | Moving all of one need's signals onto another need; undoable, nothing is lost                                                 |
| **Decision**          | A PM-published outcome on a need (planned, in progress, shipped, declined) with a note supporters see                         |
| **Prevention rate**   | Signals attached to an existing need at submission ÷ (those + signals whose draft need was later merged)                      |
| **Operation**         | One capability defined once in the registry (`lib/signal/operations/`) and exposed as a REST route, MCP tool, and agent tool  |
| **Parity suite**      | Tests that run each operation's cases through REST, MCP, and agent surfaces and expect the same output, errors, and events    |
