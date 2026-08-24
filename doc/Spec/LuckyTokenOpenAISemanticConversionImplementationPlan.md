# OpenAI Responses Protocol-Local Semantic Conversion Implementation Plan

Status: **IMPLEMENTED LOCALLY — ONLINE CERTIFICATION PENDING**
Date: **2026-08-24**
Scope: remove OpenAI Responses Semantic Conversion's dependency on Anthropic and on a shared semantic implementation. This plan does not change Anthropic semantics, either Native Preservation lane, or Pi AI.

## 1. Outcome

OpenAI Responses becomes one cohesive vertical Module:

```text
OpenAI Responses Client Wire
→ src/protocols/openai-responses/semantic/
   ├─ Invocation and supplement
   ├─ reasoning and continuity
   ├─ target projection
   ├─ semantic execution, onPayload, outcomes, and failures
   └─ Pi response interpretation
→ existing narrow Pi execution capability
→ Pi Provider
```

The migration is deliberately local:

1. treat the current shared implementation as a read-only source baseline;
2. copy the Responses behavior into the Responses module;
3. change only Responses imports, composition, and tests to use the local copy;
4. make the agreed projection-candidate correction only in the Responses copy;
5. after every protocol has cut over, delete the now-unreferenced shared semantic directory.

This is not a rewrite and does not introduce a new common abstraction.

## 2. Authority

Use this precedence:

1. [Repository instructions](../../AGENTS.md)
2. [OpenAI Responses Semantic Conversion Architecture Specification](./LuckyTokenOpenAIResponsesSemanticConversionArchitectureSpec.md)
3. [Semantic Conversion Architecture Specification](./LuckyTokenSemanticConversionArchitectureSpec.md)
4. [OpenAI Responses → Pi Provider Request Field Audit](../OpenAIResponsesPiProviderRequestFieldAudit.md)
5. pinned Pi AI runtime and existing certified final-wire tests

Spec-conforming current final-wire behavior is the regression baseline. A current behavior that contradicts the specifications is a bug, not a compatibility requirement.

## 3. Non-interference rule

During the OpenAI copy and cutover, the change set must not modify:

```text
src/protocols/anthropic/**
test/**/*anthropic*
doc/Spec/LuckyTokenAnthropic*
```

Shared files may continue serving an independently migrating protocol only during the transition. Their physical presence is temporary.

If the shared source changes concurrently, recopy only after inspecting the diff and only when the change is required to preserve the frozen Responses baseline. Never merge OpenAI policy back into the shared source. Delete the shared source only after dependency certification proves zero callers.

## 4. Target folder structure

Mirror the Anthropic hierarchy without importing Anthropic code:

```text
src/protocols/openai-responses/
  semantic/
    invocation.ts
    execution.ts
    pi-execution.ts
    projection/
      operation.ts
      outcome.ts
      request.ts
      registry.ts
      certified-compatibility.ts
      adapters/
        contract.ts
        candidate-resolution.ts
        anthropic-messages.ts
        bedrock.ts
        commandcode-private.ts
        google.ts
        mistral.ts
        openai-completions.ts
        openai-responses.ts
        pi-messages.ts
    reasoning/
      contract.ts
      continuity.ts
      request.ts
      response.ts
      registry.ts
      adapters/
        continuity-decisions.ts
    supplement/
      contract.ts
      request.ts
```

Do not force a file split when it would create a shallow pass-through. The fixed rule is ownership under the Responses module, not one file per type.

## 5. Copy map

Use the current implementation as the behavioral source, then rename types to Responses-owned names:

| Read-only source | Responses-owned destination |
|---|---|
| `src/semantic-conversion/contract.ts` | `semantic/invocation.ts` |
| `src/semantic-conversion/projection-outcome.ts` | `semantic/projection/outcome.ts` |
| `src/semantic-conversion/reasoning/**` | `semantic/reasoning/**` |
| `src/semantic-conversion/supplement/contract.ts` | `semantic/supplement/contract.ts` |
| `src/semantic-conversion/supplement/request.ts` | `semantic/supplement/request.ts` |
| `src/semantic-conversion/supplement/registry.ts` | `semantic/projection/registry.ts` |
| `src/semantic-conversion/supplement/projectors/**` | `semantic/projection/adapters/**` |
| `src/semantic-conversion/execution.ts` and required callback mechanics | `semantic/execution.ts` and `semantic/pi-execution.ts` |
| existing Responses response reasoning behavior | `src/protocols/openai-responses/response.ts` and `semantic/reasoning/response.ts` |
| `src/protocols/openai-responses/reasoning-continuity.ts` | `semantic/reasoning/continuity.ts` |

Copy behavior, tests, and certified target restrictions. Do not preserve generic names that falsely imply cross-protocol ownership.

## 6. Local Interfaces

### 6.1 Invocation

```ts
interface ResponsesSemanticInvocation {
  readonly pi: ResponsesPiInvocation;
  readonly reasoning: ResponsesReasoningSemantics;
  readonly supplement: ResponsesProjectionSupplement;
}
```

No common Client Protocol Invocation union is introduced.

### 6.2 Execution

```ts
interface ResponsesSemanticExecutionCapabilities {
  readonly executeOperation: ExecutionOperation;
  readonly factsSink?: ExecutionFactsSink;
}

executeOpenAIResponsesSemanticInvocation(input: {
  readonly models: Models;
  readonly model: Model<string>;
  readonly invocation: ResponsesSemanticInvocation;
  readonly capabilities: ResponsesSemanticExecutionCapabilities;
}): Promise<ResponsesSemanticExecutionResult>;
```

The Responses Module owns target selection, reasoning preparation, `onPayload`, projection order, conflict/failure enforcement, immutable outcomes, and conversion-specific error classification. `execution.ts` orchestrates Responses semantics; `pi-execution.ts` owns the request-local Pi callback boundary. `ExecutionOperation` remains the existing narrow infrastructure capability; it owns no Responses semantics.

### 6.3 Projection rejection

Define a Responses-owned typed rejection, for example `ResponsesProjectionRejected`, carrying the immutable terminal reasoning or main-call-contract outcome set needed by the Responses edge. A `ResponsesProjectionSupplement` outcome is never eligible for this rejection path merely because the resolved target cannot express its candidate.

It must remain distinct from:

- malformed Client request errors;
- invalid audited payload shape or duplicate field ownership;
- Pi execution invariant failures;
- upstream Provider failures;
- cancellation.

The Responses edge renders it as an OpenAI Responses `invalid_request_error` before response commitment. It never becomes a generic upstream or internal error.

## 7. Agreed local semantic correction

`ResponsesProjectionSupplement` is the complete carrier of currently projection-eligible **Projection Candidate Facts**, not a mandatory patch list. A recognized fact with no certified Provider-request consumer remains with its request/session/execution/response owner instead of entering the Supplement.

For every candidate, the Responses-local positive-only Adapter or central disposition must produce exactly one result:

1. Pi already emitted a certified equivalent: do not mutate; record `pi-native`; bounded read-only validation is allowed.
2. Pi did not emit it and the resolved target has a certified mapping: project once; record `payload-projected`.
3. A certified Pi-native mapping is wrong: repair only the exact proven field/value; record repair and warn.
4. The target has no certified mapping: the Adapter leaves the candidate unconsumed. The projection coordinator records `omitted` with a generic warning; a named bounded `degraded` fallback remains Adapter-owned only when it is actually constructed or verified. Candidate unavailability never returns terminal `failed` and never prevents dispatch.

Normal target unavailability is outcome-based. Exceptions remain reserved for broken internal contracts such as incompatible audited payload shape, duplicate field ownership, or invalid final payload construction.

The implementation must encode this boundary in types and orchestration:

- `ResponsesProjectionRecord.outcome` excludes `failed`;
- the semantic executor never derives `failure` from Supplement outcomes;
- every unconsumed candidate becomes `omitted + warning` unless a named bounded degradation applies;
- malformed requests and genuinely non-degradable guarantees are rejected by Responses validation or the authoritative Pi/main-call contract before this best-effort seam.
- `max_output_tokens` is repaired on every certified target ceiling field; a target without that field records `omitted + warning` and still dispatches.
- a raw request field with no Responses consumer, including `background`, remains unread and receives only the bounded unconsumed-field warning.

