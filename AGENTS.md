## Project

Repository:

```text
keeplearning2026/LuckyToken
```

LuckyToken is a protocol-conversion project built around this boundary:

```text
Anthropic / OpenAI Responses / other client protocols
                         ↕
                      Pi AI IR
                         ↕
                    Pi Providers
```

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

These rules apply in both directions:

```text
Request:  Client Protocol → Pi AI IR → Pi Provider
Response: Pi Provider → Pi AI IR → Client Protocol
```

## Isolation Principle

Pi AI IR is the only shared semantic boundary between external client protocols and Pi Providers.

- A client-protocol adapter owns only Client Wire ↔ Pi AI IR conversion.
- A provider adapter owns only Pi AI IR ↔ Provider Wire conversion.
- Client-protocol code must not depend on concrete providers or provider-native types.
- Provider code must not depend on Anthropic, OpenAI Responses, or other client-protocol types.
- Provider-specific or client-protocol-specific fields must not leak into the common Pi AI IR merely for convenience.
- Runtime and composition code may connect the two sides, but must not perform cross-side semantic conversion.

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
