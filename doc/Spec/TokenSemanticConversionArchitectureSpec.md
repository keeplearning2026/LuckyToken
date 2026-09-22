# Token Semantic Conversion Architecture

Status: **CURRENT — Pi AI 0.86.1 boundary**

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
2. if it is a stable cross-Provider semantic, extend the Pi public contract separately;
3. if it is Client/Provider-private and non-critical, omit it with a warning or require
   Native Preservation for exact retention;
4. if loss would invalidate the request, alter role/permission/security/residency
   meaning, remove model-visible content, or break tool relationships, fail before
   dispatch.

There is no intermediate projection supplement. Client-only render or continuity state
is named for that purpose and is never a Provider-write candidate.

## 5. Common option contracts

The production runtime applies Token's minimal, reviewed Pi patch
(`patches/@earendil-works+pi-ai+0.86.1.patch`, applied by the `patch-package`
postinstall) to the installed `@earendil-works/pi-ai@0.86.1`. The three reasoning
states, the hard output ceiling, and the neutral `toolChoice`/`parallelToolCalls`
contract described below are part of that patched common contract; the unmodified
upstream package does not provide all of them. The checked-in `pi-agent/` tree is
reference material at the `0.86.1` snapshot and is not what executes. Remove the
patch when an accepted pinned Pi release provides the same contract.

### 5.1 Reasoning

Pinned Pi exposes:

```ts
reasoning?: ModelThinkingLevel
```

Its three states are:

- omitted: preserve Provider/model default;
- `"off"`: explicit disable;
- enabled level: select using `getSupportedThinkingLevels()` and
  `clampThinkingLevel()`, with `Model.thinkingLevelMap` as the mapping authority.

Providers choose their own legal wire representation. Client Protocol code never writes
`reasoning_effort`, `thinking`, `output_config`, or `thinkingConfig` to Provider payloads.

### 5.2 Output limit

`maxTokens` is a hard upper bound on total Provider output, including hidden reasoning.
An adapter must not widen it. A Provider minimum above the bound fails before dispatch;
Token does not locally truncate output.

### 5.3 Other controls

Only Pi public options with a single neutral meaning may cross the boundary. In the
current contract this includes `temperature`, `cacheRetention`, session identity,
`parallelToolCalls`, and the full neutral `toolChoice` union (`auto`, `none`,
`required`, and `{ type: "tool", name }`). A Client Protocol maps every form it consumes
onto that union; it does not pre-degrade a form because one Provider cannot express it.
The selected Pi Provider/API adapter either maps the control, safely ignores or omits
it, optionally reports that disposition through a Provider-owned notice channel, or
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
