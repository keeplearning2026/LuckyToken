# Token Product Limitations

Status: current
Authority: product limitations
Scope: known limitations that follow from the current Token contracts and capability
boundaries. This document does not track implementation defects awaiting repair.

## Codex subagent with a Provider Native CommandCode Responses model

Affected combination:

- Client: Codex multi-agent/subagent
- Upstream Provider: `commandcode-goat`
- Provider API: `openai-responses`
- Lane: Provider Native Preservation
- Confirmed model: `deepseek/deepseek-v4.1-flash`

### Trigger

A request contains a Codex-private Responses input item with
`type: "agent_message"`. In the observed subagent traffic, each such item also
contained an `encrypted_content` content part.

These are not standard OpenAI Responses input forms:

- `agent_message` is a Codex multi-agent transport item.
- `encrypted_content` as a message content part is Codex-private envelope data.

### Observed behavior

`commandcode-goat` rejects the request before generation:

```json
{
  "error": {
    "message": "Invalid input",
    "type": "invalid_request_error",
    "param": "input"
  }
}
```

Because the request uses a public model alias, Token's Provider Native Responses
alias-safety rule replaces the upstream error with a fixed client-visible 502:

```json
{
  "error": {
    "message": "Upstream provider failed",
    "type": "api_error",
    "code": null,
    "param": null
  }
}
```

The upstream 400 remains visible in Request Journey diagnostics. Retrying the
same conversation does not change the result because the unsupported item remains
part of the complete history.

### Why this is a product limitation

Provider Native Preservation forwards the compatible Client Wire as the
authoritative request body. It changes only boundary-required facts such as the
top-level model selector; it does not reinterpret Client-private items through Pi
AI IR.

The CommandCode Goat Responses upstream accepts ordinary Responses messages and
the surrounding Codex request fields, but it does not accept:

- `type: "agent_message"`; or
- `encrypted_content` as a message content part.

Semantic Conversion already has a bounded representation for `agent_message`:
it converts the visible text to a user message and omits the inaccessible
encrypted envelope. However, the current Provider Native eligibility contract
claims this model from model/provider/API facts alone, before the lane can be
changed. Once the native lane is committed, failure cannot fall through to
Semantic Conversion.

This is therefore a capability boundary of the current product contract, not an
upstream outage, a concurrency failure, a credential failure, or a response
lifecycle-normalization defect.

### User impact

- A Codex subagent using this exact model and Provider Native lane cannot complete
  its first request.
- All later requests in the same subagent context repeat the 502 while the
  unsupported item remains in history.
- Other sessions and ordinary Codex requests using the same Provider and model
  can continue to succeed.

### Current workaround

Do not select a Provider Native CommandCode Responses model as the model for a
Codex subagent. Use a model/path that either:

- accepts the Codex-private agent message wire; or
- reaches an eligible Semantic Conversion path that can represent the visible
  message without Provider Native claim.

### Removal condition

This limitation is removed only when one of the following is implemented and
certified:

1. Provider Native eligibility detects Codex-private unsupported input forms
   before lane commitment and lets the request use its normal Semantic
   Conversion eligibility path.
2. The CommandCode Goat Responses upstream explicitly accepts and preserves
   `agent_message` and its Codex-private content parts.

The fix must be decided before lane commitment. A post-failure fallback from
Provider Native to Semantic Conversion would violate the independent-lane
contract and is not an acceptable removal path.
