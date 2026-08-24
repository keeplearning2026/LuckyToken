# Protocol Conversion Architecture and Policy

Status: **Frozen design**  
Scope: LuckyToken Client Protocol adapters, three independent Data Plane lanes, Pi semantic-conversion boundary, Provider adapters, native preservation, configuration, notices, failures, and failure logs.

This document is normative. The protocol-specific conversion documents refine it but MUST NOT contradict it.

## 1. Exactly three independent execution lanes

LuckyToken has exactly three peer Data Plane execution contracts. They may share only minimum request-edge/lifecycle facts such as request identity, cancellation, timing, and observation; they do not share credential authority, native executor/transport, or semantic-conversion state.

### 1.1 Direct Mode

```text
Compatible Client wire
→ explicit local model/capability recognition
→ preserved caller envelope
→ direct request construction/transport
→ protocol-compatible upstream wire
```

This lane deliberately does not enter Pi. Its model eligibility, caller envelope, fixed endpoint construction, transport, and response handling are local-integration-owned.

Requirements:

1. Eligibility comes from an explicit local model/capability contract, never fuzzy name similarity or payload resemblance.
2. Raw compatible Client wire remains authoritative for model-visible fields; unrelated fields are not reconstructed through a semantic DTO.
3. Caller credentials remain opaque Client Wire facts forwarded only to the fixed Direct Mode upstream; LuckyToken does not validate them or reuse them as Pi/Provider credentials.
4. End-to-end headers, including caller credentials and cookies, are preserved. Host, length, hop-by-hop/connection-declared fields and WebSocket handshake transport headers are rebuilt; stale response representation headers are removed when Fetch exposes decoded bytes.
5. Failure after this lane begins does not fall through to Provider Native or Semantic Conversion.

### 1.2 Provider Native Preservation

```text
Compatible Client wire
→ resolved Pi Model
→ Pi Models credential/auth resolution
→ explicit (provider, api/protocol) native transport contract
→ protocol-compatible provider wire
```

This lane also bypasses Pi AI IR and Pi Provider semantic execution. It may use Pi model/catalog/auth facts because those are the authoritative Provider identity/credential source, but it must not reuse the Direct Mode caller envelope/transport or Client↔Pi conversion code.

Requirements:

1. Eligibility is established by an explicit Provider/protocol transport contract or equivalent model capability; Provider-name similarity is insufficient.
2. Raw Client wire remains authoritative for model-visible fields. Only boundary-required model identity projection, credential/auth transport, safe header filtering, encoding, and endpoint construction may alter the wire representation.
3. Provider credentials remain owned by Pi Models/Provider auth resolution and never become Direct Mode caller-wire facts or Pi AI IR content.
4. Failure after this lane begins does not fall through to Direct Mode or Semantic Conversion.

### 1.3 Semantic Conversion

```text
Client wire
  ↕ Client Protocol adapter
Pi Context / AssistantMessage / Tool / ToolCall / ToolResult / Usage
  ↕ Provider adapter
Provider wire
```

Pi is the only shared semantic boundary for this lane.

- A Client adapter knows only its Client wire and Pi public contracts.
- A Provider adapter knows only Pi public contracts and its Provider wire.
- Runtime/composition selects and connects the two sides but does not translate concrete cross-side semantics.
- A Client adapter cannot inspect concrete Provider implementation/configuration/wire fields merely to drive conversion.
- A Provider adapter cannot inspect Anthropic, Responses, or another Client protocol.
- No shared protocol DTO or second semantic IR may bypass Pi.
- A conversion handler MUST NOT inject a custom `fetch` to observe Provider traffic. The selected Provider owns its transport and may expose failure facts only through trusted protocol-neutral Pi diagnostics.

### 1.4 Shared native-preservation rules

The two native lanes are separate architectures, not two adapters behind one generic native executor. Similar wire code may remain duplicated when sharing it would couple credential ownership or lifecycle.

Both native lanes:

