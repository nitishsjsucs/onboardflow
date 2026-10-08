# 0004: Rules decide; the LLM only drafts

Status: accepted (2026-10-08)

## Context

A smoke test of Qwen3-1.7B (Q4_0) classified a 422 validation error as `provisioning_stall`. Workflow completion must not depend on model quality.

## Decision

Blocker kind, owner department, severity, auto-resolution and nudges come from a pure rule engine (`src/worker/agents/blocker-rules.ts`). The `LlmProvider` seam drafts only the follow-up title and description and may suggest a category, which is stored and compared, never acted on. The default provider everywhere is a deterministic stub; any provider failure falls back to a template.

## Consequences

The "agents" are Agents SDK Durable Objects driven by rules. Readers who assume LLM agents should be told this plainly; the README does.
