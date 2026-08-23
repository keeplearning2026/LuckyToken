# LuckyToken Semantic Conversion Architecture Specification

Status: **Proposed current contract and implementation roadmap**  
Date: **2026-08-23**  
Scope: the Semantic Conversion lane only. Local Native Preservation and Provider Native Preservation remain governed by their own contracts.

This document is the authoritative architecture and implementation route for:

```text
Client Protocol Wire
→ Semantic Conversion Invocation
→ LuckyToken Pi Wrapper
→ Pi Provider Adapter
→ Provider Wire
```

Where an older document says that Pi AI IR is the only shared semantic representation, or that a recognized field without a Pi slot must simply be dropped, this document supersedes that statement for the Semantic Conversion lane.

## 1. Objective

The correctness endpoint is the final Provider request, not an intermediate LuckyToken object and not Pi AI IR by itself.

For a supported conversion from Client Protocol A to Provider Protocol C:

1. preserve the Client request's model-visible meaning and enforceable controls;
2. use Pi AI IR and Pi options wherever they produce the correct Provider request;
3. retain recognized facts that Pi cannot carry until the final Provider target is known;
4. project only mappings proven for the resolved Provider adapter/model;
5. never claim that a control took effect unless the final Provider request contains an equivalent control;
6. warn, degrade, omit, or fail explicitly when no valid target mapping exists.

The first implementation slice is reasoning. General request supplements and other Provider projections follow after the reasoning path is correct end to end.

## 2. Terms

### 2.1 Client Protocol Adapter

Owns validation and conversion from one Client Wire protocol into a `ClientConversionResult`, and conversion from Pi response IR back to that Client Wire.

It knows the Client protocol but does not know the eventual concrete Provider payload shape.

### 2.2 Wrapped Client Conversion Module

Each existing Client conversion implementation is deepened rather than replaced. For OpenAI Responses, the implementation starts from the current `convertResponsesRequest()` behavior and preserves its proven message, tool, option, render-state, notice, and reference-resolution logic.

Its external Interface becomes one conversion operation:

```ts
convertClientRequest(clientWire): ClientConversionResult<RenderState>;
```

Internally it performs two coordinated jobs:

1. produce the strongest correct Pi `Context` and common Pi options using the existing conversion implementation;
2. capture every recognized, validated semantic that the Pi path cannot carry correctly in first-class reasoning semantics or the complete `ProjectionSupplement`.

These are two outputs of one Client conversion, not two independent parsers. The Client request is validated once, and a semantic fact has one authoritative canonical representation in the returned result.

### 2.3 Semantic Conversion Invocation

The request-local Interface passed from a Client Protocol Adapter toward Provider-side semantic execution. It contains:

- Pi `Context` for conversation, ordered history, thinking, and tool relationships;
- Pi common options for controls Pi can express correctly;
- typed semantic controls, beginning with reasoning;
- later, a complete `ProjectionSupplement` for recognized controls Pi cannot carry;
- the smallest immutable conversion context needed to attach preserved facts correctly.

It is not a second complete conversation IR and never contains raw Client or Provider bodies.

The intended shapes are:

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

The concrete Client adapter owns the exact render-state type. Runtime uses `selector` for model resolution and passes only `invocation` plus the resolved model to Provider-side semantic execution. Provider-side modules never receive or inspect Client render state. The exact TypeScript packaging may vary, but these information owners must remain visible.

### 2.4 LuckyToken Pi Wrapper

Owns final-target-aware preparation and the call to the pinned Pi AI package. It:

- receives the resolved Pi `Model` and the Invocation;
- asks the reasoning module to prepare history and request controls;
- maps controls through audited Pi options first;
- selects only certified target projectors;
- creates and owns Pi's `onPayload` callback;
- composes reasoning projection and general projection without two writers for one field;
- returns the Pi `AssistantMessage` plus the effective projection outcome.

### 2.5 Reasoning Module

A mandatory deep module for reasoning generation intent, historical reasoning, and opaque continuity. It is separate from the optional general `ProjectionSupplement` because reasoning crosses both request and response directions and may require exact replay metadata.

### 2.6 Projection Supplement

A complete, typed collection of validated Client request facts that Pi `Context` and audited common Pi options cannot carry. Completeness describes capture, not target support: every fact is retained, but a Provider projector may initially support only a subset.

### 2.7 Provider Projector

A pure target adapter used after Pi has built its Provider payload. It consumes normalized semantic facts, the resolved target facts, and the audited Provider payload shape. It returns a copied payload with only proven mappings.

## 3. Authoritative data flow

