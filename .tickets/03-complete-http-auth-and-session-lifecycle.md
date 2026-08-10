# 03 — Complete the HTTP, client-auth, and session lifecycle

**What to build:** Accept or reject inbound LuckyToken requests at the HTTP edge, normalize one logical session identity for each authorized request, and keep connection cancellation authoritative without leaking raw credentials or whole-request objects into deeper modules.

**Blocked by:** 02 — Establish the minimal text walking skeleton.

**Status:** ready-for-agent

- [ ] Method, path, content type, request-size, raw body, and response-writability checks are owned by the HTTP boundary.
- [ ] Client authorization consumes only a read-only header view and returns either denial or normalized `sessionId` plus optional `projectDir`.
- [ ] Known client session sources follow one explicit precedence rule; absent or unusable identity receives one fresh request-local fallback identity.
- [ ] The normalized session identity reaches Pi `Options.sessionId` and becomes both CommandCode `threadId` and `x-session-id` without regeneration.
- [ ] Raw credentials, token classification, header aliases, and lookup state die at the Auth boundary.
- [ ] Client disconnect, timeout, or shutdown aborts the request signal; no later result writes to a closed response.
- [ ] Tests cover authorization denial, supplied identity, fallback identity, conflicting aliases, disconnect, and late terminal arrival.