## 8. Implementation slices

Each slice uses RED → GREEN → regression and guarded repository test commands. Any test that can reach Codex state must use a new temporary `CODEX_HOME`.

### Slice 0 — Freeze Responses behavior and dependency gates

1. Record current spec-conforming Client Wire → final Provider Wire fixtures.
2. Record Provider response → Responses response → next Provider request replay fixtures.
3. Add failing architecture assertions that Responses imports no Anthropic module and, after cutover, no `src/semantic-conversion/**` implementation.
4. Record known projection-candidate divergences as red tests rather than freezing them.

Gate: the migration can detect both semantic regressions and remaining shared imports.

### Slice 1 — Copy local contracts

1. Copy Invocation, supplement, reasoning, projection-outcome, and execution result contracts into `semantic/`.
2. Rename them to Responses-owned names.
3. Update only Responses request/conversion code and its tests to use the local contracts.

Gate: Responses request conversion emits no shared semantic type.

### Slice 2 — Copy reasoning and continuity

1. Copy the current Responses reasoning adapters, registry, preparation, payload projection, and response extraction.
2. Move the Responses continuity codec under `semantic/reasoning/`.
3. Preserve all target/API/model provenance, same-target replay, redacted state, attachment positions, and model-switch fallback tests.

Gate: Responses reasoning imports neither Anthropic nor shared reasoning files.

### Slice 3 — Copy supplement and projection

1. Copy the supplement contract, request extraction, compatibility restrictions, registry, and target projectors into the Responses hierarchy.
2. Keep the complete projection-eligible Responses field vocabulary; keep request/session/execution/response facts with their existing Responses owner and do not generalize them.
3. Preserve every certified final-wire fixture.
4. Keep mechanically similar helpers local in this slice.

Gate: Responses target projection imports no shared supplement/projector implementation.

### Slice 4 — Copy and own semantic execution

1. Implement `semantic/execution.ts` from the current Responses behavior and put the required Pi callback mechanics in `semantic/pi-execution.ts`.
2. Own `onPayload` exclusively inside the Responses Module's `pi-execution.ts`.
3. Invoke the existing `ExecutionOperation`; do not copy credentials, Profile binding, transport, retry, streaming, or Pi response parsing.
4. Add the Responses-owned typed projection rejection.
5. Preserve its classification even if Pi or `ExecutionOperation` wraps a callback exception.

Gate: a genuinely terminal reasoning or internal-contract failure causes zero Provider dispatches and reaches the Responses edge as a typed projection rejection; Supplement candidate unavailability is not such a failure.

### Slice 5 — Cut over the Responses path

1. Update `src/protocols/openai-responses/semantic.ts` to call the local executor.
2. Update Responses request, response, and error-rendering imports to local types.
3. Keep Direct Mode and Provider Native branches unchanged.
4. Remove every Responses import from `src/semantic-conversion/**` in the same slice; do not retain a fallback or dual path.

Gate: the complete Responses suite passes through the local Module and the old shared files have no production caller.

### Slice 6 — Correct Projection Candidate Fact handling locally

1. Add red tests for Pi-native equivalent, certified missing mapping, certified repair, centrally omitted unconsumed candidates, named bounded degradation, incompatible payload shape, and duplicate ownership.
2. Change only Responses-local projection code.
3. Prove `pi-native` does not rewrite the payload.
4. Prove every unconsumed Supplement candidate dispatches with a centrally generated omission warning and unchanged unrelated payload.
5. Prove a named bounded fallback records `degraded` and publishes an honest warning without claiming exact application.
6. Narrow the Supplement outcome type so `failed` cannot be constructed, and remove Supplement-failure handling from semantic execution.
7. Keep payload-shape, duplicate-ownership, and invalid-final-payload exceptions as internal-contract failures rather than availability outcomes.
8. Add final-wire tests proving excessive certified output ceilings are repaired and unsupported output ceilings dispatch with warning.