```text
OpenAI Responses / Anthropic / other Client Wire
                         │
                         ▼
              Wrapped Client Conversion Module
          ┌──────────────────────────────────────┐
          │ existing Pi conversion implementation│
          │ + complete semantic capture          │
          └──────────────────┬───────────────────┘
                             │
                             ▼
                Client Conversion Result
          ┌──────────────────────────────────────┐
          │ selector → model resolution            │
          │ invocation → Provider-side execution   │
          │ client state → later response render   │
          └──────────────────┬───────────────────┘
                             │ invocation
                             │ + resolved Pi Model
                             ▼
             Semantic Conversion Invocation
          ┌──────────────────────────────────────┐
          │ pi.context + pi.options               │
          │ reasoning                             │
          │ supplement                            │
          └──────────────────┬───────────────────┘
                             │
                             ▼
                   LuckyToken Pi Wrapper
          ┌──────────────────────────────────────┐
          │ prepare reasoning                    │
          │ choose audited Pi option mappings    │
          │ install wrapper-owned onPayload      │
          │ call Pi streamSimple                 │
          └──────────────────┬───────────────────┘
                             │
                   Pi builds base payload
                             │
                             ▼
                      onPayload seam
          ┌──────────────────────────────────────┐
          │ reasoning projector                  │
          │ + target supplement projector        │
          └──────────────────┬───────────────────┘
                             │
                             ▼
                    Final Provider Wire
```

Native preservation lanes do not enter this flow.

### 3.1 Composition in one request

The intended composition is direct:

```ts
const converted = clientConversion.convert(clientWire);
const resolvedModel = resolveModel(converted.selector);
const result = await luckyTokenPi.execute({
  models,
  model: resolvedModel,
  invocation: converted.invocation,
  infrastructure,
});

return clientConversion.render(result, converted.client.renderState);
```

Conceptually, the wrapper executes:

```ts
const prepared = reasoning.prepare(invocation.reasoning, invocation.pi, model);
const projector = projectors.resolve(model);

const options = {
  ...prepared.piOptions,
  onPayload: (basePayload: unknown) => {
    const withReasoning = reasoning.project(basePayload, prepared, model);
    return projector === undefined
      ? validateUnprojectedSupplement(withReasoning, invocation.supplement)
      : projector.project(withReasoning, invocation.supplement, model);
  },
};

return models.streamSimple(model, prepared.context, options);
```

This pseudocode expresses ownership, not final function names. The important property is that the same Invocation drives both paths:

- its Pi portion is consumed by Pi's existing Provider adapter;
- its supplement is consumed at the Provider payload seam;
- the wrapper composes both into one final request without changing Pi AI.

Pinned Pi AI 0.84.2 currently invokes `onPayload` in all ten built-in text Provider adapters. This confirms the seam is available, but each adapter passes a different payload shape and therefore requires independent shape validation and certification.

## 4. Governing principles

### 4.1 Final-wire principle

A semantic is supported only when an end-to-end test proves its equivalent representation in the final Provider request. Parser acceptance, Invocation snapshots, Pi IR snapshots, and projector-only tests are supporting evidence, not completion evidence.

### 4.2 Preserve before target resolution

A Client Protocol Adapter must not discard a recognized, validated fact merely because Pi lacks a slot. It preserves the fact in the narrowest typed Invocation location until the resolved target is known.

### 4.3 Reuse-first composition principle

The refactor wraps and deepens the existing Client conversion implementation. It does not replace proven request parsing, Pi message conversion, tool correlation, Pi option mapping, response rendering, or notice behavior with a new parallel implementation.

The migration seam is the existing conversion result:

```text
current:
  Client Wire → { context, options, renderState, notices }

deepened:
  Client Wire → {
    pi: { context, options },
    reasoning,
    supplement,
    client: { renderState, notices }
  }
```

Rules:

- Existing correct Pi conversion remains the authoritative implementation for Pi-representable facts.
- Supplement capture is added beside that implementation, using the same validated source facts.
- The Client conversion module never gains Provider payload switches.
- The projector never reparses Client Wire or rebuilds Pi Context.
- The Pi wrapper consumes both outputs and composes them for one request.
- Introducing the wrapper with no enabled projector must preserve the current final Provider request byte-for-byte except for already-declared nondeterministic fields.
- Projectors are enabled incrementally behind final-wire tests, so one projector does not require a rewrite of other Client conversion behavior.

This is the principal complexity-reduction strategy for the refactor.

### 4.4 Pi-first principle

Pi owns base Provider request construction. If an audited Pi `Context` or common-option path already emits the correct target semantic, use it. Payload projection is a supplement for demonstrated Pi gaps, not a replacement Provider implementation.

