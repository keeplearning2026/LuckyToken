# OpenAI Responses Semantic Conversion Decoupling Implementation Plan

Status: **PROPOSED — READY FOR TDD REFACTOR**
Date: **2026-08-23**
Scope: localize the completed OpenAI Responses Semantic Conversion behavior and extract a mechanism-only Pi execution kernel. This plan does not implement Anthropic Semantic Conversion and does not change either Native Preservation lane.

The filename is retained because it is the existing implementation-plan reference. Its authority is now explicitly limited to the OpenAI Responses Client Protocol vertical module and the one-time extraction of the Pi execution kernel.

## 1. Authority and outcome

Implement in this precedence order:

1. [Repository instructions](../../AGENTS.md)
2. [OpenAI Responses Semantic Conversion Architecture Specification](./LuckyTokenOpenAIResponsesSemanticConversionArchitectureSpec.md)
3. [Semantic Conversion Architecture Specification](./LuckyTokenSemanticConversionArchitectureSpec.md)
4. [OpenAI Responses → Pi Provider Request Field Audit](../OpenAIResponsesPiProviderRequestFieldAudit.md)
5. pinned Pi AI 0.84.2 runtime and Pi Agent mirror source

The migration preserves the final-wire behavior already certified for OpenAI Responses while changing its ownership:

```text
Current
  shared SemanticConversionInvocation
  + shared reasoning
  + shared supplement/projectors
  + semantic-aware wrapper

Target
  OpenAI Responses-owned Invocation
  + Responses-owned reasoning
  + Responses-owned supplement/projectors
  + mechanism-only Pi execution kernel
```

No compatibility shim, dual contract, or temporary common registry remains after the migration.

## 2. Target module structure

### 2.1 Shared mechanism-only kernel

```text
src/semantic-conversion/kernel/
  contract.ts
  execution.ts
  outcome.ts
```

The kernel owns only:

- the `PiInvocation` and projection-operation Interfaces;
- creation and exclusive ownership of Pi `onPayload`;
- prepare/project ordering;
- failure enforcement and immutable outcome collection;
- delegation to the existing bound `ExecutionOperation`.

It contains no Responses request field, reasoning policy, supplement path, target registry, Provider mapping, or Client response logic.

### 2.2 OpenAI Responses vertical module

```text
src/protocols/openai-responses/
  request.ts
  response.ts
  sse.ts
  reasoning-continuity.ts
  semantic/
    invocation.ts
    execution.ts
    reasoning/
      contract.ts
      request.ts
      response.ts
      registry.ts
      adapters/
    supplement/
      contract.ts
      request.ts
      registry.ts
      projectors/
    response-interpretation/
      registry.ts
      adapters/
```

The exact file split may be simplified when a file would be shallow; existing `reasoning/response.ts` and the main renderer may together implement response interpretation without forced indirection. The ownership is fixed: every Responses semantic type, source-to-target mapping, and target-Pi-response interpretation stays under the Responses module.

### 2.3 Removed shared semantic modules

After callers move, delete or relocate these current shared owners:

```text
src/semantic-conversion/contract.ts
src/semantic-conversion/reasoning/
src/semantic-conversion/supplement/
src/semantic-conversion/execution.ts
```

Only the new kernel remains under the protocol-neutral `semantic-conversion` root.

## 3. Fixed Interfaces

### 3.1 Kernel Interface

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

The kernel treats outcomes as opaque records except for terminal `failed` enforcement. It does not know Responses control paths. The infrastructure type is closed and narrow; it cannot accumulate Profile, routing, raw wire, or render-state objects.

### 3.2 Responses-owned conversion result

```ts
interface ResponsesSemanticInvocation {
  readonly pi: PiInvocation;
  readonly reasoning: ResponsesReasoningSemantics;
  readonly supplement: ResponsesProjectionSupplement;
}

interface ResponsesConversionResult {
  readonly selector: string;
  readonly invocation: ResponsesSemanticInvocation;
  readonly client: {
    readonly renderState: ResponsesRenderState;
    readonly notices: readonly ConversionNotice[];
  };
}
```

`convertResponsesRequest()` remains the one request parser. It preserves its existing correct validation, message/tool conversion, Pi options, reference resolution, render state, and notices while returning Responses-owned semantic facts.

