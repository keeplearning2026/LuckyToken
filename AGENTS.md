## Project

Repository:

```text
keeplearning2026/Token
```

Token serves client protocol wires through three independent data-plane lanes. Within Semantic Conversion, each Client Protocol owns a cohesive vertical module: Client Wire conversion, its protocol-specific invocation and supplement, reasoning/continuity policy, target projection policy, semantic execution lifecycle, response conversion, and certification tests. Client Protocol modules do not share a semantic invocation, supplement, reasoning request model, projector registry, semantic execution Module, projection outcome type, or semantic error type. They may call the same pinned Pi AI dependency through an existing narrow infrastructure capability and may reuse proven mechanism-only leaf utilities, but no Token Semantic Conversion kernel is shared between Client Protocols. The two native preservation lanes bypass every Semantic Conversion module and remain independent from each other:

```text
Anthropic / OpenAI Responses / other client protocol wires
                              │
             ┌────────────────┼────────────────┐
             │                │                │
             ▼                ▼                ▼
      Local Native     Provider Native     Protocol-owned
      Preservation      Preservation      Semantic Module
             │                │                  │
             │                │                  ▼
             │                │       Protocol-owned Semantic
             │                │              Execution
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

The standard test guard copies only `config.toml` and `token-model-catalog.json` when they exist. `models_cache.json`, `auth.json`, native catalogs, sessions, logs, caches, and all other Codex state must not be copied from the user profile; tests that need them must create explicit fixtures in the temporary home.

Pass the temporary `CODEX_HOME` explicitly to every spawned Backend, Codex CLI, Electron, or helper process; setting only `HOME` or `USERPROFILE` is insufficient. Remove the temporary directory in `finally` on success, failure, or cancellation.

Use the repository's guarded npm test commands. A direct test command is allowed only when it creates the same isolated temporary home and modifies copies or test-created fixtures only. Expanding Token's Codex write set requires updating the specification and this test setup before exercising the new behavior.

## Architecture Principles

Code must be modular.

Each module must have:

- one clear responsibility;
- explicit inputs and outputs;
- a small and stable contract;
- clear ownership and lifecycle of its information.

Design for high cohesion and low coupling.

Information should remain with the module that creates, maintains, and uses it. Other modules should receive only the minimum facts or operations they need. Do not pass broad configuration, mutable state, or internal representations through unrelated modules for convenience.

Prefer one authoritative representation of a fact at each lifecycle stage. Boundary-specific representations are valid when they represent genuinely different protocols. Prefer local, controlled duplication over a shared semantic model that makes independently evolving Client Protocols change together.

Keep model-visible semantics separate from credentials, transport details, logging, timing, request IDs, and other infrastructure state.

### Client Protocol Locality Principle

Each Client Protocol Semantic Conversion module owns its complete source-to-target policy. Adding, changing, or deleting one Client Protocol must be local to that protocol's module and composition registration.

For Semantic Conversion locality or module-seam work, read `doc/Spec/TokenSemanticConversionArchitectureSpec.md`. For OpenAI Responses conversion, additionally read `doc/Spec/TokenOpenAIResponsesSemanticConversionArchitectureSpec.md`, `doc/Spec/TokenOpenAISemanticConversionImplementationPlan.md`, and `doc/OpenAIResponsesPiProviderRequestFieldAudit.md`. For Anthropic Messages conversion, additionally read `doc/Spec/TokenAnthropicSemanticConversionArchitectureSpec.md` and `doc/Spec/TokenAnthropicSemanticConversionImplementationPlan.md`.

- A Client Protocol owns its request conversion, protocol-specific invocation, supplement, reasoning request and continuity codec, target projector registry, semantic execution lifecycle, response conversion, and tests.
- Client Protocol modules do not import one another. A common semantic-control union, common supplement, common reasoning request model, common projector registry, common semantic executor, common projection-outcome union, or common semantic error class spanning Client Protocols is not an allowed extension seam.
- Each Client Protocol's semantic executor owns its Pi options, exclusive `onPayload` lifecycle, projection-operation invocation, conflict/failure enforcement, typed semantic rejection, final outcome collection, and invocation of the existing Pi execution capability. No shared Token wrapper owns these semantics on behalf of multiple Client Protocols.
- The existing Pi execution capability is an infrastructure dependency, not a Semantic Conversion Module or extension seam. It contains no Client field mapping or projection policy, and Client Protocol modules do not import one another through it.
- During decoupling, copy the required spec-conforming implementation into the owning Client Protocol module, then cut only that protocol's imports and composition over to its local copy. Do not modify a shared file while another protocol still uses it. After every production caller has cut over and dependency tests prove zero references, delete the obsolete shared semantic files and directory rather than retaining a dormant compatibility path.
- Protocol-owned target projectors may deliberately duplicate mappings used by another Client Protocol. Extract a shared leaf utility only after two implementations prove identical mechanics and the utility can remain unaware of both source protocols and their semantic policies.
- Locality never justifies losing a fact claimed by a protocol-owned consumer. Each Client Protocol must audit its complete consumer-declared request surface and complete target response surface independently. For every supported source/target pair, prove Client request → final Provider request, Provider response → Client response, and every replay-required response → next complete-history Provider request.
- `onPayload` is request-only. It cannot recover a Provider response fact already discarded by a Pi response parser. Each Client Protocol therefore owns target-aware response interpretation from the actual Pi `AssistantMessage` provenance and must classify unavailable Provider response facts as a valid target default/null, warning omission, visible fallback, or critical conversion failure without guessing.
- Developer notices for omission, fallback, or repair are published only through the fail-open observation seam. They never become Client Wire fields unless that Client protocol defines an explicit standard or approved extension field for them.
- No central Client Protocol enum or `switch (clientProtocol)` selects semantic execution behavior. Register a new protocol at composition without modifying an existing protocol module.
- Architecture tests must enforce these dependency directions and prove that a protocol can be added or removed without editing another Client Protocol module or a common Semantic Conversion executor.

## Diagnostics Non-Interference Principle

Diagnostics are a fail-open observation path. Request serving and application work remain authoritative: diagnostics may observe bounded immutable facts, but they must never influence routing, lane selection, credentials, semantic conversion, transport, retry or Profile decisions, cancellation arbitration, HTTP status, headers, body, or terminal outcome.

For diagnostics, Request Journey, capture, logging, telemetry, or request-history work, read `doc/Spec/TokenRequestJourneyDiagnosticsSpec.md` before designing or changing code.

- Publish observations only through a narrow no-throw, non-blocking Interface. Request and application control paths must not await diagnostics I/O or accept diagnostics backpressure.
- Contain observer validation, queue, worker, redaction, and persistence failures inside the diagnostics module. Such failures may reduce record completeness and raise operational health/attention, but they must not replace, delay, or modify the observed work.
- Apply strict per-event, per-request, and process-wide bounds. Capture copies only at existing ownership seams; never re-read a consumed stream, retain mutable execution objects, inject a transport for observation, or expose credential values.
- Keep lane-specific observation with the lane that owns the facts. Shared diagnostic vocabulary must not create shared execution, credential, transport, or semantic-conversion abstractions.
- Prove non-interference with equivalence tests against diagnostics disabled, including a throwing observer, a saturated queue, and unavailable or slow persistence. The selected lane, outbound request, attempts, response, and terminal outcome must remain identical.

## Compatibility Policy

Unless the user explicitly requests compatibility, implement only the current contract. Replace obsolete configuration, interfaces, state shapes, and code paths instead of adding migrations, shims, dual readers/writers, deprecated aliases, or fallback branches. Tests specify current behavior, not historical behavior.

## Desktop Product Architecture

For Electron, desktop, tray, preload, renderer, local management transport, or desktop product-boundary work, read `doc/Spec/TokenElectronArchitectureSpec.md` before designing or changing code.

The fixed dependency direction is `Renderer → typed preload → Electron Main → Application Control Plane → Backend Application → Core`. Core owns model-serving semantics; the Application Control Plane is the only management seam into a running Backend; Electron Main owns desktop lifecycle/OS integration; Renderer owns interaction state, never Backend authority.

## Protocol Conversion Usability

Semantic Conversion is **demand-driven**: extract only the Client facts needed to construct the strongest valid target request. Whole-schema validation is not a conversion goal.

### Demand-Driven Source Extraction

Each Client Protocol specification names its request consumers and the source fields or paths each consumer reads. One protocol-owned conversion operation creates consumer-specific views before parsing or validation.

- A source field is supported only by a positive consumer declaration. A field declared by no consumer remains unread: it is not parsed, shape-validated, projected, guessed, or used as a dispatch condition.
- Consumer declarations are the only field authority. An omission warning may be derived from the fields present minus the union of those declarations, but this derived observation is not an unsupported, ignored, rejected, or non-projection field registry.
- Consumer declarations may overlap only when the protocol contract requires Pi-first emission followed by final-wire verification or certified repair. The final Provider field still has one authoritative writer and one outcome.
- A consumer validates only the values and nested paths it reads. Unclaimed sibling keys do not invalidate a claimed object.
- Reject only when a consumed value is malformed, a minimum request fact is missing, a security, permission, or data-residency constraint would be broken, a tool-call/result relationship is invalid, or no valid final target request can be constructed.
- Native Preservation lane commitment precedes Semantic Conversion extraction. Native lanes preserve the authoritative raw wire and do not apply semantic consumer declarations.

Every unclaimed-field warning is bounded, request-local, and fail-open. Observation failure never changes routing, conversion, dispatch, or the Client result.

### Mapping and Availability

For every extracted fact:

1. Use a direct semantic mapping when one is certified.
2. Otherwise preserve it in a protocol-owned carrier only when a current supported downstream Adapter can use or must verify it.
3. If no exact target mapping exists, apply the owning Client Protocol's one declared bounded fallback; otherwise omit it with a warning.
4. Fail only for a separately declared non-degradable fact or when the final result would be invalid or unsafe.
5. Use only defaults defined by the target protocol or Adapter contract. Omit an optional target field with no source or defined default; fail if a required target field still cannot be constructed.

A bounded fallback records `degraded` and never claims exact application. A normal omission records `omitted`. A terminal `failed` outcome never accompanies Provider dispatch. A global `ignoreErrors`, raw-body pass-through, guessed field mapping, or end-user strict-mode switch is not an availability policy.

Projection outcomes are the authoritative semantic record. Effective-state response fields report only facts proved in the final Provider request. Repairs, omissions, and fallbacks additionally publish bounded fail-open developer notices.

### OpenAI Responses Consumers and Candidate-Only Supplement

OpenAI Responses has exactly two request consumers:

1. the main Responses consumer, which constructs selector, session/render facts, Pi Context/options, tools, and reasoning semantics; and
2. `ResponsesProjectionSupplement`, which carries facts that at least one current target Adapter can project or must verify/repair in the final Pi-built Provider payload.

The exact consumer allowlists and overlap are owned by `doc/Spec/TokenOpenAIResponsesSemanticConversionArchitectureSpec.md`. Adding an OpenAI Responses request field requires adding a positive consumer there and proving its Client Wire → final Provider Wire behavior. A field in neither consumer remains outside Semantic Conversion.

`ResponsesProjectionSupplement` is an immutable candidate carrier, not a patch list or dispatch gate:

- An equivalent Pi mapping remains unchanged and records `pi-native`.
- A missing Pi mapping receives one certified target write and records `payload-projected`.
- An incorrect Pi mapping is repaired only for a certified target field, value, and compatibility condition; the repair is warned.
- A positive-only target Adapter consumes only candidates it can prove. The Responses coordinator resolves every remaining candidate as `omitted` with a warning. Candidate unavailability never produces `failed`, throws, or prevents dispatch.
- A named bounded approximation records `degraded` and never appears as an exact effective-state fact.
- `max_output_tokens` is preserved or repaired to a certified ceiling no greater than the Client value. A target without a certified ceiling warns, omits the control, and still dispatches; Token does not truncate model output locally.
- Projector exceptions are limited to incompatible audited payload shapes, duplicate final-field ownership, or invalid final payload construction. Consumed-source and non-degradable failures are enforced before this seam.

### Intermediate Carrier Principle

Evaluate the complete supported pipeline `A → B → C`, not only `A → B`.

- First construct the strongest correct Pi Context and options from demand-driven source facts.
- Carry a remaining Pi-unrepresentable fact only when a current certified downstream Adapter consumes it or must verify it. A source field with no consumer remains unextracted; a fact owned for session, response, or rendering does not enter the projection carrier without a downstream projection consumer.
- Prefer a typed canonical field. Otherwise use the smallest bounded, immutable, request-local carrier containing only the value, source provenance, attachment point, and compatibility facts the later Adapter requires.
- The selected Provider-side Adapter is positive-only and projects only its proven subset. Adding one carrier fact does not require no-op or unsupported branches in every Adapter.
- Resolve unconsumed carried facts centrally under the owning protocol's declared omission, bounded fallback, or separately declared critical-failure policy.
- A carrier preserves information without claiming application. Only the final Provider request and projection outcome establish effectiveness.
- Keep raw Client bodies, unvalidated extension bags, Provider requests, credentials, transport, retries, mutable lifecycle state, and unrelated source facts outside the carrier.

Prove every carried fact from Client Wire through the final Provider request. An intermediate Pi or carrier snapshot is not support evidence.

### End-to-End Round-Trip Invariant

For every model-visible or replay-required Provider response fact whose Provider adapter contract maps it to a field or relationship in a later Provider request, treat the next full-history client request as the inverse boundary. Under the same resolved Provider/API/model, the final Provider request must restore the adapter-defined replay field, value, attachment point, relationships, and required provenance with semantics equivalent to direct Provider-native replay. Pi AI IR and the client wire are intermediate representations, not the correctness endpoint. A response mapping is incomplete when the client history it emits cannot produce that final Provider-request replay.

This invariant does not apply to response-only observations such as usage, timing, transport status, or diagnostics unless a target protocol explicitly makes them replay semantics. When the resolved target has changed or cannot accept the original representation, preserve the portable model-visible meaning through the best valid target representation and discard only target-bound opaque state. Prove the invariant with an end-to-end response → client history → next Provider request test rather than independent one-way adapter tests alone.

### Online Semantic Certification Boundary

Provider semantic-conversion online tests must send complete Client Wire history and assert the final Provider request after Pi and payload projection. Use one independently runnable script per Client Protocol and Provider with a fixed Provider/model/Profile target. Scripts may share only mechanism-level server, capture, and reporting utilities; request construction, expected semantics, Provider-wire assertions, report, and exit status remain protocol- and Provider-owned.

Keep direct protocol probes separate from real Agent/CLI product tests. A script that constructs OpenAI Responses or Anthropic Messages requests itself certifies that Client Wire → Provider Wire path only; Codex CLI, Claude Code, or another real client must use a separate entry point, report, and exit status to certify its client-owned behavior.

Real-client evidence is protocol-specific: use Codex CLI only for the OpenAI Responses Client lane and Claude Code/Claude CLI only for the Anthropic Messages Client lane. Codex CLI cannot certify Anthropic Messages behavior.

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
Request:  Client Protocol → protocol-owned Semantic Module, including execution → Pi Provider → Provider Wire
Response: Pi Provider → Pi AI IR (+ protocol-owned bounded continuity when required) → Client Protocol
```