### 4.5 One authoritative writer

Every final Provider field has exactly one owner for a request:

- Pi native mapping; or
- reasoning projection; or
- general Provider projection.

The wrapper must reject conflicting projection plans rather than applying an arbitrary last-write-wins rule.

### 4.6 Target selection principle

Select reasoning policies and Provider projectors from:

```text
resolved model.api
+ resolved model.provider where required
+ certified model.compat/model-family facts
+ validated source provenance for replay
```

Client protocol identity alone never selects a Provider projector. Fuzzy Provider-name or payload-shape matching is forbidden.

### 4.7 Provenance and opaque-state principle

Opaque continuity metadata is meaningful only with its original semantic attachment and source provenance.

- Preserve the original Provider/API/model when known.
- Preserve whether the value belongs to thinking, text, or a tool call.
- Restore it only when the selected target adapter's replay contract accepts that provenance.
- Never invent or translate opaque signatures.
- Discard incompatible opaque state on model switch while retaining visible reasoning through the best valid target representation.
- Do not persist deterministic adapter facts when they can be recomputed from certified target capabilities.

### 4.8 Honest provenance principle

Do not mark arbitrary Client history as though the target Provider generated it. Target rebinding is allowed only when a certified target adapter accepts unsigned historical reasoning and the transformation is explicitly recorded as semantic conversion. Opaque signatures are never rebound.

### 4.9 Explicit outcome principle

Each preserved control receives one effective outcome:

```ts
type ProjectionOutcome =
  | { kind: "pi-native" }
  | {
      kind: "payload-projected";
      projector: string;
      warning?: "pi-native-mapping-repaired";
    }
  | { kind: "content-fallback"; reason: string }
  | { kind: "omitted"; warning: string }
  | { kind: "failed"; error: string };
```

Responses and diagnostics may report a control as applied only for `pi-native` or `payload-projected`.

The final payload verifier must compare audited Pi-native output with the requested semantic control. When Pi emitted a different value and the exact Provider-native replacement is certified, the projector repairs the copied payload and returns `pi-native-mapping-repaired`; this warning is emitted even though the request can continue. When the verifier can prove the payload is wrong but cannot prove the exact replacement, it must not guess: a hard control fails and a preference is omitted with a warning. A payload that already has the certified value remains `pi-native` and is not rewritten.

Every `omitted`, `content-fallback`, and repaired outcome also publishes one bounded request-local developer notice through the fail-open observation seam. The outcome remains authoritative if observation is unavailable. A `failed` outcome is terminal: the wrapper must throw before the Provider transport receives the payload.

### 4.10 Unknown-target principle

An unknown API or unaudited payload shape receives no payload mutation. Visible historical reasoning may fall back to ordinary assistant content when valid. Opaque state is discarded. An explicit reasoning disable is hard and fails when the final target cannot be proved disabled. An enabled reasoning effort level and a reasoning-summary preference are preferences and may be omitted with a warning. Every other hard control that cannot be preserved fails before dispatch.

### 4.11 Pinned-dependency principle

Do not modify `@earendil-works/pi-ai` or `node_modules`. Pi is pinned evidence and execution machinery. A deterministic default from the pinned Pi Adapter's compatibility resolver counts as certified only when LuckyToken mirrors that exact version-bound rule and final-wire tests cover it. LuckyToken must not add independent Provider-name, URL, model-name, or payload-shape heuristics. Every Pi upgrade reruns resolver parity checks, adapter audits, and final-wire contract tests before projection remains certified.

## 5. Reasoning module contract

The term “reasoning summary” is ambiguous and must not be used alone in code. Use these two distinct concepts:

1. `ReasoningSummaryPreference`: a current-request instruction such as Responses `reasoning.summary: "detailed"`.
2. `ReasoningSummaryText`: model-visible historical text from a prior reasoning output item.

### 5.1 Canonical inputs

