# 12 — Protect CommandCode request authority and serialization

**What to build:** Treat the CommandCode payload callback as an untrusted, exactly-once semantic boundary while preserving Provider-owned identity, project, permission, capability, response identity, and pricing authority through serialization and retry preparation.

**Blocked by:** 11 — Complete Pi-to-CommandCode request conversion.

**Status:** ready-for-agent

- [ ] Response identity and a deep callback-isolated pricing basis are captured before any untrusted callback.
- [ ] Request-validation authority captures session UUID, permission mode, project config, and supported reasoning efforts before callback execution.
- [ ] Callback-visible project config does not alias authoritative project state, and callback model mutation cannot redefine invocation identity, capability, or pricing.
- [ ] `onPayload` runs at most once per logical invocation, may change only the allowed CommandCode generation surface, and is never rerun on retry.
- [ ] Waiting for an asynchronous callback is raced against caller cancellation; a late rejection is observed without regaining authority.
- [ ] The effective callback object is serialized exactly once, parsed back into a short-lived wire-equivalent validation view, and validated after all getters/`toJSON`/undefined omission effects.
- [ ] Provider-owned fields, `stream=true`, tool relationships, reasoning capability, and required shapes are revalidated against captured authority.
- [ ] The prepared request retains only stable wire/execution facts needed by retries; dead validation snapshots and duplicate semantic representations are discarded.
- [ ] Tests cover mutation, replacement, aliasing, nested `toJSON`, required-field omission, cancellation, pricing mutation, and byte-stable body reuse.