### 3.3 Responses projection operation

The Responses semantic executor resolves the target projector and creates one operation from `ResponsesSemanticInvocation`. The request parser never creates `onPayload` or receives a Provider payload.

The operation internally composes:

1. Responses reasoning preparation;
2. Responses reasoning payload projection;
3. non-overlapping Responses supplement projection;
4. Responses-owned outcome identifiers and warnings.

Only the prepared operation crosses into the kernel.

## 4. Preserved OpenAI Responses contracts

This refactor does not redesign Responses semantics. Preserve behavior certified by the Responses protocol specification and conforming tests. A current implementation behavior that contradicts that specification is a bug to correct, not a compatibility baseline:

- distinct reasoning omission, explicit `none`, enabled effort, and summary preference;
- item-local `luckytoken_continuity` with source provenance;
- complete Responses reasoning item preservation, including `id`, `status`, `summary`, `content`, and `encrypted_content`;
- thinking-, text-, and tool-call-bound opaque attachments;
- target-aware replay and model-switch fallback;
- full supplement capture for recognized Responses controls;
- Pi-native validation before payload repair;
- forced/named/allowed tool choice and parallel-tool-call projection;
- structured output projection;
- response-output token ceiling enforcement;
- effective-state response echo based only on final outcomes;
- target-aware Provider response → Pi attachment interpretation and next-history replay;
- hard/preference failure policy;
- all ten pinned Pi text API target policies;
- known GOAT `deepseek-v4-flash` forced-tool-choice predispatch restriction.

The field audit remains authoritative for the complete Responses request surface.

## 5. TDD protocol

Every slice runs RED → GREEN → regression.

Use guarded repository commands:

```text
npm run test:unit
npm run test:integration
npm run test:certification
npm run lint
npm run typecheck
npm test
```

Tests that can reach Codex state use a new temporary `CODEX_HOME` through the repository guard. Do not package the product as part of this refactor.

## 6. Implementation slices

### Slice 0 — Freeze the current final-wire baseline

1. Record the current passing unit, integration, certification, and three-provider online reports.
2. Treat spec-conforming final Provider bodies and full-history round trips as the behavioral baseline; record known divergences as red tests instead of freezing them.
3. Create `doc/OpenAIResponsesPiProviderResponseFieldAudit.md`, indexed by actual Pi response API and Provider/model compatibility, covering Provider response facts, Pi attachment/loss, Responses JSON/SSE rendering, and next-request replay semantics.
4. Add Provider response → Pi `AssistantMessage` → Responses JSON/SSE fixtures and next-history Provider-request fixtures for replay-required facts across every target API.
5. Add a test fixture that invokes the current wrapper with a representative Responses Invocation and captures its final payload/outcomes.
6. Add initially failing dependency assertions for the desired kernel and protocol ownership.

Gate: request projection and response interpretation have documented spec-conforming baselines, and a failed relocation or behavior change is detectable without inspecting implementation-private objects.

### Slice 1 — Introduce the mechanism-only kernel

1. Add kernel contracts and `executeWithPiKernel()`.
2. Use a synthetic projection operation in kernel tests; do not import Responses fixtures.
3. Prove rejection of caller-provided `onPayload`, prepare/project ordering, initial failure before Pi invocation, callback projection failure before transport, exactly-once projection, missing-callback precedence, immutable outcome return, and diagnostics non-interference.
4. Continue using the existing `ExecutionOperation`; do not copy authentication, Profile binding, retry, transport, streaming, or response parsing.

Gate: kernel tests contain no Client Protocol field names or target projector registry.

### Slice 2 — Localize the Responses Invocation

1. Move `SemanticConversionInvocation` and `ClientConversionResult` into Responses-owned contracts with Responses-specific names.
2. Update `convertResponsesRequest()` and Responses tests to use the local types.
3. Keep one authoritative representation for every current Responses fact.
4. Remove the global Invocation contract after its last caller moves.

Gate: no non-Responses module imports the Responses Invocation, and no global Client Invocation remains.

### Slice 3 — Localize Responses reasoning