Native wire passthrough is a preservation path rather than protocol conversion and is governed by the Isolation Principle below.

## Isolation Principle

Each protocol-owned Semantic Invocation is authoritative only inside its Client Protocol module. Pi AI IR remains authoritative for that module's conversation content, history, thinking blocks, and tool relationships, but it is not required to carry every request control. No Invocation type crosses into another Client Protocol module.

- A Client Protocol request converter owns Client Wire → protocol-owned Invocation. Its sibling response converter owns Pi AI response IR → Client Wire.
- The same protocol's projection module owns Invocation → Provider Wire policy. It maps through audited Pi options first and uses its own target projector only for a supported source-to-target semantic.
- Request converters do not construct Provider payloads, create `onPayload`, instantiate concrete Providers, or capture raw Client Wire for later mutation. They return typed, immutable protocol-owned facts.
- Protocol-owned projectors do not consume raw Client Wire or parser-internal objects. They consume only that protocol module's validated Invocation, resolved Pi Model/API/compatibility facts, and the audited Provider payload shape.
- Provider-specific fields stay out of Pi AI IR. Client-specific facts stay inside their owning protocol module and are never added to a global semantic-control bag.
- Runtime and composition resolve the model and invoke the selected protocol's semantic executor. They do not rewrite Client Wire, Pi AI IR content, protocol-owned controls, or Provider Wire.