1. use separate conformance tests/metrics/documentation from Semantic Conversion;
2. do not treat native success as evidence that Pi conversion is complete;
3. preserve body/status/cancellation/protocol semantics as far as the owning transport contract permits;
4. render pre-commit failures in the same native protocol and follow that protocol's streaming failure lifecycle after commit;
5. use narrow lane-owned transports that are never reused as conversion observers or as evidence for a Pi execution;
6. must route to Semantic Conversion **before execution begins** when serving the request requires semantic reinterpretation, invented defaults, cross-protocol repair, or an uncertain mapping.

## 2. Conversion priorities

The conversion objective is useful model service, not mechanical equality of every auxiliary field.

### 2.0 Client Protocol isolation

Anthropic Messages and OpenAI Responses are independent adapters. Their only shared semantic dependency is the public Pi contract.

They MUST NOT share:

- conversion policy objects or configuration types;
- request/response converter implementations;
- message/tool correlation maps;
- unresolved-call repair state or repair helpers;
- discriminator catalogs;
- render state or response DTOs;
- session/resource authority;
- passthrough compatibility classifiers;
- protocol-specific error mapping;
- one adapter's tests as conformance evidence for the other.

The adapters may independently choose identical literals or defaults. Identical values do not create a shared semantic capability: each adapter defines, validates, emits notices for, and tests its own behavior. Protocol-neutral Runtime facilities such as bounded transport, cancellation, request IDs, structured logging sinks, and Pi execution may be reused only through narrow generic contracts containing no Anthropic or Responses terminology.

### 2.1 Core model semantics

These facts have the highest preservation priority:

- ordered conversation messages;
- system prompt and privilege boundary;
- current executable tool catalog;
- ToolCall ID, name, arguments, and order;
- ToolResult call ID, tool name, error state, content, and order;
- call/result lifecycle validity;
- model-visible text, images, and reasoning that Pi can represent.

Loss, reordering, guessing, or accidental rejection of these facts is normally P0 or P1.

### 2.2 Auxiliary controls and metadata

Examples include sampling controls, cache hints, presentation options, service tiers, output formatting hints, parallelism preferences, and provider-specific metadata.

- If Pi has a public corresponding field, the adapter MUST convert it.
- If Pi has no corresponding field, the adapter normally drops it and documents the degradation.
- Dropping an auxiliary field MUST NOT invent a model-visible replacement.
- A source-side hard requirement may be deliberately degraded for availability only when the exact exception is frozen and, where required, emits a notice.

### 2.3 Target defaults

When the source omits a field and the target defines a default, the target default applies. The adapter MUST distinguish:

- source absence;
- source explicit disable/off/null;
- an adapter-chosen fallback;
- a target or model default whose actual value may be unknown.

An adapter fallback MUST NOT be described as a Pi or Provider default.

## 3. No fabrication rule

An adapter may omit or deterministically degrade existing source information. It MUST NOT add model-visible facts that are absent from the source.

Each Client Protocol may independently implement the approved model-visible synthetic repair for a missing ToolResult belonging to a known unresolved ToolCall:

```text
No result — the tool call did not complete (interrupted or lost).
```

Within an adapter, the synthetic result:

- preserves the original call ID and tool name;
- has `isError: true` in Pi;
- is inserted only where a call exists and its result is absent;
- never replaces or edits a real result;
- emits a request-local conversion notice;
- is implemented inside that adapter. Anthropic and Responses do not share a repair helper, correlation state, configuration type, or notice code merely because the visible fallback text is identical;
- is independently implemented by the CommandCode Provider where its own target adjacency needs it. Client and Provider sides do not share policy or state.

## 4. Unknown, unsupported, and malformed are distinct

### 4.1 Unknown discriminator

A future content/item/event discriminator may represent a new core lifecycle. Each adapter/direction owns and implements its own local `error | ignore` policy, default `error`. Configuration keys, discriminator catalogs, notice codes, and tests remain adapter-local; this document does not define a cross-protocol unknown-policy object.

Ignoring an unknown terminal event never creates success. A valid known terminal remains required.

### 4.2 Added field on a known object