```ts
type ReasoningEffortIntent =
  | { kind: "provider-default" }
  | { kind: "disabled" }
  | {
      kind: "enabled";
      level: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    };

type ReasoningSummaryIntent =
  | { kind: "provider-default" }
  | {
      kind: "requested";
      value: "auto" | "concise" | "detailed";
    };

interface ReasoningRequestIntent {
  readonly effort: ReasoningEffortIntent;
  readonly summary: ReasoningSummaryIntent;
}

interface HistoricalReasoning {
  readonly attachment: {
    readonly messageIndex: number;
    readonly contentIndex: number;
    readonly sourceItemId?: string;
  };
  readonly summaryText: string;
  readonly source?: {
    readonly provider: string;
    readonly api: string;
    readonly model: string;
  };
}

type ReasoningContinuityAttachmentPoint =
  | {
      readonly target: "thinking" | "text";
      readonly messageIndex: number;
      readonly contentIndex: number;
      readonly sourceItemId?: string;
    }
  | {
      readonly target: "toolCall";
      readonly messageIndex: number;
      readonly contentIndex: number;
      readonly callId: string;
    };

interface ReasoningContinuityAttachment {
  readonly attachment: ReasoningContinuityAttachmentPoint;
  readonly source: {
    readonly provider: string;
    readonly api: string;
    readonly model: string;
  };
  readonly kind:
    | "opaque-signature"
    | "responses-reasoning-item"
    | "reasoning-field-selector";
  readonly representation?: "redacted";
  readonly value: string;
}

interface ReasoningSemantics {
  readonly request: ReasoningRequestIntent;
  readonly history: readonly HistoricalReasoning[];
  readonly continuity: readonly ReasoningContinuityAttachment[];
}
```

The exact TypeScript names may change during implementation, but these facts and distinctions are required.

`representation: "redacted"` is valid only for a thinking attachment with `kind: "opaque-signature"`. It preserves the Provider response's replay representation without selecting a target Provider. The target reasoning Adapter restores it only when the opaque value's source provenance is compatible with the resolved Provider/API/model.

### 5.2 External Interface

The reasoning module presents two operations because Pi payload creation occurs after context preparation:

```ts
prepareReasoning(input: {
  readonly model: Model<string>;
  readonly context: Context;
  readonly options: ModelsSimpleStreamOptions;
  readonly semantics: ReasoningSemantics;
}): PreparedReasoning;

projectReasoningPayload(input: {
  readonly model: Model<string>;
  readonly prepared: PreparedReasoning;
  readonly payload: unknown;
}): ReasoningProjectionResult;
```

`prepareReasoning` is pure and returns copied/frozen request data. It may:

- preserve or deliberately rebind a Pi thinking block under a certified replay policy;
- restore a compatible Pi `thinkingSignature` representation;
- map request effort through Pi options;
- choose content fallback;
- produce typed, target-specific projection facts for the later payload seam.

`projectReasoningPayload` is also pure. It validates the audited payload shape and returns a copy. It does not send requests, resolve credentials, select Profiles, retry, or log raw content.

The LuckyToken Pi Wrapper, not the reasoning module and not the Client Adapter, creates `onPayload` and calls `projectReasoningPayload` from it.

### 5.3 Preparation rules

For each historical reasoning item:

1. Preserve `summaryText` in a Pi `ThinkingContent` candidate.
2. Validate the attachment against the final immutable Pi Context.
3. If source and target satisfy exact replay compatibility, restore the target adapter's required Pi representation.
4. If opaque continuity is incompatible, discard only the opaque value.
5. If the target accepts unsigned historical reasoning, project the visible summary as target-native reasoning.
6. Otherwise convert the visible summary to ordinary assistant text at the same history position.
7. Never silently drop non-empty visible reasoning.

The following block is therefore an output of target-aware preparation, not something the Client Adapter should construct blindly:

```ts
{
  type: "thinking",
  thinking: summaryText,
  thinkingSignature: restoredSignature,
  redacted: restoredRepresentation === "redacted" ? true : undefined,
}
```

### 5.4 Response continuity rules

When Pi returns reasoning:

1. render the visible summary in the Client protocol's reasoning representation where possible;
2. extract adapter-provided opaque continuity and its actual Provider/API/model provenance;
3. preserve its attachment point in a bounded Client-carried envelope when the Client protocol has a valid carrier;
4. preserve a validated redacted replay representation beside an opaque thinking value when Pi marks the block `redacted: true`;
5. keep every Responses-native reasoning item field (`id`, `status`, `summary`, `content`, and `encrypted_content`) in its standard Responses field rather than duplicating model-visible fields inside the opaque envelope;
6. on the next full-history request, reconstruct `HistoricalReasoning` from that item and envelope;
7. do not use server-side session storage merely because full-history replay is inconvenient.

Provider response facts that Pi stores on text or tool calls, such as Google thought signatures, remain attached to text or tool calls. They must not be moved to the nearest thinking block.

## 6. Pinned Pi 0.84.2 reasoning adapter policies

This matrix records the initial implementation policy inferred from the pinned adapter source. It is an audit starting point, not certification. Each row requires a final-wire test before being enabled.

