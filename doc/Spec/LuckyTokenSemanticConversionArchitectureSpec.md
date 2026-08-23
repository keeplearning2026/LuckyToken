# LuckyToken Semantic Conversion Architecture Specification

Status: **PROPOSED TARGET CONTRACT — DECOUPLING MIGRATION REQUIRED**
Date: **2026-08-23**
Scope: the Semantic Conversion data-plane lane only. Local Native Preservation and Provider Native Preservation remain independent and are governed by their own contracts.

This document is authoritative for the structure shared by Semantic Conversion implementations. Protocol-specific field meanings, supplements, reasoning policies, request projectors, target-aware response interpretation, response rendering, and certification matrices belong to protocol-specific specifications and plans.

## 1. Decision

Semantic Conversion is a family of cohesive Client Protocol modules, not one universal semantic-conversion module.

Each Client Protocol owns a complete vertical slice:

```text
Client Wire
→ protocol-owned request conversion
→ protocol-owned Semantic Invocation
→ protocol-owned reasoning and target projection
→ LuckyToken Pi execution kernel
→ Pi Provider
→ Provider Wire
→ Pi AssistantMessage
→ protocol-owned response conversion
→ Client Wire
```

OpenAI Responses, Anthropic Messages, and future Client Protocols do not share:

- a Semantic Invocation type;
- a supplement type;
- a reasoning request model;
- a target projector registry;
- field mapping policy;
- target-response interpretation policy;
- effective-state response policy;
- protocol test cases or expected-wire assertions.

They may reuse only mechanism-level modules that contain no Client Protocol semantics. The principal shared module is the LuckyToken Pi execution kernel, which owns Pi invocation and the `onPayload` lifecycle but does not know what any projected field means.

Controlled duplication is preferred when a shared abstraction would make independently evolving Client Protocols change together.

## 2. Correctness objective

Request correctness ends at the final Provider request, not at an intermediate LuckyToken object or Pi AI IR. Response correctness ends at the Client response and, for replay-required facts, at the next complete-history Provider request.

For each supported source-protocol/target-API pair:

1. preserve the Client request's model-visible meaning and enforceable controls;
2. reuse the existing Client converter for validation, Pi messages, tool relationships, response state, and notices;
3. use audited Pi IR and Pi options where they emit the correct target meaning;
4. preserve recognized facts that Pi cannot carry inside that Client Protocol's own typed Invocation;
5. apply only mappings certified for that source protocol, resolved Pi API, Provider/model compatibility, and final payload shape;
6. report a control as effective only when the final Provider request contains an equivalent control;
7. warn, fall back, omit, or fail according to the source protocol's requirement strength;
8. restore replay-required Provider response facts in the next complete-history Provider request when compatible provenance permits it.

Protocol independence is an ownership rule, not a permission to reduce fidelity. A protocol module is incomplete if it omits a recognized request or response fact merely to avoid implementing a protocol-local type or target policy.

## 3. Terms

### 3.1 Client Protocol Semantic Module

A deep module that owns one Client Protocol's complete Semantic Conversion behavior. Its external Interface is small: accept one Client request plus request-local infrastructure facts and return the Client response or a protocol-correct failure.

Its implementation may contain internal seams for request conversion, reasoning, supplement construction, target projection, response conversion, streaming, and tests. Those internal seams are not global extension points.

### 3.2 Protocol-owned Semantic Invocation

The request-local representation owned by one Client Protocol Semantic Module. It normally contains:

- the strongest correct Pi `Context` and Pi options;
- that protocol's typed reasoning intent and historical continuity;
- that protocol's typed supplement for recognized request facts Pi cannot carry correctly;
- the smallest immutable attachment/provenance facts needed by that protocol;
- Client-owned render state and notices kept outside Provider projection.

The concrete shape is protocol-specific. No common discriminated union combines all Client Protocol Invocation types.

### 3.3 Protocol-owned supplement

A typed, immutable collection of validated request facts for one Client Protocol. It is complete relative to that protocol's supported request grammar, not relative to every other Client Protocol.

It is not:

- raw Client Wire;
- an unvalidated extension bag;
- a Provider request object;
- a common union of every known Client field;
- model-visible Pi message content used as storage.

### 3.4 Protocol-owned reasoning module

The reasoning module for one Client Protocol owns its request-generation grammar, historical reasoning interpretation, continuity codec, source-to-target replay decisions, content fallback, response rendering, and outcomes.

