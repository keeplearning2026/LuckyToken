# 16 — Implement Core atomic execution and abort-aware commit

**What to build:** Actively consume the Pi assistant stream into exactly one request outcome, committing only a supported, internally consistent successful terminal while keeping the HTTP-owned AbortSignal independently authoritative until that commit.

**Blocked by:** 02 — Establish the minimal text walking skeleton.

**Status:** ready-for-agent

- [ ] Execution invokes `Models.streamSimple` with the resolved Model, converted Context, and composed options and adopts the returned stream as the outcome channel.
- [ ] The stream is actively drained so intermediate events cannot accumulate unboundedly; intermediate partial state never becomes the request result.
- [ ] Success requires a done reason of stop, length, or toolUse, matching `done.message.stopReason`, with the request signal still live at the commit point.
- [ ] Error terminals preserve only `aborted | error`; raw exception text is diagnostic and is never reparsed into architectural categories.
- [ ] Every wait for Pi progress races request cancellation, so a stalled stream cannot hide a disconnect or timeout.
- [ ] Cancellation before commit wins over a late ordinary error or done terminal; cancellation after commit affects delivery only.
- [ ] Deferred terminal state is rejected as unsupported by Core v1.
- [ ] An actually observed iterator end without semantic terminal fails defensively; EOF is never treated as success.
- [ ] No execution state is shared across requests, no partial tool call survives failure, and no second terminal can change a committed outcome.