An unknown auxiliary property on a known object is ignored unless the target contract requires closed-world validation for authority or security.

### 4.3 Known but unsupported

A known source family is classified individually as exact mapping, deterministic degradation, documented drop, resolver-dependent conversion, or conversion error. It does not use the unknown-discriminator switch.

### 4.4 Known malformed lifecycle

Malformed known tool calls/results, duplicate results, partial structured calls, invalid required IDs, and invalid JSON arguments follow fixed validation rules. They are not made valid by `unknown=ignore`.

## 5. Configuration ownership

There is no global `error | ignore | xrepair` switch.

```json
{
  "clientProtocols": {
    "anthropic-messages": {
      "conversion": {
        "request": {},
        "response": {}
      }
    },
    "openai-responses": {
      "stateFile": "...",
      "conversion": {
        "request": {},
        "response": {}
      }
    }
  },
  "providerPackages": {
    "some-external-user-provider-package": {}
  },
  "failureLogging": {}
}
```

`providerPackages` is only for explicit external/user Provider Packages. Bundled product Providers such as `@luckytoken/provider-commandcode-private` are product composition and MUST NOT be repeated there.

Rules:

- Each Client Protocol or Provider Package parses, validates, defaults, snapshots, and freezes its own policy.
- Invalid values or unknown configuration keys fail startup.
- Composition locates and binds a capability through the standard Pi Provider path but does not copy its business rules.
- Client Protocol configuration cannot name or inspect a Provider.
- Provider configuration cannot name or inspect a Client Protocol.
- Timeouts, retries, and read limits belong to the adapter that performs the operation. They are grouped by request/response ownership and are not mislabeled as semantic conversion policy.
- Protocol correctness invariants are not optional switches.

## 6. Conversion notices

A request-local structured notice is emitted for:

- an approved xrepair;
- a configurable explicit ignore;
- an explicit hard-control degradation such as CommandCode dropping `constrainedSampling.require`;
- a frozen compatibility repair such as an empty Anthropic thinking signature;
- a configured behavior that overrides caller intent, such as persisting `store:false`.

Ordinary fixed drops of auxiliary fields with no Pi correspondence are documented but do not create per-request noise.

Minimum notice shape:

```ts
interface ConversionNotice {
  adapter: string;
  direction: "request" | "response";
  code: string;
  jsonPath?: string;
  action: "ignore" | "degrade" | "xrepair";
}
```

Notices are non-model-visible and request-local. They MUST NOT contain prompt text, tool output, file bytes, credentials, raw bodies, or mutable shared state.

## 7. Tool lifecycle invariants

1. Preserve source order across ordinary content, ToolCall, and ToolResult boundaries.
2. A duplicate ToolResult is always an error.
3. Orphan-result behavior is defined independently in each Client Protocol conversion document. Runtime and another Client adapter do not provide that policy.
4. An unresolved ToolCall follows the owning adapter's `error | xrepair` policy. The frozen default is xrepair.
5. A structured call/output with `in_progress`, `incomplete`, partial arguments, or unknown completion status is an error.
6. ToolResult images are retained where the target supports images. Where CommandCode cannot represent them, images are dropped, text is retained, and an image-only result becomes an empty text value so correlation remains intact.
7. `Context.tools` contains the complete current Client/BYOT executable catalog. Dynamic tool reference events may map to `addedToolNames`; they do not hide tools from the catalog.
8. Provider/server-hosted execution is not represented as a Pi client-executable tool. Its representable result becomes ordered Pi content or a deterministic transcript; pure lifecycle metadata is dropped.

## 8. Failure facts across Pi

Observer side channels, including invocation-local wrappers whose latest result
is read by a Client handler, are forbidden. Conversion handlers do not inject a
custom `fetch` into Pi options in order to observe Provider traffic.

Provider failures cross the runtime only through Pi public contracts and LuckyToken control-plane errors:

- `AssistantMessage.errorMessage` is a log-private human fallback and has no
  authority for Client rendering;
