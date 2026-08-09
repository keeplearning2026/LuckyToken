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