For example, OpenAI Responses effort/summary/encrypted reasoning items and Anthropic disabled/enabled/adaptive thinking with budgets are different source contracts. They must not be forced into one request type merely because both eventually affect model reasoning.

### 3.5 Protocol-owned target projector

A pure Adapter for one source-protocol/target-API pair. It consumes only:

- its source protocol's typed Invocation facts;
- the resolved Pi `Model`, `model.api`, and certified compatibility facts;
- the exact audited Pi-built Provider payload shape.

It validates and returns a copied payload plus explicit outcomes. It does not parse raw Client Wire or perform transport.

### 3.6 Protocol-owned response interpreter

A target-aware Adapter inside one Client Protocol module. It consumes the final Pi `AssistantMessage`, its actual `provider/api/model` provenance, certified model compatibility, and that protocol's request-local render state. It decides how each retained Pi response fact maps into the Client response and into any next-request continuity carrier.

It cannot recover Provider response data that the pinned Pi Adapter discarded. Such facts must be recorded by the protocol's response audit and resolved through a valid Client default/null, explicit omission with a developer notice, visible fallback, or critical conversion failure. It never uses the request-side `onPayload` seam and never intercepts Provider transport.

### 3.7 LuckyToken Pi execution kernel

A protocol-agnostic deep module that owns:

- the public Pi execution call;
- rejection of a caller-supplied `onPayload`;
- installation and invocation of one already-selected projection operation;
- payload projection failure enforcement;
- final projection outcome collection;
- delegation to the existing `ExecutionOperation`.

It owns no request-field meaning and selects no Client Protocol or target projector.

### 3.8 Mechanism-only leaf utility

A small shared utility is permitted only when it is unaware of all source protocols and semantic policies. Examples include immutable payload cloning, exact shape guards, conflict ledgers, bounded outcome containers, and test transport capture.

The deletion test applies: deleting the utility must reproduce identical mechanics in more than one protocol module. Similar-looking field mappings are not sufficient evidence.

## 4. Authoritative structure

```text
OpenAI Responses Wire
        │
        ▼
OpenAI Responses Semantic Module
  ├─ Responses Invocation
  ├─ Responses supplement
  ├─ Responses reasoning/continuity
  ├─ Responses → target projectors
  ├─ target Pi response → Responses interpretation
  └─ Responses response conversion
        │ Pi input + prepared projection operation
        ▼
┌──────────────────────────────────┐
│ LuckyToken Pi execution kernel   │
│ - owns onPayload                 │
│ - invokes projection operation   │
│ - calls existing Pi execution    │
└──────────────────────────────────┘
        ▲
        │ Pi input + prepared projection operation
Anthropic Messages Semantic Module
  ├─ Anthropic Invocation
  ├─ Anthropic supplement
  ├─ Anthropic reasoning/continuity
  ├─ Anthropic → target projectors
  ├─ target Pi response → Anthropic interpretation
  └─ Anthropic response conversion
        ▲
        │
Anthropic Messages Wire
```

The two protocol modules do not converge into a shared semantic representation. They converge only at the execution-mechanism seam.

## 5. Dependency and locality rules

The required dependency direction is:

```text
protocol request/response code
        ↓
same-protocol semantic contracts and implementation
        ↓
Pi execution kernel Interface
        ↓
existing Pi execution / Pi AI
```

Fixed rules:

1. `protocols/openai-responses` and its semantic implementation do not import Anthropic protocol or semantic modules.
2. `protocols/anthropic` and its semantic implementation do not import OpenAI Responses protocol or semantic modules.
3. The Pi execution kernel imports no Client Protocol module, Invocation, supplement, reasoning type, or registry.
4. No global `ClientProtocol` union or `switch (clientProtocol)` selects semantic behavior in the kernel.
5. A protocol module selects its own target projector only after model resolution, using `model.api` plus certified Provider/model compatibility facts.
6. Composition registers a Client Protocol handler and supplies shared infrastructure capabilities; it does not translate request controls or mutate Provider payloads.
7. Adding a Client Protocol creates a new vertical module and composition registration. It does not modify the kernel or existing Client Protocol modules.
8. Deleting a Client Protocol removes its vertical module without leaving fields or cases in a common semantic model.

Architecture tests must enforce these rules through import/dependency assertions and a compile-time or fixture-based new-protocol locality test.

## 6. Pi execution kernel Interface

The exact TypeScript packaging may vary, but the kernel seam must remain equivalent to this small Interface:

```ts
interface PiInvocation {
  readonly context: Context;
  readonly options: ModelsSimpleStreamOptions;
}

interface PreparedPayloadProjection {
  readonly pi: PiInvocation;
  readonly initialOutcomes: readonly ProjectionOutcome[];
  project(payload: unknown): {
    readonly payload: unknown;
    readonly outcomes: readonly ProjectionOutcome[];
  };
}

interface PayloadProjectionOperation {
  prepare(input: {
    readonly model: Model<string>;
    readonly pi: PiInvocation;
  }): PreparedPayloadProjection;
}

interface PiKernelInfrastructure {
  readonly executeOperation: ExecutionOperation;
  readonly factsSink?: ExecutionFactsSink;
}

executeWithPiKernel(input: {
  readonly models: Models;
  readonly model: Model<string>;
  readonly pi: PiInvocation;
  readonly projection: PayloadProjectionOperation;
  readonly infrastructure: PiKernelInfrastructure;
}): Promise<{
  readonly message: AssistantMessage;
  readonly outcomes: readonly ProjectionOutcome[];
}>;
```

The projection operation hides protocol-specific prepared state behind its implementation. The kernel does not inspect that state or the meaning of its outcomes except for the common terminal `failed` disposition. `PiKernelInfrastructure` is deliberately narrow; it cannot become a bag for Profile, routing, protocol render state, Provider payload types, or raw request facts.

The protocol request converter does not create this operation. The owning protocol's semantic executor creates it after validation and target resolution from typed Invocation facts. The kernel alone creates Pi's `onPayload` callback.

### 6.1 Kernel execution order

1. Reject any Pi options already containing `onPayload`.
2. Invoke the supplied operation's `prepare()` before freezing Pi input.
3. Reject a failed initial outcome before invoking Pi.
4. Freeze the prepared Pi Context/options using the existing execution guard.
5. Install one kernel-owned `onPayload` callback.
6. When Pi supplies its final base payload, invoke `project()` exactly once and throw from the callback before it returns if projection failed, so transport cannot receive the payload.
7. Return the Pi `AssistantMessage` and immutable outcomes.
8. If Pi reaches Provider dispatch or a successful terminal without invoking the certified payload seam, fail; an earlier Pi validation or execution failure remains authoritative and is not replaced by a missing-callback error.

Pi retains ownership of Provider registration, authentication, base request construction, transport, retry, streaming, response parsing, and Provider Wire → Pi AI IR conversion.

## 7. Protocol-owned conversion rules

### 7.1 One source parser

Each Client request is validated once. The existing converter remains authoritative for behavior already proved correct. The same conversion operation produces Pi input, protocol-owned supplement/reasoning facts, Client render state, and conversion notices.

Do not introduce a second parser that reinterprets raw Client Wire for projection.

### 7.2 One authoritative source representation

Within one protocol module, classify each recognized fact into exactly one owner:

| Fact class | Owner |
|---|---|
| Conversation, ordered history, thinking blocks, images, tool calls/results | Pi `Context` |
| An audited Pi option that works for this resolved target | Pi options |
| Protocol-specific reasoning generation/history/continuity | protocol reasoning module |
| Recognized request fact Pi cannot carry correctly | protocol supplement |
| Client echo, streaming/render state, session behavior | protocol response state |
| Conversion/projection notices | protocol-owned bounded facts published through fail-open observation |
| Target-retained Pi response facts and Client response mapping | protocol-owned response interpreter |
| Credentials, transport, retries, cancellation, diagnostics | existing infrastructure owner |

A fact may be present in Pi options and the supplement only when the Pi path is target-dependent and the supplement is the authoritative source used to validate or repair the final wire. The target projector records one final writer and one outcome.

### 7.3 Completeness without a universal model

Every protocol must audit its own complete recognized grammar. Completeness means no validated source fact is silently lost merely because Pi IR lacks a slot. It does not require another Client Protocol to learn or represent that fact.

The same completeness rule applies in the response direction. For every supported target API, the protocol records which Provider response facts survive Pi parsing, their `AssistantMessage` attachment, their Client response mapping, whether they are replay semantics, and the exact disposition when Pi cannot expose them.

For each fact, the protocol plan declares:

- source location and validation;
- requirement strength;
- Pi representation, if any;
- target mappings known at that time;
- warning/fallback/failure behavior;
- protocol-valid response behavior and effective-state mapping when the Client protocol defines one;
- required final-wire tests.

### 7.4 No semantic guesswork

