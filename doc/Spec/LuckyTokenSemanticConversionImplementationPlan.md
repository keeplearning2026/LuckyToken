# LuckyToken Semantic Conversion Implementation Plan

Status: **PROPOSED — READY FOR TDD IMPLEMENTATION**  
Date: **2026-08-23**  
Scope: the Semantic Conversion lane only. This plan adds no work to Local Native Preservation or Provider Native Preservation.

## 1. Authority and outcome

Implement this plan against these sources, in precedence order:

1. [LuckyToken Semantic Conversion Architecture Specification](./LuckyTokenSemanticConversionArchitectureSpec.md)
2. [OpenAI Responses → Pi Provider Request Field Audit](../OpenAIResponsesPiProviderRequestFieldAudit.md)
3. [Repository instructions](../../AGENTS.md)

If implementation evidence conflicts with an assumption in this plan, stop that slice, update the authoritative specification first, and then revise the plan. Do not silently encode a new architecture in code.

The delivery route is reuse-first:

```text
Existing Client conversion
→ reasoning + complete supplement
→ pass-through Pi wrapper
→ reasoning projection
→ Provider supplement projectors
→ effective-state response
```

The current Client conversion remains authoritative for validation, Pi message construction, tool relationships, audited Pi options, render state, notices, and request-local reference resolution. The implementation deepens that conversion result and composes new modules around it; it does not introduce a second Client parser or Provider request builder.

## 2. Fixed request Interface

The Client adapter returns the resolved selector separately from the request-local Semantic Conversion Invocation and Client-owned response state:

```ts
interface SemanticConversionInvocation {
  readonly pi: {
    readonly context: Context;
    readonly options: ModelsSimpleStreamOptions;
  };
  readonly reasoning: ReasoningSemantics;
  readonly supplement: ProjectionSupplement;
}

interface ClientConversionResult<TRenderState> {
  readonly selector: string;
  readonly invocation: SemanticConversionInvocation;
  readonly client: {
    readonly renderState: TRenderState;
    readonly notices: readonly ConversionNotice[];
  };
}
```

For OpenAI Responses, deepen the existing `convertResponsesRequest()` result into this shape. Preserve its current correct validation, messages, tools, Pi options, render state, notices, and reference resolution.

Each recognized request fact has one authoritative location:

| Fact | Authoritative location |
|---|---|
| Portable conversation, history, thinking, and tool relationships | `invocation.pi.context` |
| Audited portable Pi options | `invocation.pi.options` |
| Reasoning request intent, historical summaries, and replay continuity | `invocation.reasoning` |
| Recognized controls that Pi cannot carry correctly for every supported target | `invocation.supplement` |
| Client response rendering, echo, session, and notices | `client` |
| Credentials, transport, retry, cancellation, and diagnostics | Existing infrastructure owner |

## 3. Reasoning module

Place the Provider-aware reasoning implementation under:

```text
src/semantic-conversion/reasoning/
  contract.ts
  request.ts
  response.ts
  registry.ts
  adapters/
```

The module boundaries are fixed:

- `contract.ts` owns `ReasoningSemantics`, historical reasoning, provenance, continuity attachments, prepared results, and reasoning projection outcomes.
- `request.ts` owns the pure `prepareReasoning()` and `projectReasoningPayload()` operations.
- `response.ts` extracts thinking-, text-, and tool-call-bound continuity from a Pi `AssistantMessage` and returns protocol-neutral attachments.
- `registry.ts` selects an internal reasoning Adapter from the resolved `model.api` plus certified Provider/model compatibility facts.
- `adapters/` owns the Provider replay and payload rules. Each of Pi's ten text APIs must return one explicit behavior: native replay, payload projection, content fallback, or unsupported.

The ten required API policies are:

1. `anthropic-messages`
2. `openai-completions`
3. `openai-responses`
4. `azure-openai-responses`
5. `openai-codex-responses`
6. `google-generative-ai`
7. `google-vertex`
8. `mistral-conversations`
9. `bedrock-converse-stream`
10. `pi-messages`

