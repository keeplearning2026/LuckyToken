## Project

Repository:

```text
keeplearning2026/LuckyToken
```

LuckyToken serves client protocol wires through three independent data-plane lanes. The Semantic Conversion lane uses a LuckyToken-owned `Semantic Conversion Invocation` as its shared request Interface. That Interface combines Pi AI IR for conversation/history with typed, protocol-neutral semantic controls and only the bounded request-local conversion facts required for correct final projection. The two native preservation lanes bypass this Interface and remain independent from each other:

```text
Anthropic / OpenAI Responses / other client protocol wires
                              │
             ┌────────────────┼────────────────┐
             │                │                │
             ▼                ▼                ▼
      Local Native     Provider Native     Semantic Conversion
      Preservation      Preservation          Invocation
             │                │                  │
             │                │                  ▼
             │                │         LuckyToken Pi Wrapper
             │                │                  │
             │                │                  ▼
             │                │             Pi Providers
             │                │                  │
             ▼                ▼                  ▼
      Local Upstream   Provider Upstream     Provider Wire
```

The three lanes may share only the minimum request-edge and lifecycle facts needed for routing and observation; they do not share execution, credential, transport, or semantic-conversion abstractions.

## Response Style

Answer the core conclusion first, then give only the necessary evidence.

Be concise by default. Focus on issues that affect correctness, protocol contracts, information boundaries, or architecture decisions. Do not repeat background or expand a full checklist unless explicitly requested.

## Evidence and Design

Before important conclusions or changes, inspect the relevant source, tests, protocol specifications, architecture documents, and reference implementations.

Clearly distinguish:

- confirmed facts;
- current implementation behavior;
- inference or uncertainty;
- proposed design.

Current specifications are working documents. They may be corrected when source evidence or real requirements justify a change.

Prefer the simplest design that is correct. Do not add abstractions, layers, wrappers, registries, or intermediate state unless they solve a demonstrated problem and reduce total complexity.

## Test Safety for User-Owned State

Every test that can reach Codex state must use a newly created temporary `CODEX_HOME`. Copy only the required test inputs into that directory, then read and modify only those copies. Never use a real Codex home as a test write target and never rely on restoring real files after a test.

The standard test guard copies only `config.toml` and `luckytoken-model-catalog.json` when they exist. `models_cache.json`, `auth.json`, native catalogs, sessions, logs, caches, and all other Codex state must not be copied from the user profile; tests that need them must create explicit fixtures in the temporary home.

Pass the temporary `CODEX_HOME` explicitly to every spawned Backend, Codex CLI, Electron, or helper process; setting only `HOME` or `USERPROFILE` is insufficient. Remove the temporary directory in `finally` on success, failure, or cancellation.

Use the repository's guarded npm test commands. A direct test command is allowed only when it creates the same isolated temporary home and modifies copies or test-created fixtures only. Expanding LuckyToken's Codex write set requires updating the specification and this test setup before exercising the new behavior.

## Architecture Principles

Code must be modular.

Each module must have:

- one clear responsibility;
- explicit inputs and outputs;
- a small and stable contract;
- clear ownership and lifecycle of its information.

Design for high cohesion and low coupling.

Information should remain with the module that creates, maintains, and uses it. Other modules should receive only the minimum facts or operations they need. Do not pass broad configuration, mutable state, or internal representations through unrelated modules for convenience.

Prefer one authoritative representation of a fact at each lifecycle stage. Boundary-specific representations are valid when they represent genuinely different protocols, but duplicate semantic models without a clear purpose should be avoided.

Keep model-visible semantics separate from credentials, transport details, logging, timing, request IDs, and other infrastructure state.

## Diagnostics Non-Interference Principle

Diagnostics are a fail-open observation path. Request serving and application work remain authoritative: diagnostics may observe bounded immutable facts, but they must never influence routing, lane selection, credentials, semantic conversion, transport, retry or Profile decisions, cancellation arbitration, HTTP status, headers, body, or terminal outcome.

For diagnostics, Request Journey, capture, logging, telemetry, or request-history work, read `doc/Spec/LuckyTokenRequestJourneyDiagnosticsSpec.md` before designing or changing code.

