# 002 — Ingest feedback from support and sales tools

Status: candidate (2026-10-30)

## Problem

Customer feedback is fragmented across Intercom, Zendesk, Slack, and sales calls. Needs that never reach the Signal board are invisible to demand, priority, and decisions.

## Assumption it tests

Signals pulled from conversations, matched by the same retrieve-then-judge pipeline as spec 001, are accurate and useful enough that PMs accept them into needs without re-reading the source conversation.

Like every capability, ingestion would be built as operations in spec 001's registry (REST, MCP, and agent tools), test-first through the parity suite.

Flesh out after spec 001 ships and its matching eval holds.