Provider reasoning strategy exists only inside this module. Changing a Provider replay policy must not require a change to the OpenAI Responses request or response parser.

## 4. OpenAI Responses continuity codec

Place the Responses client-wire codec in:

```text
src/protocols/openai-responses/reasoning-continuity.ts
```

This module owns only closed-world parsing and rendering of the item-level extension. It does not choose a Provider replay policy.

```ts
decodeResponsesContinuity(
  item: Readonly<Record<string, unknown>>,
  location: ResponsesItemLocation,
): {
  readonly attachments: readonly WireContinuityAttachment[];
  readonly notices: readonly ConversionNotice[];
};

encodeResponsesContinuity(input: {
  readonly source: ReasoningSource;
  readonly attachments: readonly WireContinuityAttachment[];
}): LuckyTokenContinuityEnvelopeV1 | undefined;
```

### 4.1 Wire shape

The extension field is named `luckytoken_continuity` and is attached to the output item that owns the semantic block or call:

```ts
interface LuckyTokenContinuityEnvelopeV1 {
  readonly version: 1;
  readonly source: {
    readonly provider: string;
    readonly api: string;
    readonly model: string;
  };
  readonly attachments: readonly (
    | {
        readonly target: "thinking";
        readonly kind:
          | "opaque-signature"
          | "reasoning-field-selector";
        readonly representation?: "redacted";
        readonly value: string;
      }
    | {
        readonly target: "text";
        readonly partIndex: number;
        readonly kind: "opaque-signature";
        readonly value: string;
      }
    | {
        readonly target: "toolCall";
        readonly callId: string;
        readonly kind: "opaque-signature";
        readonly value: string;
      }
  )[];
}
```

Attachment rules:

- Put a reasoning signature on its reasoning item.
- Preserve `representation: "redacted"` only for an opaque thinking attachment produced from a Pi block with `redacted: true`; the codec transports this fact but does not decide whether a target may replay it.
- Put a text signature on its message item and identify the content part with `partIndex`.
- Put a tool-call signature on its tool-call item and identify the call with `callId`.
- Keep Responses-native `encrypted_content` in the standard Responses field. A foreign Provider signature must not impersonate `encrypted_content`.
- Keep the complete Responses-native reasoning item in standard fields: `id`, `status`, `summary`, `content`, and `encrypted_content`. Do not duplicate its model-visible summary or content inside the opaque envelope.
- Omit a reasoning field selector when the target Adapter can reconstruct it deterministically. Carry it only when exact reconstruction is otherwise impossible.
- Apply the existing aggregate Responses request and response byte limits; do not add a separate unbounded extension budget.
- Add no server-side continuity or session store. Full-history client replay is the carrier.

The codec validates only the envelope schema and item-local attachment. Unknown versions, malformed fields, unknown keys, duplicate targets, invalid `partIndex` or `callId` attachments, and a redacted representation on any non-opaque-thinking attachment are ignored individually and produce a conversion notice while visible content continues to convert. Source-to-target replay compatibility is evaluated later by the selected reasoning Adapter; an incompatible source discards only its opaque attachment and representation, emits the appropriate outcome/notice, and preserves the visible reasoning meaning.

### 4.2 Request parsing flow

Parse continuity beside the existing visible-content conversion:

```text
Responses input item
→ parse visible reasoning/text/tool call normally
→ decodeResponsesContinuity()
→ record a request-local association from wire item to the new Pi block/call
→ finish all Pi messages
→ resolve the association to messageIndex/contentIndex/callId
→ populate ReasoningSemantics.continuity
→ let the target reasoning Adapter decide replay
```

The temporary association exists only inside the conversion function. Do not place markers, foreign Provider objects, or opaque extension values into model-visible Pi content.

### 4.3 Response rendering flow

