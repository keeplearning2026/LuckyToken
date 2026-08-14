# Ticket Index — Frozen Protocol Conversion Refactor

| # | Title | Blocked by | Status |
|---:|---|---|---|
| 01 | Establish adapter-owned configuration seams | None | completed |
| 02 | Add request-local notices and per-failure journals | 01 | completed |
| 03 | Expand a protocol-neutral upstream failure contract | None | completed |
| 04 | Complete the protocol-neutral Pi options composer | None | completed |
| 05 | Preserve Anthropic message order and system-prompt semantics | 01, 02 | completed |
| 06 | Enforce Anthropic tool lifecycle and local missing-result repair | 05 | completed |
| 07 | Map Anthropic sampling, thinking budgets, and cache policy | 01, 02, 04 | completed |
| 08 | Cover Anthropic known content, tools, and execution ownership | 05, 06, 07 | completed |
| 09 | Project Pi responses faithfully into Anthropic messages | 01, 02 | completed |
| 10 | Render Anthropic JSON, atomic SSE, and protocol errors | 02, 03, 09 | completed |
| 11 | Certify and harden native Anthropic passthrough | 01, 02 | completed |
| 12 | Rebuild Responses local response state | 01, 02 | ready-for-agent |
| 13 | Convert Responses privileged prompts, options, and handles | 01, 02, 04, 12 | ready-for-agent |
| 14 | Convert Responses text, images, files, and reasoning continuity | 02, 13 | ready-for-agent |
| 15 | Complete Responses function/custom/namespace tool lifecycles | 01, 02, 13 | ready-for-agent |
| 16 | Cover every known Responses input-item and tool family | 14, 15 | ready-for-agent |
| 17 | Build complete Pi-to-Responses objects and effective echoes | 01, 02, 13, 16 | ready-for-agent |
| 18 | Render Responses atomic SSE and protocol errors | 02, 03, 17 | ready-for-agent |
| 19 | Implement and certify native Responses passthrough | 01, 02 | ready-for-agent |
| 20 | Align CommandCode scalar options and synchronous execution | 01, 02, 04 | completed |
| 21 | Convert Pi messages and CommandCode-local missing results | 02, 20 | completed |
| 22 | Convert CommandCode tools and degrade constrained sampling | 02, 20 | ready-for-agent |
| 23 | Certify CommandCode request authority and payload hooks | 20, 21, 22 | ready-for-agent |
| 24 | Rebuild CommandCode JSONL event, identity, pause, and abort lifecycle | 01, 02, 03 | ready-for-agent |
| 25 | Convert CommandCode success into normalized Pi responses | 24 | ready-for-agent |
| 26 | Move CommandCode failures and retries onto the neutral contract | 03, 23, 24, 25 | ready-for-agent |
| 27 | Remove the shared HTTP observer and legacy error side channels | 10, 18, 26 | ready-for-agent |
| 28 | Rebind full-route conformance and architecture certification | 05, 06, 07, 08, 09, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27 | ready-for-agent |

## Dependency graph

```text
01 → 02
03 ────────────────────────────────────────┐
04 ────────────────────────────────────────┤
                                            │
Anthropic: 05 → 06 ─┐                       │
            07 ─────┴→ 08                  │
            09 → 10 ───────────────────────┤
            11 ────────────────────────────┤
                                            │
Responses: 12 → 13 → 14 ─┐                 │
                   15 ────┴→ 16 → 17 → 18  ├→ 27 → 28
                   19 ─────────────────────┤
                                            │
CommandCode: 20 → 21 ─┐                    │
                  22 ──┴→ 23               │
             24 → 25 ─────→ 26 ───────────┘
```
