# LuckyToken Agent Instructions

## Project

Repository:

```
keeplearning2026/LuckyToken
```

LuckyToken is a TypeScript-oriented project involving protocol conversion, model/provider integration, streaming, tool calls, authentication, configuration, and related runtime behavior.

The repository also contains Pi / Pi Agent source used as a **reference and extraction source**.

Do not assume Pi Agent architecture should be copied into LuckyToken.

## Working Principles

### Read context first

Before changing code, inspect the relevant:

- source files;
- tests;
- protocol specs;
- architecture docs;
- reference implementations.

Do not make important changes from isolated snippets when the surrounding call chain is available.

If source behavior conflicts with a spec, report the discrepancy.

### Prefer simple designs

Use the smallest architecture that correctly solves the problem.

Avoid unnecessary:

- managers;
- registries;
- wrappers;
- intermediate representations;
- generic frameworks;
- duplicated state.

Every abstraction should solve a real problem.

Prefer clear data flow and explicit contracts.

### High cohesion, low coupling

Each module should:

- own a clear responsibility;
- know only what it needs;
- expose a small contract;
- keep related information and processing together.

Information should not travel through unrelated modules without a reason.

### Capability cohesion

Keep one capability's behavior, data semantics, persistent files, in-memory
state, code module, and tests together under one owner.

- Other modules receive only the narrow facts or operations they consume; they
  do not receive the capability's file schema, mutable store, classification
  state, or full configuration object.
- Configuration/composition may locate and bind a capability, but must not copy
  its business rules into a central switch.
- A capability should be replaceable or removable by changing its own module,
  files, tests, and one composition binding, without cleanup across Runtime,
  Client Protocols, Pi, or Providers.
- Do not move related information through unrelated modules merely because a
  shared config/context object is convenient.

### Pi IR boundary is the first principle

Pi is the single shared semantic boundary between Client Protocols and
Providers. Treat it like a compiler IR that shields both sides:

```text
Client Wire
    ↕
Client Protocol adapter
    ↕
Pi runtime contracts / Models
    ↕
Provider adapter
    ↕
Upstream Wire
```

The two conversion directions must remain independent:

- A Client Protocol adapter owns only its Client Wire ↔ Pi conversion. It may
  use Pi contracts, but must not import, inspect, name, or make decisions from
  any concrete Provider or upstream protocol.
- A Provider adapter owns only its Pi ↔ Upstream conversion. It may implement
  Pi Provider contracts, but must not import, inspect, name, or make decisions
  from Anthropic, OpenAI Responses, or any other Client Protocol.
- Runtime and HTTP routing may coordinate Client Protocol handlers with Pi,
  but must not absorb a concrete Client Protocol's semantic policy or a
  concrete Provider's configuration.
- Adding, replacing, or removing a Client Protocol must not require Provider
  changes. Adding, replacing, or removing a Provider must not require Client
  Protocol changes.
- Do not create a cross-side conversion, shared protocol DTO, or second IR to
  bypass Pi.

Composition roots and conformance/certification code may see both sides only to
construct, bind, and verify a concrete route. They must not perform conversion
or let one side's terminology, state, or policy leak into the other side.

### Model selector contract

Model selectors follow the `provider/model_id` convention: the first slash
splits the provider id from the model id, and everything after the first slash
is the model id (which may itself contain slashes).

- A selector is resolved against the full registered provider collection
  (LuckyToken-owned providers plus Pi built-in providers), never against a
  single provider.
- Resolution is exact: first-slash split into `provider` + `model_id`
  (which covers the canonical `provider/id` form, since the split yields the
  same provider and full `model.id`), matched against the catalog, then bare
  `model.id` fallback. Ambiguous or unknown selectors fail explicitly; there
  is no fuzzy fallback.
- A model id may contain slashes (for example the CommandCode built-in model id
  is `deepseek/deepseek-v4-flash`), so the qualified selector
  `commandcode-private/deepseek/deepseek-v4-flash` is distinct from the Pi
  built-in deepseek selector `deepseek/deepseek-v4-flash`.
- All providers in the collection are equally addressable through the
  Anthropic endpoint by selector; no provider implementation is exposed to
  callers beyond its provider id and model ids.
- Only `selectorTool` knows the selector string format; `selectorTool.parse`
  (split) and `selectorTool.format` (join) are the two directions of one
  capability in `model-resolution.ts`. Everywhere else a selector is an
  opaque string: it is passed through, matched as a whole, or echoed back —
  never split, joined, trimmed, or pattern-matched. If the selector format
  changes, only `selectorTool` (and its tests) need to change.

### Client Protocol Auth isolation

Inbound client authorization is isolated per Client Protocol handler.

- Runtime selects a handler by its HTTP method/path; it does not pass protocol
  identity into Auth.
- Each handler receives its own generic `Auth` instance and immutable startup
  token authority. Anthropic, OpenAI Responses, and future Client Protocols do
  not import, enumerate, or inspect one another.
- Client token files contain only global/project token scopes. They do not
  contain Client Protocol wire state, Pi state, Provider state, or a duplicate
  protocol marker.
- Only the composition root binds a configured auth file to a concrete handler.
- After authorization, raw credentials, token scope, file paths, and lookup
  representation end their lifecycle. Only `sessionId` and `projectDir?` may
  continue into Pi option composition.

### Information lifecycle