Extract and encode continuity after Pi has produced its response IR:

```text
Pi AssistantMessage
→ reasoning/response.ts extracts continuity using actual provider/api/model provenance
→ Responses renderer creates the owning output item
→ encodeResponsesContinuity()
→ renderer writes luckytoken_continuity on that item
```

This separation allows the wire schema, Responses parsing, and Provider replay policies to change independently.

## 5. Pi wrapper and payload projection

Expose one request-local wrapper operation:

```ts
executeSemanticConversion(input: {
  readonly models: Models;
  readonly model: Model<string>;
  readonly invocation: SemanticConversionInvocation;
  readonly infrastructure: SemanticExecutionInfrastructure;
}): Promise<SemanticConversionResult>;
```

The wrapper:

- depends on the existing bound `ExecutionOperation`;
- owns the only semantic-conversion `onPayload` callback;
- prepares reasoning before Pi execution;
- applies reasoning projection first, then a non-overlapping supplement projector;
- returns the Pi `AssistantMessage` plus all `ProjectionOutcome` values;
- preserves existing authentication, Profile binding, 429 retry, transport, streaming, and response parsing instead of reimplementing them.

The payload callback receives the Provider-native base payload after Pi has built it and before Pi sends it. It must validate the audited payload shape, copy the payload, apply only fields owned by the selected projection plan, validate hard controls and ownership conflicts, and return the copied final payload.

Provider selection uses the resolved `model.api` plus only the Provider/model compatibility facts certified for that API. Client protocol identity and raw Client Wire never select or enter a projector.

The pinned Pi Adapter's deterministic compatibility resolver may supply a certified default only through an exact version-bound LuckyToken mirror covered by final-wire parity tests. LuckyToken-specific heuristics are not inputs to projection.

## 6. TDD execution protocol

Implement one observable behavior at a time:

1. Add the smallest test that reaches the owning seam and fails for the intended reason.
2. Implement the minimum coherent production behavior that makes it pass.
3. Run the focused guarded suite and adjacent regression suite.
4. Record final-wire evidence before enabling a mapping.
5. Complete the slice gate before beginning the next slice.

An intermediate Pi IR or projector result is not proof of support. Every enabled mapping must have an end-to-end test from Client Wire to the final Provider body captured after `onPayload` returns.

## 7. Implementation slices

### Slice 0 — Baseline and final-payload harness

1. Pin test evidence to Pi AI `0.84.2` and enumerate all ten built-in text APIs.
2. Add a harness that captures the final Provider body after `onPayload` returns.
3. Capture stable no-projector baselines for representative requests.
4. Add dependency assertions preserving separation between Semantic Conversion and both Native lanes.

Gate: the existing no-projector path can be captured repeatedly with stable results, and the architecture assertions are green.

### Slice 1 — Reasoning request extraction

1. Add the reasoning contracts.
2. Preserve reasoning effort as distinct `provider-default`, `disabled`, and enabled-level states.
3. Preserve the summary preference independently from effort.
4. Extract historical summary text, source provenance, item identity, and continuity candidates from the existing validated Responses input.

Gate: tests cover omission, explicit `none`, every supported effort, all three summary preferences, and historical reasoning items.

### Slice 2 — Continuity codec

1. Implement the standalone Responses continuity codec.
2. Add the request-local wire-item association for thinking, text, and tool-call attachments.
3. Resolve associations only after the final Pi message structure is known.
4. Reject or ignore unknown versions, duplicate attachments, wrong locations, bad indices/call IDs, unknown keys, and malformed envelopes according to the codec contract.

Gate: the codec round-trips every supported attachment, malformed attachments cannot hide visible content, and no opaque value enters ordinary model-visible text.

### Slice 3 — Pure reasoning module

1. Implement pure reasoning preparation, payload projection, and response extraction.
2. Register an explicit policy for all ten Pi text APIs.
3. Make an uncertified or unknown API return no payload mutation.
4. Keep visible reasoning through native unsigned replay or content fallback when opaque replay is incompatible.

