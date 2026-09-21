# LuckyToken Agent Instructions

## Project

Repository: `keeplearning2026/Token`.

Token serves Client Protocol wires through three independent data-plane lanes:

```text
Direct Mode                  Provider Native Preservation
compatible wire ───────────> compatible Provider wire

Semantic Conversion
Client Wire → Client Protocol → Pi Context/options → Pi Models
→ TranscriptContext → Pi Provider → Provider Wire
```

Direct Mode and Provider Native Preservation bypass every Semantic Conversion module
and remain independent from each other.

## Response style

Lead with the conclusion and give only evidence needed for correctness, protocol
contracts, information boundaries, or architecture decisions.

## Evidence and design

Before important conclusions or changes, inspect relevant source, tests, specifications,
and reference implementations. Distinguish confirmed facts, current behavior, inference,
and proposed design.

Prefer the simplest correct design. Do not add wrappers, registries, bags, or
intermediate state without demonstrated need and lower total complexity.

## Test safety for user-owned state

Every test that can reach Codex state must use a newly created temporary `CODEX_HOME`.
Copy only required inputs, pass that path explicitly to every Backend, CLI, Electron, or
helper process, and remove it in `finally`.

The standard guard copies only `config.toml` and `token-model-catalog.json` when present.
Never copy `models_cache.json`, `auth.json`, native catalogs, sessions, logs, or caches
from the user profile. Use repository guarded npm test commands unless a direct command
creates the same isolation.

## Architecture principles

Each module has one responsibility, explicit inputs/outputs, a small stable contract,
and clear information ownership. Prefer one authoritative representation at each
lifecycle stage. Boundary-specific representations are valid for genuinely different
protocols. Prefer controlled local duplication to shared semantic models that couple
Client Protocols.

Keep model-visible semantics separate from credentials, transport, logging, timing,
request IDs, and other infrastructure state.

## Semantic Conversion boundary

For Semantic Conversion work read
`doc/Spec/TokenSemanticConversionArchitectureSpec.md`. For Responses also read its
architecture spec and implementation record; for Anthropic read its equivalents.

Each Client Protocol owns:

- its Client grammar and demand-driven request conversion;
- its Pi `Context`/common options invocation;
- protocol-specific reasoning and continuity over Pi semantic fields;
- its execution coordinator and response conversion;
- Client render/state facts, warnings, errors, and certification tests.

Client Protocol modules do not share a semantic invocation, reasoning request model,
semantic executor, response state, or semantic error type. They do not import one
another.

Pi Models owns Provider resolution, authentication application, `Context`
normalization, and dispatch. A Pi Provider/API adapter owns `TranscriptContext` →
Provider request, Provider validation/transport, and Provider response → Pi
`AssistantMessage`.

### Forbidden projector architecture

The following are forbidden in OpenAI Responses and Anthropic Semantic Conversion:

- Provider-payload projectors or target projector registries;
- projection Supplements or Provider-write candidate carriers;
- source-protocol × target-API payload matrices;
- Provider-native request imports or payload-shape assertions;
- protocol-created `onPayload` callbacks;
- reasoning/tool/output-limit/compatibility repair after Pi builds a payload;
- hiding Client/Provider fields in `samplingParams`, generic `metadata`, diagnostics, or
  untyped extension bags.

No compatibility projector, empty registry, renamed repair layer, or dormant legacy path
may remain. Delete obsolete files once production references are gone.

### Context boundary

Client converters output public Pi `Context`. They never construct
`TranscriptContext`. Pi Models normalizes before Provider dispatch. Custom Provider
streams receive `TranscriptContext` and use Pi transcript helpers. Direct Provider tests
must normalize their fixtures explicitly.

### Demand-driven extraction

Each protocol spec names positive request consumers. An unclaimed field is not parsed or
shape-validated; its presence may produce a bounded fail-open warning.

For a consumed fact:

1. map to a neutral Pi semantic when one exists;
2. consider a Pi public-contract extension only for stable cross-Provider semantics;
3. omit/warn or require Native Preservation for optional private controls;
4. fail before dispatch when loss would invalidate the request, remove model-visible
   content, alter permission/security/residency meaning, or break tool relationships.

No raw Client body, Provider request, credentials, transport, retry state, or mutable
lifecycle object may be carried through semantic state.

### Reasoning

Pinned Pi distinguishes:

```text
reasoning omitted → Provider/model default
reasoning "off"  → explicit disable
reasoning level  → enabled level
```

`Model.thinkingLevelMap` is the level-data authority. Pi public
`getSupportedThinkingLevels()` and `clampThinkingLevel()` own selection. Provider-native
reasoning fields belong only to Pi Provider/API adapters.

### Continuity

Opaque continuity may carry only validated Provider provenance and attachment-local
state required for replay through Pi content fields. Preserve the original
thinking/text/tool-call attachment, restore only to a compatible Provider/API/model,
and preserve visible meaning on mismatch. Never duplicate visible text, summaries,
tool names, or arguments in an opaque envelope.

Certify continuity end to end:

```text
Provider response → Pi AssistantMessage → Client response
→ next complete-history Client request → Pi Context → Pi Provider request
```

Final Provider requests in these tests prove module composition; they do not make the
Client Protocol a Provider Wire owner.

### `onPayload`

Pi `onPayload` is allowed only for Provider tests, bounded diagnostics, and explicit
low-level infrastructure observation. Production Semantic Conversion does not create or
depend on it. Observation copies immutable bounded facts, returns the original payload
unchanged, contains failures, and is semantically removable.

## Diagnostics non-interference

For diagnostics work read `doc/Spec/TokenRequestJourneyDiagnosticsSpec.md`.

Diagnostics observe bounded immutable facts through a no-throw, non-blocking interface.
They never influence routing, lane selection, credentials, conversion, transport,
retry, cancellation, status, headers, body, or terminal outcome. Contain validation,
queue, worker, redaction, and persistence failures. Prove equivalence with diagnostics
disabled, throwing, saturated, slow, and unavailable.

## Compatibility policy

Unless explicitly requested, implement only the current contract. Replace obsolete
interfaces and paths instead of adding migrations, shims, dual readers/writers,
deprecated aliases, or fallback branches.

## Independent lanes

Direct Mode owns its model recognition, preserved caller envelope, fixed transport, and
response handling. It does not use aliases, Pi Models, Pi IR, Provider Native code, or
local credential authority.

Provider Native Preservation may use resolved Pi Model/auth facts but never enters Pi IR
or Pi Provider execution and never borrows Direct Mode request builders or transports.

Semantic Conversion uses Client Protocol modules and Pi Provider execution and never
imports either preservation lane's request builders, credentials, transports, or
response handling.

## Desktop product architecture

For Electron/Desktop work read `doc/Spec/TokenElectronArchitectureSpec.md`. Dependency
direction is `Renderer → typed preload → Electron Main → Application Control Plane →
Backend Application → Core`.