- a Provider may attach a protocol-neutral structured upstream failure to
  `AssistantMessage.diagnostics`;
- Execution validates that diagnostic and preserves it as
  `ExecutionFailure.failure` for the selected Client renderer;
- no handler parses a Provider-specific string to recover semantics;
- no Client adapter reads concrete Provider vocabulary.

Only `ExecutionFailure.failure` has authority to select a Provider-derived
status, type, code, safe message, request ID, or allowlisted header. If a Pi error
terminal has no validated structured failure fact, the Client renderer returns
the fixed generic upstream response: HTTP 502, its protocol-local `api_error`
shape, and `Upstream provider failed`. It MUST NOT expose `errorMessage`, an
exception message, or other unstructured diagnostic text.

Suggested neutral classes include HTTP failure, upstream-stream failure, transport failure, timeout, configuration, protocol, conversion, callback, and caller cancellation. Facts may include validated status, provider type/code as opaque strings, safe message, bounded body snapshot metadata, retryability, attempt count, and allowlisted request IDs.

Rules:

- no status is invented from text;
- wire `abort` is not caller cancellation;
- HTTP 200 plus a semantic stream error may carry a meaningful non-200 failure status;
- body capture is bounded and request-local;
- headers use a fixed safety allowlist;
- Authorization, Cookie, Set-Cookie, proxy credentials, and hop-by-hop headers are never forwarded and cannot be enabled by configuration;
- failures before SSE commit return the Client protocol's non-streaming error response;
- failures after commit follow that protocol's streaming failure lifecycle.
- native failure fidelity belongs to the already-selected Direct Mode or Provider Native lane and its narrow transport; it is not a fallback acquisition path for Semantic Conversion.

## 9. Per-failure request journal

Every final failed inbound request creates one JSON failure log. A logical request with retries still creates one file.

### 9.1 Identity and location

- File name uses an internally generated high-entropy request ID, never a raw caller ID.
- Default location is next to the active configuration under `logs/failed-requests/YYYY-MM-DD/`.
- `failureLogging.directory` may override the location.
- Write through a same-directory temporary file and atomic rename.
- Restrict permissions to the current user where the platform supports it.

### 9.2 Safe content

Default `detail: "safe"` records:

- time and internal request ID;
- Client protocol and opaque model selector;
- failure stage and normalized class;
- client response status;
- structured conversion notices and JSON paths;
- retry/attempt summaries;
- bounded, redacted exception chain;
- safe request-id/trace-id values;
- types, counts, lengths, hashes, and truncation indicators for sensitive structures.

It does not record credentials, authorization/cookie headers, full model messages, system prompts, tool outputs, image/file bytes, or arbitrary raw upstream bodies.

`detail: "full"` may include the full Client request and an approved bounded upstream snapshot, but credentials, cookie/auth headers, and binary file/image content remain permanently excluded. Startup emits a clear sensitive-data warning.

### 9.3 Limits and failure behavior

- Configure `maxFileBytes`, `retentionDays`, and `maxFiles`.
- Cancellation/client disconnect logging is configurable and defaults to enabled.
- When size is exhausted, preserve the core classification and add truncation metadata.
- Journal failure is reported to stderr/telemetry but never replaces the original protocol error.
- Journal state is request-local and is never added to Pi Context or a session store.

## 10. Severity model

- **P0**: cross-request disclosure, unsafe shared state, or broad real-world loss of a core prompt/message path.
- **P1**: core message/tool/system identity, order, lifecycle, or a legal primary path is rejected.
- **P2**: auxiliary controls, usage, identity, SSE schema, or error detail are incomplete while the main answer remains usable.
- **Documented degradation**: an auxiliary source field has no target slot, or a reviewed mild semantic change is accepted for availability.
- **Evidence insufficient**: behavior requires real Provider samples or online verification; passing unit/replay tests does not upgrade it to confirmed.

## 11. Conformance rule

For every supported route, certification MUST state which profile was exercised:

- `native-passthrough`, or
- `client-wire → Pi → provider-wire`.

No test may use one profile to claim coverage for the other.