Gate: each API covers same-model replay, model switch, missing signature, unsigned replay, incompatible provenance, and content fallback where applicable.

### Slice 4 — Response continuity loop

1. Extract item-local continuity from Pi `AssistantMessage` using its actual Provider/API/model provenance.
2. Render the envelope on the owning Responses output item.
3. Parse that item from the next full-history request and restore its semantic attachment.
4. On target incompatibility, discard only opaque state and preserve summary/text through the strongest valid representation.

Gate: an end-to-end Provider response → Client response → next Client request test restores the final Provider replay field and attachment for every supported continuity family.

### Slice 5 — Deepen the current converter and capture the complete supplement

1. Reshape `ResponsesInvocation` into `ClientConversionResult` without replacing the current converter.
2. Capture a complete first-version `ProjectionSupplement` for every recognized Responses semantic not carried correctly by Pi IR or audited common Pi options.
3. Include at least:
   - `text.format` and verbosity;
   - `parallel_tool_calls`;
   - every legal `tool_choice`, including `required` and named-function selection;
   - target-dependent sampling controls;
   - `service_tier` and `truncation`;
   - exact cache controls;
   - safety and end-user identity controls;
   - response-contract controls including `background`, `store`, `include`, and `top_logprobs`.
4. Keep reasoning in `ReasoningSemantics` and metadata echo in Client-owned render state.
5. Classify every recognized Responses request field exactly once, including fields intentionally omitted or failed.

Gate: every recognized field has one authoritative location and an empty supplement produces the same Pi context and options as the current converter.

### Slice 6 — Pass-through Pi wrapper

1. Wrap the existing execution operation and make the wrapper the sole owner of semantic-conversion `onPayload`.
2. Prevent Client adapters and routing code from supplying a payload callback.
3. Ship the wrapper first with all reasoning and supplement projectors disabled.
4. Preserve the existing bound Profile, retry, transport, cancellation, response, and terminal-state behavior.

Gate: the final Provider payload, Pi response, and terminal outcome are equivalent before and after the pass-through wrapper for all baseline fixtures.

### Slice 7 — Reasoning Provider-wire certification

Certify reasoning one target family at a time:

1. OpenAI Completions reasoning field selection.
2. OpenAI Responses, Azure OpenAI Responses, and OpenAI Codex Responses complete reasoning items.
3. Anthropic signature and redacted-thinking replay.
4. Bedrock behavior by certified model family.
5. Google Generative AI and Vertex thought signatures on thinking, text, and tool calls.
6. Mistral structured thinking.
7. Pi Messages delegation.

Gate: all ten APIs have an explicit final-wire behavior; an unknown API or incompatible payload shape receives no mutation, and required unsupported semantics fail before dispatch.

Reasoning criticality is fixed: explicit disable is hard; enabled effort and summary preference are preferences. A hard reasoning failure throws before Provider dispatch. Unsupported preferences produce `omitted` outcomes and warnings. Historical summary text still follows native unsigned replay or content fallback and is never silently dropped.

### Slice 8 — General supplement projectors

Add ordinary control mappings in this order:

1. OpenAI Completions
2. Anthropic
3. Google Generative AI and Vertex
4. Mistral
5. Bedrock
6. Responses family
7. Pi Messages

Each projector declares its exact payload shape, owned fields, compatibility predicate, unsupported behavior, and source evidence. Pi-native fields retain precedence; one final Provider field has one writer.

The wrapper also verifies Pi-native mappings at this seam. If an exact-value field differs and the exact certified replacement is known, it repairs the copied payload and records `pi-native-mapping-repaired`. `max_output_tokens` controls the generated response's total output-token ceiling; the final Provider request may reduce that ceiling for context safety but must never increase it above the Client value. A Provider minimum that would increase it fails. If a mismatch is known but the correct Provider syntax is not certified, the wrapper never guesses: hard semantics fail and preferences are omitted with a warning.