- Publish observations only through a narrow no-throw, non-blocking Interface. Request and application control paths must not await diagnostics I/O or accept diagnostics backpressure.
- Contain observer validation, queue, worker, redaction, and persistence failures inside the diagnostics module. Such failures may reduce record completeness and raise operational health/attention, but they must not replace, delay, or modify the observed work.
- Apply strict per-event, per-request, and process-wide bounds. Capture copies only at existing ownership seams; never re-read a consumed stream, retain mutable execution objects, inject a transport for observation, or expose credential values.
- Keep lane-specific observation with the lane that owns the facts. Shared diagnostic vocabulary must not create shared execution, credential, transport, or semantic-conversion abstractions.
- Prove non-interference with equivalence tests against diagnostics disabled, including a throwing observer, a saturated queue, and unavailable or slow persistence. The selected lane, outbound request, attempts, response, and terminal outcome must remain identical.

## Compatibility Policy

Unless the user explicitly requests compatibility, implement only the current contract. Replace obsolete configuration, interfaces, state shapes, and code paths instead of adding migrations, shims, dual readers/writers, deprecated aliases, or fallback branches. Tests specify current behavior, not historical behavior.

## Desktop Product Architecture

For Electron, desktop, tray, preload, renderer, local management transport, or desktop product-boundary work, read `doc/Spec/LuckyTokenElectronArchitectureSpec.md` before designing or changing code.

The fixed dependency direction is `Renderer → typed preload → Electron Main → Application Control Plane → Backend Application → Core`. Core owns model-serving semantics; the Application Control Plane is the only management seam into a running Backend; Electron Main owns desktop lifecycle/OS integration; Renderer owns interaction state, never Backend authority.

## Protocol Conversion Usability

Protocol conversion should preserve usability while always producing a valid target-protocol result.

For conversion from protocol A to protocol B:

1. If a clear semantic mapping exists, convert it directly.
2. If B cannot consume a recognized A fact but can validly carry it for a supported later conversion, preserve it through the Intermediate Carrier Principle below.
3. If the fact has neither a direct B mapping nor a valid downstream carrier, omit it and emit a warning.
4. If omitting it would make the result invalid or break security, permissions, tool-call relationships, required output constraints, or other critical semantics, fail the conversion.
5. If B needs a value that A does not provide, use only a default explicitly defined by B or by the adapter contract.
6. If an optional B field has no valid source or defined default, omit it.
7. If a required B field still cannot be constructed, fail with an explicit error.

Never invent defaults or repair malformed semantic state by guessing.

Classify every preserved request control before final projection. An explicit reasoning disable, a required or named tool choice, a structured-output contract, and a Client-specified response-output token ceiling are hard controls. A reasoning effort level, reasoning-summary preference, verbosity, temperature, and other sampling preferences are preferences unless the source protocol gives them stronger semantics. An unsupported hard control fails before Provider dispatch; an unsupported preference produces an `omitted` outcome and warning. A `failed` projection outcome is terminal and can never accompany a dispatched Provider request.

Projection outcomes are the authoritative semantic record. Every omission, content fallback, and repair additionally publishes a bounded request-local developer notice through the fail-open observation seam; observation failure never changes execution. Client responses report only controls proved effective in the final Provider request.

### Intermediate Carrier Principle

Evaluate conversion over the complete supported pipeline `A → B → C`, not only the adjacent `A → B` boundary. B's inability to consume a fact does not by itself justify losing it: when a supported B → C adapter can use that fact, A → B should preserve it so the final C request can restore the strongest valid equivalent.

- Prefer a typed canonical B field when the fact has portable semantics. Otherwise use the smallest bounded, request-local preservation carrier with the original value, source provenance, semantic attachment point, and compatibility conditions needed by the later adapter.
- A carrier transports information without claiming that B applied it. Effective-state responses, diagnostics, and tests must report a control as applied only when the final target builder emitted an equivalent C control.
- The B → C adapter owns final projection. It consumes the preserved fact only for a proven target mapping; once the final target is known and has no valid mapping, apply the normal warning or failure rules above.
- Preserve recognized and validated facts individually. A broad raw-body blob, unvalidated extension bag, Provider request object, or blind copy into B/C wire fields is not a semantic carrier.
- Keep credentials, transport state, retry/lifecycle objects, and unrelated source fields outside the carrier. When B is the Semantic Conversion Invocation, conversation/history belongs in Pi AI IR, portable request behavior belongs in typed semantic controls, and only validated opaque continuity or projection provenance belongs in its narrow request-local conversion context. None belongs in model-visible Pi messages merely to survive conversion.