| `model.api` | Historical reasoning replay | Continuity form | Initial policy |
|---|---|---|---|
| `openai-completions` | Provider-specific assistant reasoning field or text | Pi `thinkingSignature` is commonly the field selector `reasoning_content`, `reasoning`, or `reasoning_text` | Use a selector learned from validated prior adapter output or a certified Provider/model capability. Respect `requiresThinkingAsText`. Never use an opaque Provider signature as a property name. |
| `openai-responses` | Complete Responses reasoning input item | serialized complete reasoning item JSON | Exact replay only from a valid complete item. A summary alone is not enough for Pi's current builder; do not fabricate item identity or encrypted content. |
| `azure-openai-responses` | Same shared Responses item conversion, with Azure payload differences | serialized complete reasoning item JSON | Same continuity rule as `openai-responses`; certify the Azure payload independently. |
| `openai-codex-responses` | Same shared Responses item conversion | serialized complete reasoning item JSON | Same continuity rule; certify Codex-specific defaults independently. Native preservation remains a separate lane. |
| `anthropic-messages` | Anthropic thinking/redacted-thinking blocks | opaque thinking signature or redacted data | Restore only for compatible source/target provenance. Ordinary unsigned thinking normally becomes text unless the model's audited compatibility explicitly permits an empty signature. |
| `bedrock-converse-stream` | Bedrock `reasoningContent.reasoningText` | signature required for supported Anthropic model families; unsigned for other supported families | Select by audited Bedrock model family. Missing required signature falls back to text. Do not send a signature to a model family that rejects it. |
| `google-generative-ai` | Gemini `thought: true` part | optional opaque `thoughtSignature`, also possible on text/tool-call parts | Preserve only for the same compatible Provider/model and original attachment. Visible unsigned history may use `thought:true` only when certified. |
| `google-vertex` | Same Google shared conversion | optional opaque `thoughtSignature` | Same semantic rules as Google Generative AI, with an independent final payload-shape test. |
| `mistral-conversations` | structured Mistral thinking content | no Pi reasoning signature currently used | Preserve visible thinking through Pi when target compatibility is certified; otherwise content fallback. |
| `pi-messages` | Pi Context is sent in the Provider wire | Pi content signatures are transported as Pi fields | Treat as delegated Pi-IR transport. Preserve valid Pi attachments; do not inject another Provider's opaque state without compatible provenance. |

### 6.1 Current Pi transformation hazard

Pi's common message transform treats an AssistantMessage as same-model only when `provider`, `api`, and `model` all match. Different-model thinking is converted to text and opaque signatures are removed.

LuckyToken currently labels converted Client history with synthetic `luckytoken-client` / `luckytoken-client-history` provenance. Therefore inserting a `ThinkingContent` block alone does not prove final Provider reasoning replay. The reasoning module must make the replay decision after target resolution.

### 6.2 Request-generation control policy

`ReasoningEffortIntent` must preserve three states through target resolution:

- `provider-default`: do not turn Pi's adapter-specific omission behavior into a claimed explicit choice;
- `disabled`: emit an explicit target off only when the target mapping is certified;
- `enabled`: map the requested effort.

`ReasoningSummaryIntent` is independent. This prevents a request that supplies only `reasoning.summary`, or supplies summary alongside an explicit effort choice, from losing either fact.

Pi common `reasoning` is the first choice for enabled effort where its adapter mapping is equivalent. It does not carry Responses `reasoning.summary`, and current `streamSimple` paths may collapse omission and explicit off. Target-specific reasoning projection must repair those gaps where the Provider has an equivalent field.

Initial `ReasoningSummaryPreference` policy:

| Target family | Policy |
|---|---|
| OpenAI Responses / Azure Responses / Codex Responses | Project to native `reasoning.summary` after validating the payload shape. |
| Anthropic / Bedrock | Only map to their coarser summarized/omitted display behavior when the requested meaning is demonstrably compatible; otherwise warn about degradation. |
| OpenAI Completions, Google, Mistral, Pi Messages | No generic equivalent is assumed. A Provider/model-specific certified mapping may be added later; otherwise omit with warning. |

## 7. General Projection Supplement

The supplement is implemented after the reasoning module, but its first schema must capture every recognized and validated Client request semantic that the existing Pi conversion cannot carry correctly to every supported final target. Projector coverage may be incremental; capture completeness may not be incremental.

The supplement is always produced as an immutable value, even when empty. The projection module is optional. These are separate statements:

- complete capture prevents information loss before target resolution;
- optional projection allows incremental Provider support without rewriting the Client conversion module.

The supplement is not a raw extension bag. Its stable Interface is organized by protocol-neutral semantic families:

```ts
interface ProjectionSupplement {
  readonly output?: OutputProjectionControls;
  readonly tools?: ToolProjectionControls;
  readonly sampling?: SamplingProjectionControls;
  readonly cache?: CacheProjectionControls;
  readonly identity?: IdentityProjectionControls;
  readonly lifecycle?: LifecycleProjectionControls;
}
```

Only families with recognized fields are present in the final concrete shape. Each field preserves:

- the normalized semantic value;
- source presence versus explicit disable/null where meaningful;
- whether the source requirement is hard or preferential;
- the minimum provenance or compatibility condition needed for projection;
- its source attachment where the semantic belongs to a particular tool or output contract.

It never stores credentials, transport objects, callbacks, a raw body, or a copied Provider request.

### 7.1 Classification rule

Classify every Client request fact once:

| Classification | Authoritative location |
|---|---|
| Pi can express it portably and audited adapters preserve it | `invocation.pi` |
| reasoning generation/history/continuity | `invocation.reasoning` |
| Pi cannot express it or Pi support is target-dependent/partial | `invocation.supplement` |
| Client response echo/session/render-only state | `ClientConversionResult.client.renderState` |
| credential, transport, retry, cancellation, diagnostics lifecycle | owning infrastructure module, never the semantic Invocation |

A target-dependent Pi escape hatch such as `samplingParams` is not automatically a portable Pi mapping. The canonical fact remains in the supplement when non-OpenAI targets need it. After target resolution, the wrapper may choose an audited Pi option path for one adapter or the payload projector for another, but only one path writes the final field.

### 7.2 Projector absence

If the resolved target has no general projector:

- an empty supplement proceeds through the existing Pi path unchanged;
- a non-empty supplement is evaluated field by field;
- preferential unsupported fields are omitted with explicit outcomes/warnings;
- hard output constraints, required tool choices, or other critical semantics fail before dispatch;
- no supplement value is silently copied into an unknown payload.

For OpenAI Responses, the first schema audit must include at least:

- `text.format` and verbosity;
- `parallel_tool_calls`;
- all legal `tool_choice` variants, including `required` and a named tool;
- explicit reasoning off and reasoning summary preference not handled by the reasoning module's Pi option path;
- `service_tier`;
- `truncation`;
- exact prompt-cache controls and safe end-user identity controls;
- response-contract controls whose request injection alone would be insufficient, such as requested extra output fields.

Reasoning remains a first-class `ReasoningSemantics` field, not an entry in the general supplement. The same wrapper payload seam may execute both, but their ownership and failure policies remain separate.

“Every Pi-unrepresentable fact goes into the supplement” therefore means every ordinary request semantic. Reasoning-unrepresentable facts are also preserved completely, but in the dedicated first-class `reasoning` field because they have a response-to-next-request continuity lifecycle that the general supplement does not own.

## 8. LuckyToken Pi Wrapper contract

The wrapper's intended external Interface is one request-local call:

```ts
executeSemanticConversion(input: {
  readonly models: Models;
  readonly model: Model<string>;
  readonly invocation: SemanticConversionInvocation;
  readonly infrastructure: SemanticExecutionInfrastructure;
}): Promise<SemanticConversionResult>;
```

Internally it performs:

```text
validate/freeze Invocation
→ prepare reasoning
→ map audited Pi common options
→ select certified reasoning/general projectors
→ install one wrapper-owned onPayload
→ call Pi streamSimple
→ return AssistantMessage + effective outcomes
```

The `onPayload` order is:

1. validate the exact payload shape for the resolved `model.api`;
2. apply reasoning-owned fields;
3. apply general supplement fields that do not overlap reasoning;
4. validate ownership conflicts and final required controls;
5. return a copied payload.

Infrastructure callbacks already owned by Pi execution may be composed only through explicit wrapper rules. A Client Adapter never creates or captures `onPayload`.

## 9. Provider projector contract

A projector must declare:

- exact `model.api` values supported;
- any Provider/model compatibility predicate;
- expected pinned Pi payload shape and version evidence;
- semantic fields it owns;
- unsupported and malformed behavior;
- whether a mapping is exact, approximate, or unavailable.

An exact-value verifier repairs a mismatch only when the exact Provider field and replacement are certified. `max_output_tokens` is a request control over the generated response's total output-token ceiling, not the Client input-token size. An upper-bound verifier may accept a smaller response-output ceiling required by context safety, but a final Provider request that raises the ceiling above the Client value fails. A Provider minimum cannot widen that hard limit.

It must not:

- import Client Protocol wire types;
- receive a raw Client request;
- resolve credentials or endpoints;
- send the request;
- mutate Pi-owned objects in place;
- write an unregistered Provider field;
- silently accept an unknown payload shape.

