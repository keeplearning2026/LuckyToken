# Token Provider Native Anthropic Contract

Status: **Implemented — offline certification required for release**

This document defines only the Token Provider Native preservation lane for
`api=anthropic-messages`. It does not define Semantic Conversion and does not
change the source Anthropic Messages wire specification.

The shared acceptance criteria are defined in
[Provider Native correctness and certification](TokenProviderNativeCorrectnessSpec.md).
This contract owns the Anthropic-specific allowed transformations and differences.

## Request authority

The client JSON value is the model-visible semantic authority. Provider Native
may apply only:

1. the boundary-required top-level `model` projection;
2. for first-party Anthropic with a captured managed OAuth Profile, the
   certified Claude Code identity/tool-name differential.

After those projections, Token passes the JSON value to the pinned
`@anthropic-ai/sdk` and calls `client.beta.messages.create(...)`. The SDK owns
JSON serialization and the HTTP request envelope. Raw JSON whitespace, property
formatting, and numeric lexical spelling are therefore not preservation
requirements. Unknown fields and nested values must remain semantically present,
and no unrequested body field may be injected.

The captured credential branch is authoritative. A managed `api_key` Profile
never becomes OAuth because its token text resembles an OAuth token. An ambient
binding likewise does not invent a managed auth type.

## Envelope parity

The Native lane mirrors pinned Pi client construction for the reviewed branch:

- endpoint/resource method, including `?beta=true`;
- API-key, Bearer, GitHub Copilot, or composed Provider-owned auth headers;
- Pi/Claude CLI user-agent identity and `x-app` where applicable;
- Anthropic version, Stainless SDK identity/retry/timeout headers;
- reviewed `anthropic-beta` derivation and override precedence;
- reviewed session-affinity and Copilot dynamic headers.

Client transport headers do not override these facts. The effective request
timeout is passed explicitly from the protocol handler. SDK retries remain
disabled, so every physical attempt reports `x-stainless-retry-count: 0`.

The closed certification data is
`src/provider-native-anthropic/certification.ts`. It records the reviewed
provider/API/operation/auth branches and is not a runtime registration point.

Two bounded differences from Pi are recorded rather than counted as parity:
Pi derives `mid-conversation-tool-changes-2026-07-01` from `Context` facts that
the Native lane does not own, so Native does not reconstruct that beta. A
Cloudflare binding containing only `cf-aig-authorization` is accepted by Pi's
auth guard but rejected by its SDK before fetch; Native explicitly omits the
SDK's absent `x-api-key` and `authorization` headers so the certified Provider
binding can dispatch. The latter exception is tested against the pinned Pi
runtime and must be removed when Pi dispatches the same binding.

## Response ownership

The transport module owns only request projection, SDK envelope construction,
and dispatch; it returns the real upstream `Response` without reading its body.

The lane response-processing stage owns atomic buffering, safe response-header
filtering, Provider usage observation, retry/profile-switch classification, and
optional client-facing model-alias projection. A body-read failure is therefore
a pre-commit response-processing failure, not a transport-envelope failure.

## Isolation

This lane may consume resolved Pi `Model`, `AuthResult`, and the captured
Provider binding, but it never enters Pi IR, Pi Provider execution, or the
Anthropic Semantic Conversion implementation. It does not share a transport
implementation with Provider Native Responses.

## Certification

Release certification requires:

- full method/URL/header parity against the pinned Pi/vendor-SDK behavior for
  every reviewed auth branch where Pi dispatches, with the two bounded
  differences above certified separately;
- JSON-semantic body preservation plus no unrequested field injection;
- negative client-header override cases;
- request-timeout and physical-attempt identity checks;
- 429 Profile switching that rebuilds auth and SDK identity for the new bound
  Profile;
- response fidelity, cancellation, safe header filtering, and lane isolation.

Online canaries are a separate release gate and must not be inferred from
offline test success.
