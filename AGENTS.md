## Project

Repository:

```text
keeplearning2026/LuckyToken
```

LuckyToken serves client protocol wires through three independent data-plane lanes. Pi AI IR is the shared semantic-conversion boundary only for the Semantic Conversion lane; the two native preservation lanes bypass Pi AI IR and remain independent from each other:

```text
Anthropic / OpenAI Responses / other client protocol wires
                              │
             ┌────────────────┼────────────────┐
             │                │                │
             ▼                ▼                ▼
      Local Native     Provider Native      Pi AI IR
      Preservation      Preservation           │
             │                │                ▼
             │                │           Pi Providers
             │                │                │
             ▼                ▼                ▼
      Local Upstream   Provider Upstream   Provider Wire
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

## Compatibility Policy

Unless the user explicitly requests compatibility, implement only the current contract. Replace obsolete configuration, interfaces, state shapes, and code paths instead of adding migrations, shims, dual readers/writers, deprecated aliases, or fallback branches. Tests specify current behavior, not historical behavior.

## Desktop Product Architecture

For Electron, desktop, tray, preload, renderer, local management transport, or desktop product-boundary work, read `doc/Spec/LuckyTokenElectronArchitectureSpec.md` before designing or changing code.

The fixed dependency direction is `Renderer → typed preload → Electron Main → Application Control Plane → Backend Application → Core`. Core owns model-serving semantics; the Application Control Plane is the only management seam into a running Backend; Electron Main owns desktop lifecycle/OS integration; Renderer owns interaction state, never Backend authority.

## Protocol Conversion Usability

Protocol conversion should preserve usability while always producing a valid target-protocol result.

For conversion from protocol A to protocol B:

1. If a clear semantic mapping exists, convert it directly.
2. If a recognized A field has no representation in B, omit it and emit a warning.
3. If omitting it would make the result invalid or break security, permissions, tool-call relationships, or other critical semantics, fail the conversion.
4. If B needs a value that A does not provide, use only a default explicitly defined by B or by the adapter contract.
5. If an optional B field has no valid source or defined default, omit it.
6. If a required B field still cannot be constructed, fail with an explicit error.

Never invent defaults or repair malformed semantic state by guessing.

These rules apply to semantic-conversion paths in both directions:

```text
Request:  Client Protocol → Pi AI IR → Pi Provider
Response: Pi Provider → Pi AI IR → Client Protocol
```

Native wire passthrough is a preservation path rather than protocol conversion and is governed by the Isolation Principle below.

## Isolation Principle

Pi AI IR is the only shared semantic-conversion boundary between external client protocols and Pi Providers. It is the normal path whenever model-visible semantics must be translated between different wire contracts.

- On the semantic-conversion path, a client-protocol adapter owns only Client Wire ↔ Pi AI IR conversion.
- On the semantic-conversion path, a provider adapter owns only Pi AI IR ↔ Provider Wire conversion.
- Client-protocol code must not instantiate concrete providers or depend on provider-native semantic types.
- Provider code must not depend on Anthropic, OpenAI Responses, or other client-protocol semantic types.
- Provider-specific or client-protocol-specific fields must not leak into the common Pi AI IR merely for convenience.
- Runtime and composition code may connect the two sides, but must not perform cross-side semantic conversion.

### Independent Data-Plane Lanes

Pi AI IR is not required when no semantic conversion takes place. LuckyToken has exactly three valid data-plane lanes, and they are independent architectural contracts rather than variants of one shared execution abstraction:

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
   → Pi AI IR
   → Pi Provider
   → Provider Wire
```

These lanes must remain independent:

- Local Native Preservation owns its own model recognition, local credential lookup, request construction, transport, and response handling. It must not depend on alias resolution, Pi `Models`, Provider Native Passthrough, Pi AI IR, or Pi Provider execution.
- Provider Native Preservation may use alias/model resolution, the resolved Pi `Model`, `Models.getAuth()`, request-local effective model facts, and provider/protocol-specific transport rules. It must not enter Pi AI IR or Pi Provider execution, and it must not read or reuse Local Native credentials, model registries, transports, or execution abstractions.
- Semantic Conversion owns Client Wire ↔ Pi AI IR conversion and Pi Provider execution. It must not import, call, or reuse either native passthrough lane's request builders, credential authorities, transports, or response handling.
- The two native lanes must not be unified behind a shared native target, native credential, native executor, native transport, or fallback abstraction. Similar wire-construction code may remain duplicated when sharing it would couple credential ownership or lifecycle.
- Runtime/composition or the Client Protocol edge may select a lane using only the minimum routing facts required by that lane. After a lane is selected and execution begins, failure in that lane must not fall through to another lane.
- Local Native eligibility is established by that integration's explicit local model/capability contract. Provider Native eligibility is established by an explicit `(provider, api/protocol)` transport contract or equivalent model capability; fuzzy provider-name similarity or payload resemblance is not sufficient.
- Native lanes preserve model-visible request and response semantics rather than translating them. Only boundary-required model identity projection, credential/auth transport, header filtering, content encoding, and endpoint construction may alter the wire representation.
- The raw client wire remains authoritative on native lanes. Native passthrough must not reconstruct or semantically normalize unrelated request fields merely to forward them.
- Credentials remain owned by the authority of the selected lane. Local credentials never become Pi Provider credentials; Pi Provider credentials never become Local Native credentials; neither credential representation enters Pi AI IR.
- If serving a request requires semantic reinterpretation, invented defaults, cross-protocol repair, or an uncertain mapping, that request is not native preservation. Route it to Semantic Conversion before execution begins, or fail explicitly if no valid semantic mapping exists.

A Client Protocol edge may invoke narrow lane-specific seams, but it must not implement the concrete transport rules of any lane itself. Local Native, Provider Native, and Semantic Conversion are three separate execution paths with separate ownership and lifecycle.

The CommandCode private provider must implement and register through the same Pi Provider contract and invocation path as Pi built-in providers. It is a LuckyToken implementation detail. External protocol adapters and public interfaces may use it only through the standard Pi model/provider path and must not directly instantiate, import, or special-case its private implementation.

## Reference Principle

Before rebuilding an existing capability, inspect the `pi-ai` package in the repository's `pi-agent` source.

Pi AI implementations of:

```text
Pi AI IR → provider-native request
provider-native response → Pi AI IR
```

are mirror references for LuckyToken's external protocol conversion. Do not assume the transformations are strictly reversible; check missing fields, explicit defaults, information loss, and semantic differences.

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
