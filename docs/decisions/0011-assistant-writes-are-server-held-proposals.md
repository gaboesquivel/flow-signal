# 0011 — Assistant writes are server-held proposals confirmed outside the model

Status: Proposed (2026-10-30)

## Context

The Operator assistant ([spec 014](../specs/014-operator-assistant.md)) lets a PM ask for a change in chat ("merge these two", "publish planned on X"). PRODUCT.md says PMs make every decision and that text from tools or customers never triggers an action. The chat model reads customer text (signals, use cases), so a write must not depend on the model, or on anything the browser sends back through the model loop, to prove the PM approved it. The same question will come up for every later conversational or agent surface that can write.

## Options

1. **AI SDK tool approval (`toolApproval: 'user-approval'`).** The model calls the write tool. The stream pauses with an approval request, and the client sends an approval response in the next message list. The approval travels in client-held message history, the preview is whatever the model passed as input, and resuming runs inside a model call.
2. **Eve approval (`always()`).** This is what the Operator Eve agent already does over MCP. It is tied to Eve sessions, not to the console's HTTP chat, and still shows only the tool input.
3. **Server-held proposals.** The model can only _propose_ a write. The server validates the input against the operation's schema, computes a preview from the database, and stores a pending action with an id. The PM confirms (optionally with edited input) through a separate Operator endpoint that never calls the model. The server recomputes the preview, refuses if it changed, and runs the operation once, keyed by the action id.

## Decision

Option 3.

- Operations that change PM-owned state (`effects: "write"`) gain an optional `preview(input, ctx)` that reads the database and describes the effect without changing anything.
- Pending actions live in a table with a status (`proposed`, `confirmed`, `rejected`, `expired`, `failed`), the validated input, the preview, and the result.
- Confirming re-validates the input, recomputes the preview, and executes the operation with the action id as its idempotency key and the PM as the actor.

## Consequences

- Prompt-injected text can at most produce a proposal card, which a person must read and confirm. No write happens without a confirmation request to an Operator route.
- Every write operation the assistant can propose needs a `preview`. Operations without one cannot be proposed.
- The model never sees the confirmation round-trip. After a confirm, the client posts the result back into the chat as context for the next turn.
- The Eve Operator agent keeps `always()` for MCP. Moving it onto proposals is a later choice.