### Protocol-owned Semantic Execution

Treat Pi AI as a pinned external dependency. Request-control projection must not modify the Pi AI package or `node_modules`; each Client Protocol's semantic executor extends Pi execution only through Pi's public options and payload callback seam.

- The protocol-owned semantic executor accepts the resolved Pi Model, that protocol's Pi Context/options and typed semantic facts, plus the existing narrow Pi execution capability through a small request-local Interface owned by the same protocol.
- It selects its target projector from the resolved `model.api` plus certified Provider/model compatibility facts. It has no dependency on another Client Protocol's registry, mappings, semantic executor, outcome type, or errors.
- A deterministic compatibility default defined by the pinned Pi Adapter may be a certified fact only when Token mirrors that exact version-bound resolver and final-wire tests cover the result. Token-specific Provider-name, URL, model-name, or payload-shape heuristics are not certified defaults. Re-audit the resolver on every Pi upgrade.
- The protocol-owned semantic executor creates and owns `onPayload` after target resolution. The callback invokes that protocol's selected projection operation and never captures raw Client Wire or parser-internal objects.
- Pi AI calls `onPayload` after constructing its Provider payload and before sending it. The projector validates the exact audited payload shape, returns a copied payload with only proven Provider-native mappings, and fails rather than guessing when the shape is incompatible.
- Pi AI retains ownership of Provider registration, authentication, base request construction, transport, retry, streaming, response parsing, and Provider Wire → Pi AI IR conversion. Protocol semantic executors must not duplicate those implementations.
- An audited Pi native option takes precedence over payload projection. A semantic control must have exactly one authoritative final projection; the protocol-owned projector must not set it through both paths.
- Verify exact-value controls and upper-bound controls according to their distinct semantics. Repair a mismatched exact value only when its Provider-native field and replacement are certified, and emit a repair warning. The final Provider request's response-output token ceiling may be lower than the Client-specified ceiling when required by context safety, but it must never exceed that hard limit; a Provider minimum that would exceed it fails rather than widening it. This control does not describe Client input-token size.
- Unknown APIs and unaudited payload shapes cannot receive payload projection. Resolve every already-extracted fact through its declared omission, fallback, or non-degradable policy; fields outside all consumer declarations remain unread.
- End-to-end tests must start with the Client Wire request and assert the final Provider request captured by a test transport after `onPayload` has returned. Projector-only or intermediate payload assertions do not establish support. Every Pi AI dependency upgrade must rerun these wire-contract tests for each supported projector.
- A mechanism-only leaf utility may be shared only after at least two protocol implementations prove identical mechanics. It cannot own `onPayload`, call Pi, carry projection outcomes, classify semantic failures, or import any Client Protocol type.

