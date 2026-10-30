# 003 — Notify supporters and stakeholders of decisions

Status: candidate (2026-10-30)

## Problem

In the MVP, supporters only learn about a decision if they open their private link or ask over MCP, so most never hear back.

## Assumption it tests

Proactively sending AI-drafted, PM-approved decision updates (email, Slack) raises close-the-loop rate and brings supporters back to add context, without PMs spending more time on communication.

Like every capability, sending updates would be built as operations in spec 001's registry (REST, MCP, and agent tools), test-first through the parity suite, with every send gated on a PM action.

Flesh out after spec 001 ships and close-the-loop rate has a baseline.