One adapter implementation may cover multiple APIs only when they truly share an audited payload contract. Shared source code does not waive independent final-wire tests.

### 9.1 Current LuckyToken reuse map

The refactor reuses current ownership as follows:

| Current implementation | Refactored role |
|---|---|
| `convertResponsesRequest()` validation, message/tool conversion, and Pi option construction | implementation inside the wrapped OpenAI Responses Client conversion module |
| `ResponsesInvocation.context` and `.options` | `ClientConversionResult.invocation.pi` |
| `ResponsesInvocation.renderState` and `.notices` | `ClientConversionResult.client`; never passed to Provider projectors |
| current request-local reference resolution and history expansion | stays Client-adapter-owned before the semantic Invocation is finalized |
| current infrastructure/router option composition | stays on the execution side and is composed by the Pi wrapper |
| `execute()` and `models.streamSimple()` | remain Pi execution machinery called by the wrapper |
| Provider Profile binding and 429 retry behavior | remains outside conversion/projectors and wraps the same execution call |
| new `ReasoningSemantics` | added beside the reused Pi conversion result |
| new complete `ProjectionSupplement` | added beside the reused Pi conversion result |
| new Provider projectors | called only from the wrapper-owned `onPayload` seam |

This arrangement reduces the refactor to three controlled additions around proven code:

1. deepen the converter's returned value;
2. wrap the existing Pi execution call;
3. register target projectors incrementally.

It does not create a second protocol converter or a second Provider request builder.

## 10. Implementation route

This is an incremental composition refactor, not a big-bang rewrite. At every phase, the existing Pi conversion remains runnable and previously supported requests keep their current behavior unless a test intentionally changes a documented semantic loss.

### Phase 0 — Freeze evidence and tests

1. Pin the Pi package version and record the ten built-in API IDs.
2. Add test helpers that capture the payload after Pi `onPayload` and before transport.
3. Establish final-wire fixtures for each API without touching real credentials or user state.
4. Mark every adapter/semantic pair `uncertified` by default.

Exit condition: a failing final-wire test can demonstrate the present reasoning loss.

### Phase 1 — Reasoning contracts and Client extraction

1. Add `ReasoningRequestIntent`, `HistoricalReasoning`, provenance, attachment, and continuity types.
2. Change Responses request parsing to preserve omission, explicit `none`, effort, and summary preference separately.
3. Extract historical reasoning summary text and the complete continuity facts needed for later target replay.
4. Stop treating a Responses-owned envelope as though it were automatically the complete Pi Responses reasoning item.
5. Keep visible summary text available even when opaque continuity is malformed or incompatible, unless the Client input itself is invalid.

Exit condition: Client Wire → Invocation tests prove complete reasoning capture without knowing the Provider target.

### Phase 2 — Target-aware reasoning preparation

1. Implement the reasoning module's two-operation Interface.
2. Add internal adapters for all ten pinned Pi API IDs.
3. Begin with the exact policies that can be certified: OpenAI Completions field selection, OpenAI Responses complete-item replay, Anthropic signatures, Bedrock model-family rules, Google attachment rules, Mistral visible thinking, and Pi Messages delegation.
4. Resolve synthetic-history degradation without falsifying opaque provenance.
5. Produce explicit outcomes and conversion notices.

Exit condition: pure module tests cover same model, model switch, missing signature, malformed metadata, unsupported target, and content fallback for every adapter policy.

### Phase 3 — Response-side continuity

1. Extract signature/continuity fields from Pi responses according to the actual source `provider/api/model`.
2. Preserve the original attachment: thinking, text, or tool call.
3. Encode only a bounded verified Client-carried envelope.
4. Decode it on the next complete-history request.
5. Do not add server-side session persistence for facts the Client wire can carry.

Exit condition: Provider response → Client response → next Client request → Provider request restores compatible replay state end to end.

### Phase 4 — Deepen the existing conversion module and add the complete supplement

1. Audit the complete supported Client request schema.
2. Classify each fact as Pi IR, Pi option, reasoning, supplement, Client-only lifecycle, warning omission, or failure.
3. Add all validated Pi-unrepresentable facts to the supplement in one schema pass.
4. Do not wait for projector support before preserving a fact.
5. Expand the existing conversion result rather than creating a second request parser or message converter.
6. Keep existing `context`, `options`, render state, notices, tool correlation, and response conversion behavior behind the deepened module Interface.
7. Add equivalence tests proving that an empty supplement produces the same Pi inputs as the current implementation.

Exit condition: field-inventory tests prove that every recognized Client fact has an explicit owner and disposition, and unchanged requests produce equivalent Pi conversion output.