### Narrow Cross-Layer Semantic Exceptions

A cross-layer semantic dependency is permitted only when all of the following hold:

1. A demonstrated end-to-end semantic requirement cannot be implemented correctly from the owning layer's local representation alone.
2. Protocol specifications and the pinned Pi Provider adapter identify the exact source fact, target use, compatibility condition, and failure behavior.
3. The dependency is expressed as the smallest immutable request-local fact or capability, not as a Provider instance, native request type, broad configuration, mutable state, or callback into another layer.
4. Credentials, authentication, transport, retry, lifecycle ownership, and execution objects remain within their owning lane and layer.
5. The exception has an explicit typed contract and end-to-end tests covering the supported path, incompatible target, malformed metadata, and model-switch fallback.

Opaque reasoning continuity is a canonical exception: response projection may need the actual upstream Provider/API/model provenance to bind Pi signature fields into a client-carried opaque envelope, while request projection may need the resolved target adapter's replay capability to restore those fields or preserve only the visible reasoning. This does not permit direct Provider imports or weaken the separation between Local Native Preservation, Provider Native Preservation, and Semantic Conversion.

The protocol-owned semantic executor's `onPayload` function is an internal execution seam, not a callback into a request converter and therefore not a cross-layer exception.

### Independent Data-Plane Lanes