1. Move the existing reasoning contracts, preparation, response extraction, registry, and ten Adapter policies under the Responses semantic module.
2. Retain the Responses continuity codec at the Responses wire edge.
3. Keep Provider/API/model provenance and attachment rules unchanged.
4. Preserve same-model replay, model-switch fallback, missing signature, redacted representation, complete Responses item replay, and content fallback tests.
5. Implement the Responses-owned response-capability matrix from the response audit; every unavailable Pi response fact receives an explicit Responses fallback/omission/failure disposition.

Gate: changing the Responses reasoning request grammar or target-response interpretation requires edits only inside the Responses module and its tests, and every target has Provider response → Pi → Responses fixtures.

### Slice 4 — Localize Responses supplement and target projectors

1. Move the current supplement contract, parser, registry, compatibility rules, and target projectors under the Responses semantic module.
2. Keep the existing complete Responses field vocabulary; do not generalize it for Anthropic or future protocols.
3. Retain source-protocol/target-API final-wire fixtures for all certified targets.
4. Keep payload cloning and shape guards local during this slice. Extract a mechanism-only leaf only when another protocol later proves identical mechanics.

Gate: the Responses projector registry imports no other Client Protocol and is not exported as a global registry.

### Slice 5 — Compose the Responses projection operation

1. Add the Responses-owned operation that prepares reasoning and projects reasoning plus supplement.
2. Detect final-field ownership conflicts inside the operation.
3. Pass only `PiInvocation + PayloadProjectionOperation` to the kernel.
4. Translate opaque kernel outcomes back into Responses effective-state rendering through Responses-owned logic.

Gate: the kernel remains unchanged while the complete Responses suite passes through it.

### Slice 6 — Route Responses semantic execution through the kernel

1. Update the Responses semantic executor to create its local projection operation after model resolution.
2. Keep Local Native and Provider Native branches unchanged.
3. Preserve request journey observation as fail-open and lane-owned.
4. Remove the old semantic-aware wrapper entry point after all Responses callers move.

Gate: selected lane, final Provider payload, Pi response, Client response, retry behavior, and terminal outcome match the frozen baseline.

### Slice 7 — Enforce protocol locality

1. Add import assertions prohibiting kernel → Client Protocol and cross-protocol semantic dependencies.
2. Add a synthetic Client Protocol fixture that defines its own Invocation and projection operation and executes through the unchanged kernel.
3. Assert that no central Client Protocol enum, semantic union, or projector switch is required.
4. Delete obsolete shared semantic files, aliases, and tests rather than keeping compatibility paths.

Gate: the synthetic protocol compiles and executes without modifying kernel or Responses source.

### Slice 8 — Regression and online certification

Run the existing independent OpenAI Responses direct-protocol scripts:

```text
test/online/run-commandcode-private-responses.ts
test/online/run-commandcode-goat-responses.ts
test/online/run-opencode-go-responses.ts
```

Each script must continue to assert its final captured Provider body, full-history reasoning replay, projection probes, and independent report/exit status. Real Codex CLI tests remain separate.

Gate: all local checks and all three online scripts pass with final-wire and round-trip behavior equivalent to the frozen spec-conforming baseline; red protocol bugs are corrected rather than preserved.

## 7. Required architecture assertions

Certification fails if any of these become true:

- the kernel imports `protocols/openai-responses`;
- the kernel contains a Responses field or control path;
- a Responses projector registry is imported by another Client Protocol;
- another Client Protocol imports Responses supplement or reasoning contracts;
- composition switches on Client Protocol to mutate payload fields;
- a raw Responses request body reaches a projector;
- both the old shared wrapper and new kernel remain callable;
- a compatibility shim or dual Invocation survives cleanup.

## 8. Definition of done

The refactor is complete when:

1. OpenAI Responses is a cohesive vertical Semantic Conversion module;
2. the shared kernel exposes only execution mechanics;
3. all current Responses final-wire, reasoning round-trip, effective-state, and online behavior remains certified;
4. a per-target Responses response-capability audit and Provider response → Pi → Responses fixture matrix is complete;
5. a synthetic new Client Protocol uses the kernel without changing Responses or kernel code;
6. obsolete shared semantic contracts, registries, and wrapper entry points are deleted;
7. Local Native and Provider Native behavior is unchanged;
8. lint, typecheck, unit, integration, certification, and full guarded tests pass.