Mappings are source-to-target contracts. Similar names do not establish equivalence. For example, output-token limits, cache durations, service tiers, reasoning activation, and structured-output names can differ across Client Protocols even when their Provider fields look similar.

When equivalence is not proven:

- preserve a validated protocol-owned fact until target resolution if a supported mapping may exist;
- omit a preference with a warning when no mapping exists;
- fail a hard control before Provider dispatch;
- never invent a required target value unless the target Adapter contract defines that default.

## 8. Protocol-owned target projection

### 8.1 Projection matrix

Projectors are indexed by source protocol first and resolved target second:

```text
OpenAI Responses → OpenAI Completions
OpenAI Responses → Google
OpenAI Responses → Bedrock
...

Anthropic Messages → OpenAI Completions
Anthropic Messages → Google
Anthropic Messages → Bedrock
...
```

Two projectors that write the same Provider field may retain separate policies and code. Source semantics, requirement strength, fallback behavior, and effective-state reporting remain source-owned.

### 8.2 Pi-first, final-wire verified

An audited Pi-native mapping remains the first choice. The protocol-owned projector then:

1. validates whether Pi emitted the exact or bounded target meaning;
2. records `pi-native` when correct;
3. repairs only a certified Provider-native field and emits a warning when repair is allowed;
4. writes a missing field only for a proven mapping;
5. rejects incompatible payload shapes rather than guessing;
6. emits an explicit unsupported or failed outcome for every unconsumed fact.

### 8.3 One writer and conflicts

One final Provider field has one authoritative writer inside one protocol projection operation. The operation composes its reasoning and ordinary supplement internally and must detect overlap before mutation.

The kernel enforces operation failure but does not decide which semantic owner wins.

### 8.4 Unknown targets

An unknown Pi API or unaudited payload shape receives no mutation. The owning protocol applies its own requirement policy before dispatch. Unknown target handling is not a kernel mapping policy.

## 9. Reasoning and continuity

Reasoning is protocol-owned because source grammars differ materially.

Each protocol reasoning module must cover:

- request generation intent, including omission versus explicit disable;
- source-specific effort, budget, adaptive, and summary controls;
- historical visible reasoning text;
- opaque thinking-, text-, and tool-call-bound continuity;
- actual Provider/API/model provenance from Pi responses;
- same-target replay compatibility;
- model-switch fallback;
- response rendering into that Client Wire;
- full-history response → next Provider request tests.

Opaque state retains its source provenance and semantic attachment. Foreign Provider state must not masquerade as a native Client Protocol field. A protocol-specific client-wire envelope may preserve it when that wire has a valid bounded extension point. If the Client cannot return the envelope, preserve visible meaning and report that exact opaque replay was unavailable.

No server-side continuity store is introduced unless a separate product contract explicitly requires server-owned continuation.

## 10. Response interpretation

Each Client Protocol owns a response-capability matrix indexed by the actual Pi response `api` plus Provider/model compatibility where required. The matrix must cover:

- Provider response facts retained in Pi content, usage, stop fields, IDs, and opaque signatures;
- their exact Pi attachment points;
- valid Client response fields and SSE events;
- response-only observations versus next-request replay semantics;
- target-defined null/default values;
- visible fallback, warning omission, and critical failure behavior;
- fields irretrievably lost by the pinned Pi response parser.

`onPayload` participates only in request construction. It is never evidence that a response field can be preserved. A protocol may not inject a transport, reread a consumed stream, or use diagnostics as a response data source to compensate for a Pi parser gap. If a critical Client response or replay relationship cannot be constructed from the authoritative Pi result, fail explicitly; otherwise emit the strongest valid Client response and publish a bounded developer notice for the loss.

## 11. Projection outcomes and failures

The kernel may share a small outcome vocabulary because it describes execution mechanics, not Client field meaning:

- `pi-native`;
- `payload-projected`;
- `content-fallback`;
- `omitted`;
- `failed`.

The protocol module owns the subject/control identifier, warning text, and whether a fact is hard or a preference.

Rules:

- hard unsupported controls fail before dispatch;
- unsupported preferences are omitted with a protocol-owned warning;
- repairs emit a developer warning identifying the protocol projector;
- diagnostics are fail-open and never affect projection;
- Client responses claim effectiveness only from successful final outcomes when their protocol defines an effective-state field; other protocols do not invent an echo.

## 12. Native-lane isolation

Local Native Preservation and Provider Native Preservation do not use protocol Semantic Invocations, protocol target projectors, or the Pi execution kernel.