Protocol-owned Semantic Modules and Pi Provider execution are not used when no semantic conversion takes place. Token has exactly three valid data-plane lanes, and they are independent architectural contracts rather than variants of one shared execution abstraction:

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
   → protocol-owned Semantic Module, including execution
   → Pi Provider
   → Provider Wire
```

These lanes must remain independent:

- Local Native Preservation owns its own model recognition, local credential lookup, request construction, transport, and response handling. It must not depend on alias resolution, Pi `Models`, Provider Native Passthrough, Pi AI IR, or Pi Provider execution.
- Provider Native Preservation may use alias/model resolution, the resolved Pi `Model`, `Models.getAuth()`, request-local effective model facts, and provider/protocol-specific transport rules. It must not enter Pi AI IR or Pi Provider execution, and it must not read or reuse Local Native credentials, model registries, transports, or execution abstractions.
- Each Semantic Conversion Client Protocol module owns its Client Wire conversion, protocol-specific semantic policy, target projection, semantic execution lifecycle, and Pi AI response IR → Client Wire conversion. It may invoke the established Pi execution capability but does not share a Semantic Conversion executor with another Client Protocol. It must not import, call, or reuse either native passthrough lane's request builders, credential authorities, transports, or response handling.
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

The CommandCode private provider must implement and register through the same Pi Provider contract and invocation path as Pi built-in providers. It is a Token implementation detail. External protocol adapters and public interfaces may use it only through the standard Pi model/provider path and must not directly instantiate, import, or special-case its private implementation.

## Reference Principle

Before rebuilding an existing capability, inspect both the pinned runtime `pi-ai` package and the repository's `pi-agent` mirror source. For payload projection, confirm that the selected Pi Provider implementation invokes `onPayload`, identify the exact object shape passed at that seam, and inspect its native option mapping and response parser.

Pi AI implementations of:

```text
Pi AI IR + Pi options → provider-native request
provider-native response → Pi AI IR
```

are version-bound mirror references for each Client Protocol's conversion and target projectors. Do not assume the transformations are strictly reversible or that payload shapes remain stable across dependency upgrades; check missing fields, explicit defaults, information loss, semantic differences, and final wire tests for every affected source-protocol/target-API pair.

Relevant external references project i:

- reference/cc-switch
- reference/opencodex

When they address the same problem, compare their actual problem, information flow, module boundaries, conversion strategy, provider extension model, advantages, limitations, and applicability.

Reference projects are evidence and design sources, not architectures Token must copy. Final decisions must follow Token's actual requirements, correctness, isolation, and minimum total complexity.

## Implementation Rule

For non-trivial changes:

1. identify the real problem and information flow;
2. identify information ownership, contracts, lifecycle, and failure conditions;
3. choose the smallest coherent change;
4. add or update tests for the intended semantic behavior.

Prefer explicit TypeScript types, small focused modules, visible control flow, pure functions where practical, and minimal dependencies. Avoid unrelated refactoring.
