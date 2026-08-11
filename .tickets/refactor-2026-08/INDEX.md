# Ticket Index — LuckyToken Protocol Conversion Refactor

## Anthropic side (Anthropic ↔ Pi AI IR) — independent chain

| # | Title | Blocked by | Status |
|---|-------|-----------|--------|
| 01 | Align Anthropic request source validation with the conversion method | None | ready-for-agent |
| 02 | Align Anthropic request → Pi invocation construction | 01 | ready-for-agent |
| 03 | Complete model-aware Anthropic validity and invocation composition | 02 | ready-for-agent |
| 04 | Align Anthropic response conversion | 03 | ready-for-agent |
| 05 | Align Anthropic JSON and Atomic SSE rendering | 04 | ready-for-agent |

## CommandCode side (Pi AI IR ↔ CommandCode Private) — independent chain

| # | Title | Blocked by | Status |
|---|-------|-----------|--------|
| 06 | Align CommandCode request headers, config, and top-level fields | None | ready-for-agent |
| 07 | Align CommandCode params scalar controls | 06 | ready-for-agent |
| 08 | Align CommandCode message and tool conversion | 07 | ready-for-agent |
| 09 | Align CommandCode message sequence and synthetic tool results | 08 | ready-for-agent |
| 10 | Align CommandCode final request assembly and serialization | 09 | ready-for-agent |
| 11 | Align CommandCode response reconstruction | 10 | ready-for-agent |
| 12 | Align CommandCode → Pi response conversion | 11 | ready-for-agent |

## Runtime / integration

| # | Title | Blocked by | Status |
|---|-------|-----------|--------|
| 13 | Keep runtime, attempts, and cancellation uncoupled | 10, 11 | ready-for-agent |
| 14 | Rebind certification and docs to the revised conversion documents | 13 | ready-for-agent |

## Dependency graph

```text
Anthropic side:        01 → 02 → 03 → 04 → 05
CommandCode side:      06 → 07 → 08 → 09 → 10 → 11 → 12
Runtime:               10, 11 → 13 → 14
```

The two side chains are fully independent: they share only the Pi IR
contracts and meet at the runtime/certification layer.

## Frontier (can start now)

- 01 — Anthropic request source validation
- 06 — CommandCode request headers/config/top-level
