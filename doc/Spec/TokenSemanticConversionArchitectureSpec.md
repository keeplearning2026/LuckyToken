# Token Semantic Conversion Architecture

Status: **CURRENT — clean upstream Pi AI 0.87.0 boundary**

## 1. Scope

Token has three independent data-plane lanes:

```text
Direct Mode                 Provider Native Preservation
Client Wire ──────────────> compatible Provider Wire

Semantic Conversion
Client Wire
  → Client Protocol
  → Pi Context + ModelsSimpleStreamOptions
  → Pi Models
  → normalizeContext()
  → Pi Provider
  → Provider Wire
```

The preservation lanes never enter Pi semantic conversion. Semantic Conversion never
imports their transports, credentials, or request builders.

## 2. Ownership boundary

Client Protocol modules own:

- Client Wire grammar and demand-driven validation;
- Client Wire → Pi `Context` and Pi common options;
- protocol-local reasoning/continuity preparation that changes only Pi semantics;
- Pi `AssistantMessage` → Client Wire;
- Client response echo, render, and continuity state;
- protocol-local warnings and typed Client failures.

Pi Models owns Provider resolution, authentication application, `Context` normalization,
and dispatch. Pi Provider/API adapters own `TranscriptContext` interpretation, Provider
request construction and validation, transport, response parsing, and Provider Wire → Pi
`AssistantMessage`.

Therefore Client Protocol production code must not:

- inspect, validate, clone, replace, or repair a Provider payload;
- define a target Provider projector or projector registry;
- import Provider-native request types;
- use `onPayload` for semantic correctness;
- smuggle Client or Provider fields through `samplingParams`, generic `metadata`,
  diagnostics, or untyped extension bags.

`Context` is the Client-facing Pi boundary. `TranscriptContext` is Provider-facing and
is created only by Pi normalization. A Client converter never constructs a
`TranscriptContext`.

## 3. Protocol locality

Each Client Protocol remains a cohesive vertical module. It owns its request converter,
protocol-local invocation, continuity codec, reasoning preparation, execution
coordination, response converter, and tests. Client Protocol modules do not import one
another and do not share a semantic invocation, reasoning request model, semantic
executor, response state, or semantic error type.

Protocol locality does not grant Provider Wire ownership. Provider variation is behind
the Pi Provider interface, never behind a source-protocol × target-API matrix.

Mechanism-only leaf utilities may be shared when they contain no Client policy,
Provider-native mapping, execution lifecycle, or mutable semantic state.

## 4. Demand-driven conversion

Each protocol specification declares the Client fields it consumes. An undeclared field
is not parsed or shape-validated. Its presence may produce a bounded fail-open warning.

For every consumed fact:

1. map it to an existing neutral Pi semantic;
2. if upstream Pi has no public representation and the fact is a non-critical control
   preference, omit it with a bounded warning and retain Pi/Provider defaults;
3. if exact retention of such a control is required, use Native Preservation rather
   than modifying or patching Pi;
4. if loss would invalidate the request, alter role/permission/security/residency
   meaning, remove model-visible content, or break tool relationships, fail before
   dispatch.

There is no intermediate projection supplement. Client-only render or continuity state
is named for that purpose and is never a Provider-write candidate.

## 5. Common option contracts

The production runtime pins the **unmodified upstream**
`@earendil-works/pi-ai@0.87.0`. Token has no `patch-package` postinstall and carries no
Pi patch artifact. Semantic Conversion is therefore bounded by the public Pi 0.87
`Context` and `ModelsSimpleStreamOptions` contracts.

### 5.1 Reasoning

Upstream Pi exposes selectable reasoning levels through `SimpleStreamOptions.reasoning`.
Omission preserves the Provider/model default. If a Client Protocol explicitly requests
reasoning disabled but Pi has no neutral public representation for that request, Token
omits the control, emits a bounded Client-owned warning, and retains the Pi/Provider
default. Enabled levels continue to use `getSupportedThinkingLevels()` and
`clampThinkingLevel()`, with `Model.thinkingLevelMap` as the mapping authority.

Providers choose their own legal wire representation. Client Protocol code never writes
`reasoning_effort`, `thinking`, `output_config`, or `thinkingConfig` to Provider payloads.

### 5.2 Output limit