Gate: Supplement presence never causes unconditional projection or request rejection; Adapters contain only positive mappings, while unconsumed candidates dispatch with centrally generated `omitted + warning` or a named bounded `degraded` outcome.

### Slice 7 — Demand-Driven Request Extraction

This is a local corrective slice after the protocol-local migration; it does not reopen or repeat the decoupling work.

1. Add one private extraction operation in `request.ts`, shared by the synchronous and asynchronous conversion entries.
2. Select frozen own-property views for the main Responses consumer and the Supplement consumer before either parser runs.
3. Remove reverse validation and field-specific state for request keys claimed by neither consumer, including `stream_options`, `top_logprobs`, `context_management`, `background`, `conversation`, and `prompt`.
4. Derive bounded generic omission notices from present top-level keys minus the union of both consumer declarations without reading unconsumed values.
5. Allow unclaimed siblings in claimed nested objects such as `text.format`, while retaining validation of consumed discriminators, required children, and consumed value types.
6. Keep `validateMainRequest` and its validated shape private; retain only the synchronous and asynchronous conversion operations as module Interfaces.
7. Prove the real Codex `stream_options.reasoning_summary_delivery` shape dispatches once without reaching Provider Wire, and prove throwing diagnostics cannot alter the selected lane, Provider Wire, response status, or response body.

Gate: unconsumed request fields cannot affect dispatch; malformed consumed facts and missing minimum request facts still fail.

### Slice 8 — Certification

Run guarded lint, typecheck, unit, integration, certification, and full tests. Then run the independent Responses online scripts for CommandCode Private, CommandCode GOAT, and OpenCode GO when credentials and environment are available.

Gate: final Provider payloads, response rendering, full-history replay, cancellation, retry behavior, and Native-lane behavior remain spec-conforming.

## 9. Expected file changes

Create files only under:

```text
src/protocols/openai-responses/semantic/**
test/unit/openai-responses-*
test/integration/openai-responses-*
test/certification/*openai-responses*
```

Modify only the necessary existing Responses-owned composition and wire files, expected primarily:

```text
src/protocols/openai-responses/semantic.ts
src/protocols/openai-responses/request.ts
src/protocols/openai-responses/response.ts
src/protocols/openai-responses/error-rendering.ts
src/protocols/openai-responses/index.ts
```

An implementation slice may touch fewer files. Any need to modify a shared or Anthropic path stops the OpenAI slice for design review rather than expanding scope.

## 10. Architecture assertions

Certification fails when any of these is true:

- a Responses semantic file imports `src/protocols/anthropic/**`;
- a Responses semantic or wire file imports an implementation from `src/semantic-conversion/**`;
- a shared or Anthropic file imports a Responses semantic type;
- a central Client Protocol enum selects semantic projection or execution policy;
- raw Responses Wire reaches a projector;
- the Responses request path can choose between old shared and new local execution;
- the OpenAI migration changes Anthropic semantics;
- an obsolete `src/semantic-conversion/` directory remains after all protocol cutovers.

Imports of proven infrastructure Interfaces outside `src/semantic-conversion/**`, including `ExecutionOperation`, diagnostics contracts, Pi model types, and request identity, remain allowed when narrow and semantics-free.

## 11. Definition of done

The OpenAI Responses migration is complete when:

1. all Responses Invocation, supplement, reasoning, projection, execution, outcome/error, response interpretation, and tests are owned under the Responses module;
2. Responses imports neither Anthropic nor a shared Semantic Conversion implementation;
3. obsolete shared semantic files are deleted only after all protocol callers have local owners;
4. Pi-native facts are validated without duplicate mutation;
5. every unconsumed candidate fact has a Responses-owned `omitted` or named bounded `degraded` disposition;
6. no Supplement candidate becomes `failed` or prevents Provider dispatch merely because the resolved target cannot express it;
7. final-wire and replay behavior remains certified;
8. both Native Preservation lanes remain unchanged;
9. no compatibility shim, dual execution path, or common Client Protocol semantic union was introduced.
