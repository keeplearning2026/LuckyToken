# Ticket Index — OpenAI Responses Client Protocol

| # | Title | Blocked by | Status |
|---|-------|-----------|--------|
| 01 | Durable session state with previous_response_id expansion | None | ready-for-agent |
| 02 | Responses wire → Pi IR request conversion | 01 | ready-for-agent |
| 03 | Pi IR → Responses wire response + atomic SSE rendering | 02 | ready-for-agent |
| 04 | OpenAI Responses handler orchestration (auth, errors, cancellation) | 02, 03 | ready-for-agent |
| 05 | Composition registration, configuration, and docs | 04 | ready-for-agent |

## Dependency graph

```text
01 → 02 → 03 → 04 → 05
```

## Frontier (can start now)

- 01 — Durable session state
