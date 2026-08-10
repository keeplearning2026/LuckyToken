# 10 — Compose closed-world Pi invocation options

**What to build:** Combine validated Anthropic controls, Auth facts, HTTP cancellation, and Router defaults into one `ModelsSimpleStreamOptions` value with per-field ownership and precedence, preserving omission and preventing metadata or header bags from becoming semantic escape hatches.

**Blocked by:** 03 — Complete the HTTP, client-auth, and session lifecycle; 05 — Implement Anthropic source-profile and closed-world validation.

**Status:** ready-for-agent

- [ ] Positive `max_tokens` and present `temperature` map exactly; omission remains omission and invalid numeric values fail at the owning gate.
- [ ] `stream` is retained only in Anthropic render state and never changes Provider execution mode.
- [ ] `metadata.user_id` is Client-Protocol-owned and `metadata.projectDir` is Auth-owned; composition merges them per key.
- [ ] Non-owner collisions on reserved metadata keys fail before Pi execution instead of using object-spread precedence.
- [ ] `sessionId` and the HTTP-owned `AbortSignal` have one authoritative source and cannot be overridden by Router defaults.
- [ ] Deferred execution, reasoning, thinking budgets, sampling parameters, cache retention, `onPayload`, and every other must-remain-absent v1 option stay absent.
- [ ] Any other option or metadata key is admitted only by an explicit classified/certified policy; arbitrary client headers are never forwarded generically.
- [ ] Tests cover every user-id/project-dir presence combination, defaults, conflicts, omission, and unsupported-control rejection.