Prove preservation with an end-to-end test that starts from the A request and asserts the final C Provider request. An intermediate B snapshot alone does not establish support.

### End-to-End Round-Trip Invariant

For every model-visible or replay-required Provider response fact whose Provider adapter contract maps it to a field or relationship in a later Provider request, treat the next full-history client request as the inverse boundary. Under the same resolved Provider/API/model, the final Provider request must restore the adapter-defined replay field, value, attachment point, relationships, and required provenance with semantics equivalent to direct Provider-native replay. Pi AI IR and the client wire are intermediate representations, not the correctness endpoint. A response mapping is incomplete when the client history it emits cannot produce that final Provider-request replay.

This invariant does not apply to response-only observations such as usage, timing, transport status, or diagnostics unless a target protocol explicitly makes them replay semantics. When the resolved target has changed or cannot accept the original representation, preserve the portable model-visible meaning through the best valid target representation and discard only target-bound opaque state. Prove the invariant with an end-to-end response → client history → next Provider request test rather than independent one-way adapter tests alone.

### Online Semantic Certification Boundary

Provider semantic-conversion online tests must send complete Client Wire history and assert the final Provider request after Pi and wrapper projection. Use one independently runnable script per Provider with a fixed Provider/model/Profile target; scripts may share a protocol-neutral harness, but each Provider keeps its own report and exit status.

Keep direct protocol probes separate from real Agent/CLI product tests. A script that constructs OpenAI Responses or Anthropic Messages requests itself certifies that Client Wire → Provider Wire path only; Codex CLI, Claude Code, or another real client must use a separate entry point, report, and exit status to certify its client-owned behavior.

Treat `previous_response_id` as a stateful Codex/Responses client capability, not as a substitute for complete-history Provider semantic certification. Certify it only through the real Codex client or Codex CLI path that owns its state and lifecycle. A generic Provider online script must not claim `previous_response_id`, restart recovery, or incremental-state behavior as evidence that response reasoning, signatures, tool relationships, or other replay semantics were restored in the next Provider request.

### Opaque Continuity Preservation

When a Provider response contains opaque continuity metadata needed to replay that response in a later request, preserve only the metadata that protocol conversion would otherwise lose and that the Provider adapter requires for exact replay.

- Preserve the source provenance and original attachment point needed to restore each opaque value. A signature attached to thinking, text, or a tool call must return to that same semantic block.
- Preserve a validated `redacted` replay representation with an opaque thinking value when the Provider response marks that block as redacted. This representation describes how the target Adapter may replay the value; it does not select a Provider. Restore it only under the same provenance compatibility rule as the opaque value.
- Prefer a client-wire opaque round-trip field when the client sends complete history. Do not add server-side session persistence unless the client wire cannot carry the required state and the product contract explicitly requires server-owned continuation.
- Do not duplicate model-visible text, summaries, tool names, or arguments inside the opaque carrier. Do not preserve values that the resolved target adapter can reconstruct deterministically, such as a known reasoning field selector.
- Restore opaque continuity only when its validated provenance and the resolved target Provider/API/model satisfy the adapter's replay contract. On mismatch, discard the opaque value while preserving visible reasoning through the best valid target representation, falling back to assistant content only when the target cannot accept historical thinking.
- If the client protocol has no valid opaque carrier, apply the normal conversion rules above: omit with a warning, or fail when losing the state would break critical semantics.

These rules apply to semantic-conversion paths in both directions:

```text
Request:  Client Protocol → Semantic Conversion Invocation → LuckyToken Pi Wrapper → Pi Provider → Provider Wire
Response: Pi Provider → Pi AI IR (+ bounded projection provenance when required) → Client Protocol
```

Native wire passthrough is a preservation path rather than protocol conversion and is governed by the Isolation Principle below.

## Isolation Principle

The `Semantic Conversion Invocation` is the authoritative shared request Interface between external client-protocol adapters and Provider-side semantic projection. Pi AI IR remains authoritative for conversation content, history, thinking, and tool relationships, but it is not required to carry every request control. The Invocation may additionally contain `SemanticRequestControls` and the smallest immutable request-local conversion context needed for a proven end-to-end mapping.