Gate: every enabled mapping has a Client Wire → final Provider Wire test, and projector conflicts fail instead of using last-write-wins behavior.

### Slice 9 — Effective-state response and cleanup

1. Report a request control as applied only when its outcome is `pi-native` or `payload-projected`.
2. Preserve warnings, omissions, content fallbacks, and failures as explicit outcomes.
3. Publish one bounded fail-open developer notice for every omission, content fallback, and Pi-native repair; a failed outcome prevents dispatch rather than becoming an observation.
4. Remove superseded behavior such as collapsing explicit reasoning `none` into omission or dropping forced tool choice.
5. Add the Pi dependency-upgrade certification matrix, including compatibility-resolver parity.
6. Remove transition-only code after all callers use the current contract; do not retain compatibility readers, aliases, or dual writes.

Gate: no Client response or diagnostic claims a control took effect unless the final Provider request contains an equivalent control.

## 8. Required test matrix

At minimum, cover:

- same-Provider/API/model replay;
- cross-model and cross-Provider fallback;
- thinking, text-part, and tool-call attachment locations;
- unsigned historical reasoning;
- explicit reasoning off versus omission;
- every reasoning summary preference;
- Anthropic redacted-thinking response → Responses history → Anthropic `redacted_thinking` replay;
- complete Responses reasoning-item `status`, `summary`, `content`, and `encrypted_content` replay;
- malformed and unknown-version continuity envelopes;
- wrong `partIndex`, wrong `callId`, duplicates, and incompatible provenance;
- payload-shape mismatch;
- projector ownership conflict;
- unknown API;
- projector-disabled equivalence;
- every recognized Responses request field's canonical classification;
- final-wire evidence for every enabled projector mapping.
- exact-value repair versus output-token upper-bound validation.

Tests that can reach Codex state must create a fresh temporary `CODEX_HOME`, copy only allowed fixtures, pass that path explicitly to every child process, and remove it in `finally`.

Use the guarded suites during implementation:

```text
npm run test:unit
npm run test:integration
npm run test:certification
```

Before completion, run:

```text
npm run lint
npm run typecheck
npm test
```

## 9. Fixed constraints

- Treat `@earendil-works/pi-ai` and `node_modules` as pinned external dependencies; modify neither.
- Keep Local Native Preservation and Provider Native Preservation outside this implementation.
- Reuse existing Client parsing, Pi conversion, execution, Profile binding, retry, transport, streaming, and response parsing.
- Preserve all validated Pi-unrepresentable ordinary controls in the complete supplement even when the first projector set does not support them.
- Keep reasoning separate because it has a response-to-next-request continuity lifecycle.
- Add no raw Client-body carrier, Provider request blob, server-side continuity store, compatibility shim, dual reader, or dual writer.
- Let unknown or uncertified targets proceed only when all remaining semantics have explicit valid fallback or omission outcomes; fail critical unsupported controls before dispatch.

## 10. Definition of done

This plan is complete only when:

1. the existing Responses converter has been deepened rather than duplicated;
2. every recognized request field has one authoritative canonical representation or an explicit omission/failure outcome;
3. reasoning history and opaque continuity survive a same-target full-history round trip with the correct final Provider attachment;
4. incompatible opaque continuity is discarded without losing visible reasoning meaning;
5. all ten Pi text APIs have certified, explicit reasoning behavior;
6. the wrapper owns `onPayload` and preserves the existing execution lifecycle;
7. every enabled reasoning or supplement projection is proved from Client Wire to final Provider Wire;
8. effective-state responses report only controls actually emitted by Pi or a certified projector;
9. dependency fences prove both Native lanes remain independent;
10. all guarded test, lint, typecheck, and full-suite gates pass without modifying Pi AI or user-owned Codex state.