For important state, understand:

- where it is created;
- who owns it;
- where it is transformed;
- who needs it;
- when it should be discarded.

Avoid keeping multiple representations of the same fact alive unnecessarily.

## Specifications

Protocol specs, conversion specs, and architecture specs are different concerns.

- Protocol specs describe protocol structure, semantics, lifecycle, and invariants.
- Conversion specs describe mappings between protocols.
- Architecture specs describe ownership, modules, and information flow.

Current specs are working documents and may change.

Do not preserve an existing spec merely because it already exists.

## Pi / Pi Agent Reuse

Before implementing model, provider, auth, credential, configuration, streaming, or related infrastructure from scratch, inspect the Pi / Pi Agent source included in the repository.

Reuse mature code when it reduces total complexity.

### Keep the Pi AI package upstream-clean

`pi-agent/packages/ai` is a vendored upstream Pi AI module and must remain
upstream-clean so that later Pi releases can be audited and synchronized
without disentangling LuckyToken-specific patches.

- Do not modify `pi-agent/packages/ai` to implement LuckyToken behavior.
- Consume Pi AI through its public exported contracts, including `Models`,
  `Provider`, `Provider.auth`, `CredentialStore`, and Pi message/event types.
- Put LuckyToken-specific Client Protocol adapters, Provider adapters,
  credential persistence, CLI interaction, configuration, and composition in
  LuckyToken-owned modules outside the vendored package.
- Do not copy Pi Coding Agent TUI, session, or command architecture merely to
  expose a Pi AI capability. Build the smallest LuckyToken-owned shell around
  the Pi AI public interface.
- Update the vendored Pi AI module by replacing it with a reviewed upstream
  revision, not by accumulating local feature patches.
- If an upstream Pi AI defect makes a required invariant impossible, record
  the exact contract gap and obtain an explicit architectural decision before
  carrying any local patch. Never patch it silently.

When extracting code:

1. identify the exact capability needed;
2. inspect its dependencies;
3. extract the smallest coherent subset;
4. avoid unrelated Agent/TUI/session code;
5. minimize local modifications;
6. preserve upstream provenance where useful.

Optimize for **minimum total complexity**, not maximum reuse.

## Protocol Work

When changing protocol-related code, inspect the complete relevant path:

- request parsing;
- message/content conversion;
- model/options;
- tools;
- provider request generation;
- streaming;
- terminal handling;
- errors;
- cancellation;
- tests and fixtures.

Do not let one protocol's types leak unnecessarily into another protocol or provider module.

## Streaming

Treat streaming as a lifecycle:

```
start
→ content
→ terminal success / failure
```

For structured content, reason about start, deltas, completion, and failure explicitly.

Do not assume EOF means success when the protocol defines a semantic terminal event.

Malformed known events and unknown future events are different conditions.

## Tool Calls

Tool calls are structured semantic state.

Preserve:

- tool-call IDs;
- tool names;
- arguments;
- ordering;
- tool-call/tool-result relationships.

Never treat partial tool input as a completed tool call.

Do not repair malformed tool state through guessing unless required by the protocol.

## Abort / Cancellation

Cancellation must cleanly terminate request-local state.

After cancellation:

- discard incomplete state;
- do not preserve partial tool calls;
- cancel upstream work when possible;
- do not write to closed responses;
- do not leak state into another request;
- distinguish cancellation from ordinary failure.

## Context and Cache Stability

Keep model-visible semantics separate from infrastructure information.

Do not unnecessarily place these into model context:

- credentials;
- HTTP headers;
- request IDs;
- timing;
- logging data;
- debug text;
- transport metadata.

Avoid unnecessary message reordering, timestamps, random IDs, unstable tool schemas, or dynamic data in stable prompt prefixes.

## Configuration

Prefer clear configuration over scattered hardcoded conditionals when behavior is genuinely configurable.

Protocol correctness rules should remain invariants rather than configuration options.

## Code Style

Prefer:

- TypeScript;
- explicit types;
- discriminated unions;
- small focused modules;
- pure functions where practical;
- visible control flow;
- minimal dependencies;
- straightforward tests.

Avoid unrelated refactoring and broad formatting changes.

## Before Implementing

For non-trivial changes:

1. understand the real problem;
2. inspect the relevant source and reference code;
3. identify information ownership and lifecycle;
4. identify affected contracts and invariants;
5. choose the smallest coherent change;
6. determine how it will be tested.

Do not rush into implementation while major architectural assumptions remain unclear.

## Testing

Tests should protect semantic behavior and important invariants.

For protocol/runtime changes, consider relevant cases such as:

- text;
- images;
- reasoning/thinking;
- tool calls;
- tool results;
- malformed input;
- interleaved streaming;
- terminal success;
- provider errors;
- unexpected EOF;
- abort/cancellation.

Use existing repository test and validation commands rather than inventing replacements.

## Reference Source Rule

Directories containing copied Pi / Pi Agent source are reference material unless LuckyToken explicitly depends on them.

Do not modify reference-source code casually.

Prefer implementing or extracting the required capability into LuckyToken-owned modules rather than gradually turning the reference tree into production code.

## Final Principle

Build the smallest system in which:

- protocol correctness;
- information ownership;
- module boundaries;
- streaming lifecycle;
- tool identity;
- cancellation;
- maintenance

are easy to understand and verify.