### Phase 5 — LuckyToken Pi Wrapper

1. Add a request-local wrapper around the current `model + context + options` Pi execution entry; do not rewrite Pi execution internals.
2. Keep credential binding, retry, cancellation, streaming, and diagnostics behavior unchanged behind the wrapper.
3. Create the single wrapper-owned `onPayload` callback.
4. Compose reasoning projection first and non-overlapping general projection second.
5. Return effective projection outcomes for honest Client response echo and diagnostics.
6. First run the wrapper with all general projectors disabled and prove final Provider request equivalence with the current execution path.

Exit condition: the wrapper can execute with no projector and remains equivalent to current Pi execution for unaffected requests.

### Phase 6 — Incremental Provider projectors

Implement projectors in value order, not by pretending all Providers are identical:

1. `openai-completions`;
2. `anthropic-messages`;
3. `google-generative-ai` and `google-vertex` with separate certification;
4. `mistral-conversations`;
5. `bedrock-converse-stream` by model family;
6. Responses-family semantic targets where Native Preservation is ineligible;
7. `pi-messages` only for semantics its wire contract actually accepts.

Each projector may support a subset of the complete supplement. Remaining facts keep explicit unsupported outcomes.

Adding a projector does not change the Client conversion Interface or Pi execution machinery. It only adds another Adapter at the Provider payload seam and registers its certified target predicate with the wrapper.

Exit condition for each semantic: Client Wire → final captured Provider Wire test passes for every enabled target mapping.

### Phase 7 — Effective-state response rendering

1. Stop echoing raw requested/default values as though they took effect.
2. Render only wrapper-reported effective controls.
3. Keep conversion warnings non-model-visible and request-local.

Exit condition: Client responses never claim application of a field that the final Provider request omitted.

### Phase 8 — Pi upgrade gate

For every Pi dependency upgrade:

1. diff adapter request builders, response parsers, option mapping, message transforms, and `onPayload` shapes;
2. rerun all final-wire contract tests;
3. disable a projector when its audited payload contract no longer holds;
4. update this matrix and evidence before re-enabling it.

## 11. Required test matrix

### 11.1 Reasoning history

For every certified adapter:

- same Provider/API/model with valid continuity;
- same API but different model;
- different Provider;
- visible summary without continuity;
- opaque continuity without visible summary where legal;
- malformed continuity envelope;
- signature attached to thinking, text, and tool call where the adapter supports each;
- target supports reasoning generation but not historical reasoning replay;
- target does not support reasoning.

### 11.2 Reasoning request controls

- omitted vs explicit disabled;
- every supported effort level and target clamp;
- `summary: auto`, `concise`, and `detailed`;
- target with exact mapping;
- target with approximate mapping;
- target with no mapping;
- Pi-native and payload-projected paths never both write the same field.

### 11.3 End-to-end assertions

Tests start with a Client Wire request and assert the final captured Provider payload after `onPayload`. Response continuity tests additionally start with a simulated Provider response and include the full next-request cycle.

Intermediate snapshots are useful for diagnosis but cannot certify semantic support.

## 12. Current known gaps this route closes

1. Responses reasoning omission and explicit `effort: "none"` are currently collapsed.
2. Responses `reasoning.summary` is not carried through the common Pi options.
3. Converted Client history currently uses synthetic provenance, causing Pi to downgrade thinking before some Provider builders see it.
4. OpenAI Completions uses `thinkingSignature` as a reasoning field selector, while other adapters use it as opaque continuity; treating them uniformly is incorrect.
5. OpenAI Responses replay requires a complete serialized reasoning item; a generic encrypted-content envelope is not automatically that item.
6. Several Providers attach opaque thought signatures to text or tool calls, not only thinking blocks.
7. Current semantic conversion loses other recognized request controls because there is not yet a complete supplement and wrapper-owned projection seam.

## 13. Definition of done

The refactor is complete when:

- the existing Client conversion implementation remains the single implementation of proven Pi message/tool conversion;
- the wrapper with projectors disabled is equivalent to the previous Pi execution path;
- every supported Client request field has one authoritative lifecycle owner;
- reasoning generation intent and historical reasoning are distinct typed facts;
- all ten pinned Pi API adapters have an explicit reasoning policy, even if that policy is unsupported/fallback;
- compatible opaque continuity round-trips through the Client response and next request;
- the wrapper owns target resolution and payload projection without modifying Pi;
- the supplement captures every validated Pi-unrepresentable fact;
- projectors mutate only certified fields and shapes;
- effective Client responses match the actual final Provider request;
- end-to-end final-wire tests, not intermediate snapshots, are the release gate.