- A client-protocol adapter owns Client Wire → Semantic Conversion Invocation and Pi AI response IR → Client Wire conversion. It maps request controls to protocol-neutral semantic values; it does not construct Provider payloads.
- Provider-side semantic projection owns Semantic Conversion Invocation → Provider Wire. It maps the Invocation through Pi native options first and uses a Provider-specific payload projector only for a supported semantic that Pi options cannot express.
- Client-protocol code must not instantiate concrete providers, depend on provider-native semantic types, create an `onPayload` callback, or capture raw Client Wire for later Provider mutation.
- Provider payload projectors must not depend on client-protocol adapter types or raw Client Wire shapes. They consume only typed semantic controls, validated conversion context, resolved Pi Model/API/compatibility facts, and the Provider-native payload type owned by their target.
- Provider-specific or client-protocol-specific fields must not leak into Pi AI IR or `SemanticRequestControls`. Opaque target-bound facts remain in the bounded conversion context with their provenance and compatibility conditions.
- Runtime and composition code may resolve the model and connect the Invocation to the LuckyToken Pi execution wrapper, but it must not itself rewrite Client Wire, Pi AI IR content, semantic controls, or Provider Wire.

### LuckyToken Pi Execution Wrapper

Treat Pi AI as a pinned external dependency. Request-control projection must not modify the Pi AI package or `node_modules`; the LuckyToken wrapper extends Pi execution only through Pi's public options and payload callback seam.

- The wrapper accepts the resolved Pi Model, Pi Context, typed semantic controls, bounded conversion context, and infrastructure options through one request-local Interface.
- The wrapper selects a payload projector from the resolved `model.api` plus certified Provider/model compatibility facts. Client protocol identity alone must never select a projector.
- A deterministic compatibility default defined by the pinned Pi Adapter may be a certified fact only when LuckyToken mirrors that exact version-bound resolver and final-wire tests cover the result. LuckyToken-specific Provider-name, URL, model-name, or payload-shape heuristics are not certified defaults. Re-audit the resolver on every Pi upgrade.
- The wrapper creates and owns `onPayload` after target resolution. The callback captures only normalized semantic controls and validated request-local facts; it never captures raw Client Wire or client-protocol-native objects.
- Pi AI calls `onPayload` after constructing its Provider payload and before sending it. The projector validates the exact audited payload shape, returns a copied payload with only proven Provider-native mappings, and fails rather than guessing when the shape is incompatible.
- Pi AI retains ownership of Provider registration, authentication, base request construction, transport, retry, streaming, response parsing, and Provider Wire → Pi AI IR conversion. The wrapper must not duplicate those implementations.
- An audited Pi native option takes precedence over payload projection. A semantic control must have exactly one authoritative final projection; the wrapper must not set it through both paths.
- Verify exact-value controls and upper-bound controls according to their distinct semantics. Repair a mismatched exact value only when its Provider-native field and replacement are certified, and emit a repair warning. The final Provider request's response-output token ceiling may be lower than the Client-specified ceiling when required by context safety, but it must never exceed that hard limit; a Provider minimum that would exceed it fails rather than widening it. This control does not describe Client input-token size.
- Unknown APIs and unaudited payload shapes cannot receive payload projection. Apply the normal warning or failure rules for every remaining control before execution can silently lose critical semantics.
- End-to-end tests must start with the Client Wire request and assert the final Provider request captured by a test transport after `onPayload` has returned. Projector-only or intermediate payload assertions do not establish support. Every Pi AI dependency upgrade must rerun these wire-contract tests for each supported projector.

### Narrow Cross-Layer Semantic Exceptions

A cross-layer semantic dependency is permitted only when all of the following hold:

1. A demonstrated end-to-end semantic requirement cannot be implemented correctly from the owning layer's local representation alone.
2. Protocol specifications and the pinned Pi Provider adapter identify the exact source fact, target use, compatibility condition, and failure behavior.
3. The dependency is expressed as the smallest immutable request-local fact or capability, not as a Provider instance, native request type, broad configuration, mutable state, or callback into another layer.
4. Credentials, authentication, transport, retry, lifecycle ownership, and execution objects remain within their owning lane and layer.
5. The exception has an explicit typed contract and end-to-end tests covering the supported path, incompatible target, malformed metadata, and model-switch fallback.

Opaque reasoning continuity is a canonical exception: response projection may need the actual upstream Provider/API/model provenance to bind Pi signature fields into a client-carried opaque envelope, while request projection may need the resolved target adapter's replay capability to restore those fields or preserve only the visible reasoning. This does not permit direct Provider imports or weaken the separation between Local Native Preservation, Provider Native Preservation, and Semantic Conversion.

