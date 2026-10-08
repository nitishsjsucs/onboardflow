# 0007: @cloudflare/vitest-plugin instead of @cloudflare/vitest-pool-workers

Status: accepted (2026-10-08)

## Context

The portfolio standard names `@cloudflare/vitest-pool-workers`. Version 0.23.0 is deprecated ("renamed to @cloudflare/vitest-plugin") and pins wrangler 4.124.0 and an older miniflare.

## Decision

Use `@cloudflare/vitest-plugin` 1.4.0, which pins wrangler 4.149.0 and miniflare 5.20261006.1-alpha (matching the toolchain) and supports vitest 4.1. The API (`cloudflareTest`, `cloudflare:test`) is the same.

## Consequences

A deliberate departure from the stated standard, recorded here.