Native lane eligibility and request reconstruction remain governed by `AGENTS.md`. Failure after lane commitment never falls through into a Semantic Conversion module.

## 13. Testing contract

### 13.1 Kernel tests

Kernel tests use a synthetic projection operation and prove only mechanics:

- `onPayload` ownership;
- prepare/project ordering;
- exactly-once projection;
- immutable Pi input;
- failed outcome prevents dispatch;
- missing Pi payload callback fails;
- projection outcomes are returned;
- diagnostics do not alter execution.

They contain no OpenAI Responses or Anthropic request fixtures.

### 13.2 Protocol tests

Every protocol owns independent tests for:

- Client Wire → protocol Invocation;
- complete supplement capture;
- reasoning and continuity;
- every certified source-protocol/target-API projector;
- Provider response → Client Wire → next Provider request replay;
- final Provider body after Pi and `onPayload`;
- unsupported hard/preference behavior;
- protocol-valid response behavior; effective-state echo only when the Client protocol defines such fields;
- target Provider response → Pi `AssistantMessage` → Client Wire coverage, including explicit unavailable-field dispositions.

Tests for one Client Protocol do not import another protocol's fixtures, supplement builders, expected semantics, or projector registry.

### 13.3 Locality tests

Architecture certification must prove:

- no imports between Client Protocol modules;
- no Client Protocol imports from the kernel;
- no central Client Protocol discriminant in the kernel;
- a synthetic new Client Protocol can bind a projection operation and execute without modifying existing protocol modules or the kernel.

### 13.4 Online tests

Use one independently runnable script per Client Protocol and Provider. Direct protocol probes remain separate from real Agent/CLI tests. Scripts may share only mechanism-level HTTP server, capture, timeout, credential isolation, and reporting helpers.

Every direct semantic probe sends complete Client history and asserts the captured final Provider request. `previous_response_id` belongs only to a real Codex/Responses client path and is not generic continuity evidence.

## 14. Migration route

### Phase 1 — Freeze current behavior

Capture current spec-conforming OpenAI Responses final-wire and round-trip behavior as the regression baseline. A known contradiction with the Responses protocol specification is a bug to correct, not behavior to freeze. Add architecture tests that initially expose the shared-contract coupling.

### Phase 2 — Extract the execution kernel

Deepen the current wrapper into a mechanism-only kernel. Replace its semantic-conversion-specific Interface with `PiInvocation + PayloadProjectionOperation`. Preserve authentication, Profile binding, retry, transport, response parsing, and existing `ExecutionOperation` ownership.

### Phase 3 — Localize OpenAI Responses

Move the current shared Invocation, supplement, reasoning policies, target projectors, and effective-state behavior into the OpenAI Responses vertical module. Preserve final-wire behavior through the kernel Interface. Remove obsolete shared registries and types rather than retaining compatibility shims.

### Phase 4 — Certify locality

Pass dependency tests, the synthetic new-protocol test, all Responses final-wire tests, and the three independent Responses online Provider scripts.

### Phase 5 — Implement Anthropic independently

Audit the complete Anthropic Client request grammar and the Provider response → Pi → Anthropic response surface. Build a separate Anthropic Invocation, supplement, reasoning/continuity module, request projector registry, target-aware response interpreter registry, response renderer, and online suite. Reuse only the kernel and proven mechanism-only leaf utilities.

## 15. Current implementation divergence

The implementation committed before this architecture decision uses a shared `SemanticConversionInvocation`, shared `ProjectionSupplement`, shared reasoning request model, and shared target projector registry under `src/semantic-conversion/`. Those modules represent the implemented OpenAI Responses baseline, not the desired extension seam for new Client Protocols; only spec-conforming behavior is preserved as a migration invariant.

The migration must preserve their tested Responses behavior while localizing them. Anthropic must not be added to those shared semantic contracts as an interim shortcut.

## 16. Definition of done

The architecture migration is complete only when:

1. the Pi execution kernel imports no Client Protocol semantic type or registry;
2. OpenAI Responses owns its Invocation, supplement, reasoning, projectors, continuity, response policy, and tests;
3. no existing protocol changes are required to register a synthetic new Client Protocol;
4. final-wire and round-trip behavior remains equivalent to the frozen Responses baseline;
5. all supported source-protocol/target-API mappings have explicit outcomes and final-wire tests;
6. each protocol has an explicit Provider-response capability matrix and end-to-end response/replay tests;
7. native lanes remain independent;
8. no compatibility shim, dual contract, raw-wire carrier, or global Client Protocol semantic union remains.