The wrapper-owned `onPayload` function is an internal Provider-side seam, not a callback into the client-protocol layer and therefore not a cross-layer exception.

### Independent Data-Plane Lanes

The Semantic Conversion Invocation, LuckyToken Pi wrapper, and Pi Provider execution are not used when no semantic conversion takes place. LuckyToken has exactly three valid data-plane lanes, and they are independent architectural contracts rather than variants of one shared execution abstraction:

```text
1. Local Native Preservation
   Compatible Client Wire
   → local model recognition
   → local credential authority
   → local native passthrough transport
   → Compatible Upstream Wire

2. Provider Native Preservation
   Compatible Client Wire
   → resolved Pi Model
   → Pi Models credential/auth resolution
   → provider-native passthrough transport
   → Compatible Upstream Wire

3. Semantic Conversion
   Client Wire
   → Semantic Conversion Invocation
   → LuckyToken Pi execution wrapper
   → Pi Provider
   → Provider Wire
```

These lanes must remain independent:

- Local Native Preservation owns its own model recognition, local credential lookup, request construction, transport, and response handling. It must not depend on alias resolution, Pi `Models`, Provider Native Passthrough, Pi AI IR, or Pi Provider execution.
- Provider Native Preservation may use alias/model resolution, the resolved Pi `Model`, `Models.getAuth()`, request-local effective model facts, and provider/protocol-specific transport rules. It must not enter Pi AI IR or Pi Provider execution, and it must not read or reuse Local Native credentials, model registries, transports, or execution abstractions.
- Semantic Conversion owns Client Wire → Semantic Conversion Invocation, Pi AI response IR → Client Wire, the LuckyToken Pi execution wrapper, Provider payload projection, and Pi Provider execution. It must not import, call, or reuse either native passthrough lane's request builders, credential authorities, transports, or response handling.
- The two native lanes must not be unified behind a shared native target, native credential, native executor, native transport, or fallback abstraction. Similar wire-construction code may remain duplicated when sharing it would couple credential ownership or lifecycle.
- Runtime/composition or the Client Protocol edge may select a lane using only the minimum routing facts required by that lane. After a lane is selected and execution begins, failure in that lane must not fall through to another lane.
- Local Native eligibility is established by that integration's explicit local model/capability contract. Provider Native eligibility is established by an explicit `(provider, api/protocol)` transport contract or equivalent model capability; fuzzy provider-name similarity or payload resemblance is not sufficient.
- Native lanes preserve model-visible request and response semantics rather than translating them. Only boundary-required model identity projection, the exact credential-bound Anthropic OAuth body projection defined below, credential/auth transport, header filtering, content encoding, and endpoint construction may alter the wire representation.
- The raw client wire remains authoritative on native lanes. Native passthrough must not reconstruct or semantically normalize unrelated request fields merely to forward them.
- Credentials remain owned by the authority of the selected lane. Local credentials never become Pi Provider credentials; Pi Provider credentials never become Local Native credentials; neither credential representation enters Pi AI IR.
- If serving a request requires semantic reinterpretation, invented defaults, cross-protocol repair, or an uncertain mapping, that request is not native preservation. Route it to Semantic Conversion before execution begins, or fail explicitly if no valid semantic mapping exists.

A Client Protocol edge may invoke narrow lane-specific seams, but it must not implement the concrete transport rules of any lane itself. Local Native, Provider Native, and Semantic Conversion are three separate execution paths with separate ownership and lifecycle.

### Provider Native Request Reconstruction Contract

This contract applies only to Provider Native Preservation. It does not change or extend Local Native Preservation.

For Provider Native, the compatible client request body is authoritative for model-visible semantics. By default, the lane may replace only the boundary-required top-level `model` selector with the resolved Provider model or deployment identity. It must not add, remove, default, repair, normalize, reinterpret, or otherwise change any other body field, value, relationship, or extension. Transport encoding or compression may change only when decoding produces the preserved body with the permitted projection.

There is exactly one declared body-projection exception: first-party Anthropic `anthropic-messages` under an exact request-bound `oauth` Profile. That combination may additionally apply only the OAuth-dependent request-body transformations confirmed by the pinned Pi Agent Anthropic implementation, including the required Claude Code system identity and Claude Code tool-name projection across tool definitions and related message references. The captured Profile `authType`, not token text, selects this exception. The projection must preserve every unrelated client-authored semantic and fail before upstream execution when the required transformation cannot be performed without guessing or repair.