Client `max_tokens` / `max_output_tokens` map to Pi `maxTokens`. From that boundary
onward, Provider-side output budgeting, including reasoning-budget and Provider-minimum
adjustment, belongs to Pi. Token does not patch Pi's budgeting algorithm or impose a
second Provider-output ceiling.

### 5.3 Other controls

Only controls representable by the upstream Pi public contract cross the semantic
boundary. In Pi 0.87 this includes `temperature`, `cacheRetention`, session identity,
and `toolChoice` values `auto` / `none`. Consumed non-structural controls without a Pi
representation — currently explicit reasoning-off, required/named tool choice, and
`parallel_tool_calls` intent — are omitted with a bounded Client-owned warning while
messages and the full applicable tool catalog are retained. Exact preservation belongs
to Local Native or Provider Native Preservation.

The selected Pi Provider/API adapter then maps the remaining Pi semantic controls to its
Provider wire representation, safely ignores or omits unsupported Provider details, or
rejects the request when omission would invalidate it. A control with no neutral Pi
contract yet, such as a hosted-tool choice, is omitted with a bounded Client warning by
the owning protocol specification; exact wire retention requires Native Preservation.

Client response echo is Client-owned state. It reports the normalized Client contract,
not a claim about a Provider-native field. Provider application is never inferred from
payload inspection.

## 6. Continuity

Opaque continuity is the narrow cross-layer exception. A protocol may carry validated
Provider provenance and attachment-local opaque values through Client Wire when Pi
already exposes the corresponding semantic block fields. It must:

- preserve the original thinking/text/tool-call attachment point;
- restore only for a compatible Provider/API/model;
- keep visible meaning when opaque state is incompatible;
- avoid duplicating model-visible text or tool arguments in the envelope;
- fail when losing the value breaks a critical relationship.

Certification follows the complete loop:

```text
Provider response → Pi AssistantMessage → Client response
→ next complete-history Client request → Pi Context → Pi Provider request
```

The final Provider request in this test is evidence that independently owned modules
compose; it does not give the Client Protocol ownership of that request.

## 7. Execution and observation

The shared Semantic Conversion execution capability accepts only Models, resolved Model,
`Context`, Pi options, diagnostic sinks, and an optional infrastructure observation
capability. It contains no Client field mapping or target selection.

Before any Profile credential attempt, one Pi Context compatibility wrapper adapts only
model-resolved Pi IR. Supported mid-conversation system semantics pass through by
identity. Unsupported pure-text mid-system may degrade to user content; if preserving
ToolCall/ToolResult relation requires relocation, the wrapper validates only the minimum
tool-exchange conditions required for that move and emits an explicit degradation
notice. It does not validate the whole tool history. Unsafe or unprovable degradation
fails before Provider attempts. Profile retry then wraps the raw policy-free Pi execution
operation, so one request performs compatibility once even when Provider credentials are
retried.

Pi `onPayload` remains legal for Provider tests, bounded diagnostics, and explicit
low-level infrastructure hooks. Client Protocol production modules do not create it.
Neutral Core execution may install it for diagnostics; that observation must return the
original payload unchanged, fail open, and remain semantically removable.

## 8. Testing

- Client tests assert Client Wire → Pi Context/options + Client state.
- Provider tests assert `TranscriptContext` + options → exact Provider request and Pi
  response. CommandCode Private owns exhaustive final-wire validation.
- Response tests assert Pi `AssistantMessage` → Client Wire.
- Continuity tests certify the complete replay loop.
- Composition smoke/online tests may capture Pi-built payloads without mutating them.
- Architecture guards enforce the dependency and deletion rules.

Every test that can reach Codex state uses the guarded temporary `CODEX_HOME` runner.

## 9. Hard invariants

1. No production `projection/` or projection-supplement directory exists under a Client
   Protocol.
2. No Client Protocol production module creates or mutates `onPayload`.
3. Client converters output `Context`; Provider-facing custom streams receive
   `TranscriptContext`.
4. CommandCode native fields are created only by CommandCode Private.
5. Provider-private controls are not hidden in Pi IR or generic bags.
6. Tool identity/result relationships, model-visible content, and permission/security
   constraints are preserved or fail explicitly.
7. Removing diagnostics and request observation does not change request or response
   semantics.
8. Adding or deleting one Client Protocol requires no Provider-native mapping change in
   another Client Protocol.