The Anthropic OAuth exception is owned entirely by the Anthropic Provider Native lane as a narrow, pure body-projection implementation. It must not import, invoke, wrap, or reuse Pi AI IR, Pi Provider execution, Semantic Conversion body construction, or another Native lane. No other Provider, API/protocol, auth type, or future Pi change inherits this exception. Expanding it requires source evidence and an explicit architecture-contract change.

Provider Native is not blind HTTP passthrough. It must reconstruct the upstream request envelope that the pinned Pi Agent Provider implementation would send, using only:

- the resolved Pi `Model` and its effective Provider/API compatibility facts;
- the exact request-bound Provider Profile, its authoritative auth type, and the `AuthResult` resolved under that binding;
- the selected Provider operation and request-local lifecycle facts;
- the pinned Pi Agent Provider implementation as a mirror reference, never as a shared runtime execution path.

Every upstream fact whose correct value can vary with the Profile, authentication type, resolved Model, Provider, or Pi Agent wire behavior must be generated or overwritten by the Provider Native lane. This includes method and endpoint where applicable, base URL, authentication, account identity, Provider/model headers, version/beta/intent headers, session/request headers, SDK identity/User-Agent, accept/content type, and content encoding/compression. An inbound client value with the same name is not authoritative and cannot override the reconstructed value.

Provider Native must not expose a generic inbound request-header passthrough. If a compatible client protocol carries a client-owned, model-visible header fact that must survive native preservation, the explicit `(provider, api/protocol, operation)` contract must name, validate, and re-project that fact through a lane-owned Interface. It must never override a Profile/Pi-owned fact.

Provider Native Responses and Semantic Conversion/Pi AI IR are absolutely uncoupled execution paths. Provider Native Responses must not import, call, wrap, or reuse Pi AI IR types, Client Wire ↔ Pi AI IR adapters, Pi Provider execution, Semantic Conversion request builders, transports, retry state, credential-binding Adapter, or response handling. Semantic Conversion must not import, call, wrap, or reuse Provider Native request reconstruction, transport, retry state, credential-binding Adapter, or response handling. Each lane may independently consume the minimum shared request-edge/lifecycle facts and the Backend-lifetime Pi `Models` capabilities already allowed above, but no shared execution or credential object may cross between them.

Architecture and wire-contract tests must enforce the default model-only body rule, the exact Anthropic OAuth exception, the envelope ownership rules, and the bidirectional dependency prohibition above. A violation is an architecture error and a release blocker, even if the observed Provider response appears correct.

The CommandCode private provider must implement and register through the same Pi Provider contract and invocation path as Pi built-in providers. It is a LuckyToken implementation detail. External protocol adapters and public interfaces may use it only through the standard Pi model/provider path and must not directly instantiate, import, or special-case its private implementation.

## Reference Principle

Before rebuilding an existing capability, inspect both the pinned runtime `pi-ai` package and the repository's `pi-agent` mirror source. For payload projection, confirm that the selected Pi Provider implementation invokes `onPayload`, identify the exact object shape passed at that seam, and inspect its native option mapping and response parser.

Pi AI implementations of:

```text
Pi AI IR + Pi options → provider-native request
provider-native response → Pi AI IR
```

are version-bound mirror references for LuckyToken's external protocol conversion and Provider payload projectors. Do not assume the transformations are strictly reversible or that payload shapes remain stable across dependency upgrades; check missing fields, explicit defaults, information loss, semantic differences, and final wire tests.

Relevant external references project i:

- reference/cc-switch
- reference/opencodex

When they address the same problem, compare their actual problem, information flow, module boundaries, conversion strategy, provider extension model, advantages, limitations, and applicability.

Reference projects are evidence and design sources, not architectures LuckyToken must copy. Final decisions must follow LuckyToken's actual requirements, correctness, isolation, and minimum total complexity.

## Implementation Rule

For non-trivial changes:

1. identify the real problem and information flow;
2. identify information ownership, contracts, lifecycle, and failure conditions;
3. choose the smallest coherent change;
4. add or update tests for the intended semantic behavior.

Prefer explicit TypeScript types, small focused modules, visible control flow, pure functions where practical, and minimal dependencies. Avoid unrelated refactoring.
