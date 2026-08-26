# Token Anthropic Messages Semantic Conversion Architecture Specification

Status: **IMPLEMENTED PROTOCOL CONTRACT — ANTHROPIC-SCOPED CERTIFICATION CURRENT**
Date: **2026-08-24**
Scope: Anthropic Messages as the Client Protocol on the Semantic Conversion lane. This specification does not govern Anthropic Provider Native Preservation, OpenAI Responses Semantic Conversion, or any other Client Protocol.

This document is the authoritative architecture contract for:

```text
Anthropic Client Wire
→ Anthropic-owned Semantic Invocation
→ Anthropic-owned reasoning and target projection
→ Anthropic-owned Pi payload execution
→ Pi Provider
→ Provider Wire
→ Pi AssistantMessage
→ Anthropic Client Wire
```

The cross-protocol locality rules remain authoritative in [Token Semantic Conversion Architecture Specification](./TokenSemanticConversionArchitectureSpec.md). This document defines everything specific to Anthropic Messages, including its Pi payload-callback execution lifecycle.

## 1. Decision

Anthropic Messages is a cohesive Client Protocol Semantic Module. It owns:

- Anthropic request validation and conversion;
- an Anthropic-only Semantic Invocation;
- an Anthropic-only projection supplement;
- Anthropic reasoning generation and history semantics;
- Anthropic continuity parsing and rendering;
- an Anthropic-owned request projector registry;
- an Anthropic-owned Pi payload execution wrapper and semantic error types;
- Anthropic-owned Pi `AssistantMessage` response conversion with narrow provenance-aware rules where required;
- Anthropic response/SSE conversion and projection-notice policy;
- Anthropic unit, integration, certification, and online tests.

It does not import or reuse OpenAI Responses semantic types, supplement builders, reasoning policies, target projectors, continuity codecs, fixtures, or expected-wire assertions.

The module uses the existing protocol-neutral `ExecutionOperation` capability to invoke pinned Pi AI, but owns its `onPayload` lifecycle, projection outcomes, and semantic failures. It may reuse only proven mechanism-level leaf utilities that remain unaware of every Client Protocol and do not call Pi or own payload projection.

## 2. Lane scope

Lane selection completes before this module executes.

```text
Anthropic request
→ resolve model
→ evaluate Provider Native claim
   ├─ claimed: Anthropic Provider Native lane
   └─ not claimed: this Anthropic Semantic Conversion module
```

After Semantic Conversion commitment, failure does not fall through to Provider Native or Direct Mode.

This specification does not broaden Anthropic Provider Native eligibility. A request claimed by Provider Native bypasses this module. A resolved `anthropic-messages` target not claimed by Provider Native remains a Semantic Conversion target: request supplements need an audited Anthropic-source projector when used, while its response is rendered from Pi `AssistantMessage` by the Anthropic response module. Native eligibility cannot be assumed to cover it.

## 3. Correctness endpoint

The final Provider request is authoritative. Request support is demand-driven: an Anthropic source fact is part of Semantic Conversion only when Section 5.1 positively declares a current consumer for its exact source path.

For every consumed fact, one of these must be proved for the resolved target:

1. Pi IR/options emit an equivalent Provider control and the Anthropic module verifies it where required;
2. an Anthropic target Adapter writes a certified equivalent through the Anthropic-owned `onPayload` seam;
3. a documented bounded fallback preserves the strongest valid model-visible meaning and emits a warning;
4. target unavailability omits a candidate-only Supplement fact and emits a warning.

A field or nested path with no declared consumer remains unread: it is not parsed, shape-validated, projected, guessed, or used for dispatch. A separately declared security, ordinary Client-tool relationship, or minimum-request contract is consumed by request validation or the authoritative Pi/main-call contract and may fail before Provider dispatch. `inference_geo` and Provider/server-tool facts are candidate-only semantics: target unavailability omits them and never promotes them into a terminal main-call contract. There is no end-user strict-mode override. Every fallback is reported as degraded rather than exact, and source-field presence alone never proves effectiveness.

## 4. Anthropic module seams

The implementation keeps three cohesive Interfaces instead of adding a facade that receives raw request, execution, and response concerns together:

```ts
convertValidatedAnthropicRequestWithPolicy(...)
  -> AnthropicConversionResult

executeAnthropicSemanticInvocation({
  models,
  model,
  invocation,
  execution,
}) -> { message, outcomes }

convertAssistantMessageToAnthropicResponse(...)
  -> AnthropicResponseConversion
```

The request converter owns Client Wire extraction and creates the protocol-owned Invocation. The semantic executor owns target selection, reasoning preparation, the exclusive `onPayload` lifecycle, central candidate accounting, and the Pi call. The response converter owns Pi `AssistantMessage` to Anthropic JSON/SSE semantics and continuity rendering. None receives another seam's raw internal objects merely for convenience.

HTTP packaging, lane selection, Profile binding, retry, cancellation, credentials, and transport remain outside these Interfaces. Availability disposition is a fixed Anthropic protocol contract, not request state or user configuration, and therefore does not enter an Interface, Pi IR, reasoning, or the Supplement. Callers do not assemble target registries or Pi callbacks.

## 5. Anthropic Semantic Invocation

The request converter returns an Anthropic-owned representation:

```ts
interface AnthropicSemanticInvocation {
  readonly pi: PiInvocation;
  readonly reasoning: AnthropicReasoningSemantics;
  readonly supplement: AnthropicProjectionSupplement;
}

interface AnthropicConversionResult {
  readonly selector: string;
  readonly invocation: AnthropicSemanticInvocation;
  readonly client: {
    readonly renderState: AnthropicResponseRenderState;
    readonly notices: readonly ConversionNotice[];
  };
}
```

These types are not added to a common Client Invocation union. No other Client Protocol consumes them.

One Anthropic conversion operation remains the sole raw-body reader. It first creates the consumer-specific views defined below and then validates each consumed path once while producing Pi, reasoning, Supplement, render-state, and notice outputs. No downstream parser receives or reinterprets the complete raw body.

### 5.1 Demand-driven request extraction

Anthropic Semantic Conversion does not validate the complete current or future Anthropic request schema. It has exactly two source-request consumers.

The **main Anthropic consumer** constructs the selector, Pi Context/options, reasoning and continuity, response render state, and non-degradable main-call checks from these top-level fields and paths:

```text
model
max_tokens
messages
system
stream
temperature
top_p
top_k
tools
tool_choice
stop_sequences
thinking
output_config.effort
metadata.user_id
cache_control
```

Within `messages`, `system`, and `tools`, this consumer reads only:

- message `role`, content ordering, content `type`, and the model-visible fields and identities needed to construct Pi text/image/thinking/tool-call/tool-result history;
- historical `thinking`, `redacted_thinking`, their native opaque values, and the item-local `token_continuity` paths defined in Section 7;
- system string or text-block `text` needed for the Pi system prompt;
- ordinary tool `name`, `description`, and `input_schema` needed for Pi tools;
- exact ordinary Client tool-call/result IDs and caller facts required to validate identities, permissions, and history relationships, plus only the server-tool discriminator and visible content needed to classify and safely omit or project server-owned semantics;
- `thinking.type`, `thinking.budget_tokens`, and `thinking.display`;
- `tool_choice.type`, `tool_choice.name`, and `tool_choice.disable_parallel_tool_use`;
- `output_config.effort`, `metadata.user_id`, and the exact top-level cache paths named above.

The **Anthropic Supplement consumer** constructs only currently projection-eligible candidates from these source paths:

| Supplement candidate | Positive source paths |
|---|---|
| final output ceiling | `max_tokens` |
| sampling verification/projection | `temperature`, `top_p`, `top_k` |
| stop control | `stop_sequences` |
| tool selection/cardinality | `tool_choice.type`, `.name`, `.disable_parallel_tool_use` |
| structured output | `output_config.format.type`, `.schema` |
| end-user identity | `metadata.user_id` |
| target preferences/affinity | `service_tier`, `container` |
| exact cache semantics | top-level, system-text-block, content-block, and tool `cache_control.type`/`.ttl` |
| data-residency projection candidate | `inference_geo` |
| assistant continuation fallback | the final assistant message and its visible content ordering |
| target-reconstructable structured content | only the recognized system/content/tool tagged variants and their exact fields currently consumed by at least one enabled Anthropic target Adapter |

The last row is closed by the request audit and enabled Adapter tests, not by the entire Anthropic SDK schema. Its current consumed variants are text citations, URL/base64 images, document and search-result sources, tool references, caller/cache attachments, custom/server tool fields, nested tool results, server-tool results, and container uploads only where an enabled Adapter reconstructs or must verify that exact fact. Removing the last enabled consumer for a nested path removes that path from the Supplement declaration; adding future Client grammar does not add it automatically.

The allowlists deliberately overlap only where Pi-first emission followed by final-wire verification/repair is required, or where a non-degradable main-call constraint also has a certified Provider projection. Pi or the main-call contract remains authoritative; a Supplement copy is never a second writer or a terminal-policy owner.

The conversion operation selects own properties and declared nested paths for both consumers before their validators run. For a claimed object, a consumer validates only the paths it reads. An unclaimed sibling does not invalidate the object. The continuity envelope remains closed-world because its complete bounded shape is itself a consumed opaque-replay contract.

A top-level key present in neither consumer is not read. The converter may publish a bounded request-local warning derived from the present keys minus the union of these positive declarations, but that observation is not a third unsupported-field registry. Malformed unclaimed values do not prevent dispatch. Native Preservation lane commitment precedes this extraction and bypasses it entirely.

## 6. Information ownership

Every consumed request fact has one authoritative owner:

| Fact | Owner |
|---|---|
| ordered messages, system text, images, ordinary tool definitions, tool calls/results | Pi `Context` |
| target-certified Pi common options, including `temperature` and concrete `output_config.effort` | Pi options |
| thinking activation, exact budget, historical thinking, continuity | Anthropic reasoning module |
| current projection candidates retained for target-dependent projection or final-wire certification | Anthropic supplement; Pi options and non-degradable main-call checks remain authoritative where they own the semantic |
| stream choice, `thinking.display`, and standard Anthropic response envelope | Anthropic response state |
| Pi `AssistantMessage` facts and Anthropic response mapping | Anthropic response module |
| conversion, fallback, omission, and repair notices | Anthropic-owned bounded facts published through fail-open observation |
| model resolution | runtime/composition before semantic execution |
| credentials, Profile binding, transport, retries, cancellation | existing infrastructure |
| Request Journey and telemetry | fail-open diagnostics owner |

Pi IR is conversation/history IR, not a storage carrier for source request controls. The Anthropic supplement is typed protocol state, not a raw request bag.

Unclaimed source fields have no semantic owner because this module does not consume them. A warning about their presence is observation only and does not turn them into recognized or supported semantics.

## 7. Anthropic reasoning contract

### 7.1 Generation intent

The Anthropic reasoning type must represent the source grammar without translating it into OpenAI Responses concepts.

At minimum, preserve these distinct states:

```ts
type AnthropicThinkingDisplayIntent =
  | { readonly kind: "omitted" }
  | { readonly kind: "explicit-null" }
  | {
      readonly kind: "specified";
      readonly value: "summarized" | "omitted";
    };

type AnthropicThinkingActivation =
  | { readonly kind: "omitted" }
  | { readonly kind: "disabled" }
  | {
      readonly kind: "enabled";
      readonly budgetTokens: number;
      readonly display: AnthropicThinkingDisplayIntent;
    }
  | {
      readonly kind: "adaptive";
      readonly display: AnthropicThinkingDisplayIntent;
    };

type AnthropicEffortIntent =
  | { readonly kind: "omitted" }
  | { readonly kind: "explicit-null" }
  | {
      readonly kind: "specified";
      readonly level: "low" | "medium" | "high" | "xhigh" | "max";
    };
```

The exact relationship between `thinking`, `output_config.effort`, and `max_tokens` must follow the pinned Anthropic grammar and target audit. An enabled budget is at least 1,024 and strictly less than the Client `max_tokens`; neither Pi preparation nor Provider projection may widen the Client's total output-token ceiling. A concrete `output_config.effort` is mapped to the audited Pi reasoning option and remains Pi-owned through Provider request construction. Pi's certified `thinkingLevelMap` or Provider compatibility mapping is an equivalent mapping rather than a Token precision loss; when the resolved target supports no equivalent effort control, omit only that preference and warn. `onPayload` must not independently remap an effort already owned by Pi options.

`thinking.display` is a Client-response rendering instruction, not a Provider-generation control. The request converter validates it and stores its omission/null/value state in `AnthropicResponseRenderState`; it is not projected into the Provider request on the Semantic Conversion lane. Before target resolution and outside an explicitly selected availability fallback, do not:

- collapse omitted and disabled;
- encode adaptive as Provider default while claiming an exact mapping;
- replace an exact budget with a guessed effort while claiming an exact mapping;
- collapse display omission, explicit `null`, `summarized`, and `omitted` before Anthropic response rendering;
- enable thinking merely because a similarly named target field exists;
- claim disabled unless the final Provider request proves it; target-default fallback reports `degraded` instead.

### 7.2 Historical reasoning

The module preserves visible historical thinking as Pi `ThinkingContent` when the resolved target can accept reasoning history, while separately retaining the source facts needed for replay decisions. For a non-reasoning target, preparation converts visible historical thinking to ordinary assistant text, discards only opaque target-bound state, and records a degradation; redacted history with no visible content is omitted with a warning.

Replay decisions retain:

- message/content attachment;
- whether the source block was `thinking` or `redacted_thinking`;
- native signature or redacted data;
- actual originating Provider/API/model when produced by Token;
- whether the value is opaque and target-bound.

Synthetic Client history provenance is not sufficient for exact replay. The target reasoning projector restores opaque state only when validated source provenance is compatible with the resolved target contract.

### 7.3 Client-wire continuity

Anthropic-native values use their standard wire positions only when they satisfy the Anthropic field contract:

- `thinking.signature` for a compatible Anthropic thinking signature;
- `redacted_thinking.data` for a compatible redacted Anthropic payload.

Foreign Provider signatures do not masquerade as those fields. The approved foreign-continuity carrier is an item-local `token_continuity` extension on the Anthropic content block that owns the state:

```ts
interface TokenAnthropicContinuityEnvelopeV1 {
  readonly version: 1;
  readonly source: {
    readonly provider: string;
    readonly api: string;
    readonly model: string;
  };
  readonly attachments: readonly (
    | {
        readonly target: "thinking";
        readonly kind: "native-field-provenance";
        readonly representation?: "redacted";
      }
    | {
        readonly target: "thinking";
        readonly kind: "opaque-signature" | "opaque-reasoning-state";
        readonly value: string;
        readonly representation?: "redacted";
      }
    | {
        readonly target: "text";
        readonly kind: "opaque-signature";
        readonly value: string;
      }
    | {
        readonly target: "toolCall";
        readonly callId: string;
        readonly kind: "opaque-signature" | "opaque-reasoning-state";
        readonly value: string;
      }
  )[];
}
```

`native-field-provenance` carries provenance only and is valid only when the same block contains a standard Anthropic `thinking.signature` or `redacted_thinking.data`; it never duplicates that opaque value. Every other attachment requires a non-empty bounded value. A tool-call attachment's `callId` must equal the owning `tool_use.id`. A block cannot carry an attachment for a different target.

The codec validates keys closed-world, applies the existing Anthropic request/response byte limits, rejects duplicate attachment identities, and ignores malformed, misplaced, incompatible, or unknown-version attachments individually with a developer notice while preserving valid visible content. It never stores visible thinking, text, tool names, or arguments.

Whenever a Pi response contains certified foreign opaque continuity, the Anthropic renderer emits this envelope on the owning content block. On the next request, presence of a valid returned envelope establishes `item-extension-v1` for that history item; absence means only native fields are available and triggers the defined visible fallback/notice where foreign exact replay mattered.

Client capability is explicit rather than assumed:

- `native-fields-only`: standard Anthropic thinking/redacted continuity can round-trip; foreign text/tool/reasoning state degrades to visible meaning and a notice;
- `item-extension-v1`: the client returns `token_continuity` unchanged in complete history, enabling certified foreign opaque replay.

Direct-protocol tests must certify `item-extension-v1`. Claude Code/Claude CLI tests separately determine whether that real client preserves the extension; absence is reported as a declared capability limit, not counted as a successful foreign-continuity round trip.

No server-side continuity store is part of this contract.

## 8. Anthropic Projection Supplement

`AnthropicProjectionSupplement` is an immutable **candidate-only carrier**. After the main consumer has produced the strongest correct Pi Context/options and main-call checks, the Supplement retains only the validated facts named by the positive Supplement consumer in Section 5.1. Every retained fact has at least one current enabled target Adapter that can project it, verify its Pi-native final representation, or perform one named bounded fallback.

It is not a copy of the supported Anthropic schema, a future-field holding area, an unsupported-field registry, or a promise that every target can project every candidate. A recognized main-consumer fact does not enter the Supplement unless a current target Adapter also needs it. A field claimed by neither consumer remains unread rather than being captured for possible future use. Anthropic reasoning/continuity remains its separately typed special case; concrete effort remains Pi-owned.

For every candidate, the Supplement records only the validated value and the minimum source attachment/provenance facts needed by an enabled Anthropic Adapter or final-wire verifier. It does not contain:

- the raw Anthropic request;
- raw unvalidated nested records merely for future use;
- Provider payload objects;
- credentials or transport state;
- another Client Protocol's normalized field name.

Supplement completeness means complete coverage of the current positive candidate declaration, not complete pre-target preservation of Client Wire. Adding a candidate requires a current consumer, an exact source-path declaration, a target mapping or named fallback, and a Client Wire to final Provider Wire test. Removing its last target consumer removes the candidate instead of leaving a dormant field.

The ordinary Supplement projection outcome type excludes `failed`. It may record exact Pi use, payload projection/repair, a named bounded degradation, or central omission. Reasoning and the non-degradable main-call contract own their separate terminal outcomes and do not weaken this candidate-only boundary.

The pinned Pi option remains the sole final writer for `temperature`, even when the Supplement retains the validated Client value alongside other sampling controls. The projector may observe the final field only for bounded certification; it must not restore a temperature that Pi intentionally omitted for a target incompatibility such as Anthropic extended thinking. The separately retained output-token fact is named `outputTokenCeiling` because it is not a second ordinary Pi `maxTokens` value: it preserves Anthropic's hard total-output ceiling after Pi may have added or clamped a thinking budget.

Omission, explicit `null`, explicit disable, and an empty value remain distinct only for consumed paths whose Anthropic semantics or target mapping distinguishes them. Block- and tool-local candidates carry stable request-local semantic identities such as source message/content indexes, tool name, or call ID. The converter records their association to the Pi block/tool it created without inserting marker text into Pi IR. For a retained rich ToolResult block that also emitted a Pi fallback item, this minimum association includes the emitted-item count so exact reconstruction consumes rather than orphans that Pi item; it does not duplicate the item value. A target projector mutates a nested Provider field only when that association resolves unambiguously in the audited payload; otherwise it leaves the candidate unconsumed for central omission or the named bounded fallback.

Token formally supports message-level `role: "system"` as a product compatibility extension. Text from the first such message is appended to the top-level Pi system prompt; non-text blocks from that message remain ordinary user content at their source position; every later system message becomes ordinary user content. No non-text block receives system privilege, empty fragments are omitted, and the converter publishes at most one degradation notice per request. This extension is tested separately from the standard Anthropic role grammar and is not retained as a Supplement candidate because no target Adapter consumes the original role.

Target-bound state such as container identity remains explicitly Anthropic-owned with provenance and compatibility conditions only while a current Adapter consumes it. A field becomes a shared mechanism only when it has no Client semantic meaning.

## 9. Anthropic target projectors

The private registry selects by resolved `model.api` plus only the Provider/model compatibility facts required by a proven mapping. It contains an Adapter only when that target currently has at least one certified supplement or reasoning mapping. Do not create no-op, placeholder, or “future completeness” Adapters.

Target families eligible for incremental audit are:

1. CommandCode Private;
2. Anthropic Messages when the target was not claimed by Provider Native;
3. OpenAI Completions, split further by certified Provider/model compatibility;
4. OpenAI Responses;
5. Azure OpenAI Responses;
6. OpenAI Codex Responses;
7. Google Generative AI;
8. Google Vertex;
9. Mistral Conversations;
10. Bedrock Converse Stream, split by Claude and non-Claude model families;
11. Pi Messages.

This list is not a requirement to implement every target before the module is usable. A target without a projector still uses Pi normally; every present Supplement candidate receives the central unconsumed omission warning.

Every projector is an Anthropic-source/target-API Adapter with one small Interface: it receives the Pi-built payload, resolved target facts, the immutable Anthropic candidate Supplement, and prepared Anthropic reasoning; it returns a copied payload plus the facts it consumed and their outcomes. Its implementation owns only:

- exact Pi payload shape validation;
- validation of Pi-native fields relevant to the mappings it actually uses;
- certified repair or added-field projection for those mappings;
- the minimum compatibility conditions for those mappings;
- consumed-field outcomes.

A projector is positive-only. It implements only facts it can express with a proven target representation; it does not add branches whose sole result is “unsupported,” “ignored,” or “omitted.”

The Anthropic execution module, not each Adapter, records every ordinary Supplement candidate left unconsumed as `omitted` with a warning. A named bounded degradation remains Adapter-owned only when that Adapter actually constructs or verifies the fallback. Supplement target unavailability never produces `failed`, throws, or prevents dispatch. Non-degradable request conditions are owned and enforced by the main consumer/main-call contract before this best-effort seam. An Adapter must not add switch branches for fields it cannot project and does not claim support merely by accepting the Supplement input.

It may duplicate logic that exists in an OpenAI Responses projector. It does not import that projector or its source semantic types.

One implementation may cover more than one target API only when the mappings it implements use identical pinned payload contracts. Certification is per enabled mapping, not per theoretical target/field cross-product.

### 9.1 Pi-first rule

When a Pi option is audited for the resolved target, use it first. `onPayload` may validate its final Provider representation but must not become a second writer for that semantic. A certified Pi compatibility mapping, including a mapped reasoning-effort value, is accepted as `pi-native`. A contradictory value may be repaired only when the exact target field/value is certified; every repair emits a developer warning. If the exact repair is unknown, do not guess.

### 9.2 One writer

Anthropic reasoning and ordinary supplement projection compose inside one Anthropic projection operation. Each final Provider field has one owner. A detected overlap fails before payload mutation.

### 9.3 Unknown target

An unknown API receives no guessed mutation. A request that needs no Anthropic supplement projection may still use Pi's ordinary Provider Adapter. Every remaining Supplement candidate, including `inference_geo` and Provider/server-tool candidates, is omitted with a warning and dispatch continues. Security, ordinary Client-tool relationships, and minimum request facts have already been enforced by the main consumer/main-call contract; they are not reclassified as Supplement failures here.

An audited projector receiving a payload shape different from its pinned contract is a different condition: it indicates a wrong projector selection, an incompatible custom Provider, or Pi dependency drift. The projector fails before dispatch because mutating an unknown body shape could corrupt the whole request. This internal compatibility failure is not controlled by an end-user availability setting.

### 9.4 Bounded availability fallbacks

The source converter always retains the exact `tool_choice` and `disable_parallel_tool_use` facts. Only the resolved target Adapter applies the fixed fallback, and only after confirming that the target can accept an ordinary automatic tool request.

When exact forced choice is unsupported:

- `any` becomes target automatic tool selection with every otherwise reachable source tool retained;
- named choice becomes target automatic tool selection with only the named tool exposed for the current request;
- the named tool must exist, filtering must not damage historical tool-call/result relationships, and the final target payload must remain valid;
- no tool call is fabricated when the model returns text;
- the outcome is `degraded`, not `pi-native` or exact `payload-projected`, and a developer warning names the lost guarantee.

When exact serial tool use is unsupported, the Adapter preserves the strongest supported tool choice, permits the target's parallel behavior, records a `degraded` outcome, and warns.

When exact `tool_choice.none` is unsupported, the Adapter removes every controllable current-request tool definition and tool-selection field, preserves valid historical tool-call/result relationships, and warns that target-level disablement was not proved. It never fabricates a tool result or silently drops history. If removing tools makes the final target request invalid, conversion still fails.

When exact structured output is unsupported, the Adapter uses the strongest certified fallback in this order: target JSON-object mode plus a bounded schema instruction, then a bounded schema instruction alone. The original validated schema remains the source of that instruction. The outcome warns that conformance is not guaranteed; response rendering does not fabricate, repair, or claim schema-valid JSON.

When exact stop control is unsupported, omit `stop_sequences` and warn. Do not inject a stop instruction into model-visible content and do not truncate the Provider response in the Anthropic renderer; either technique would invent behavior outside the target Provider request and could damage text/tool relationships.

Reasoning disable is already exact when the resolved model does not support reasoning and the final payload contains no reasoning-enabling control. If the model supports reasoning but the target has no certified disable field, Token removes known reasoning-enabling controls, accepts the target default, records a degradation, and warns. Exact-budget or adaptive activation uses the nearest certified target reasoning mode; a non-reasoning target uses ordinary generation. If a context-safe final token ceiling no longer leaves room above an enabled budget, reasoning is disabled for that request and warned rather than widening the Client ceiling or rejecting an otherwise usable request. None of these fallbacks remaps Pi-owned `output_config.effort`. The Anthropic response renderer independently enforces `thinking.display: "omitted"`.

When exact final-assistant continuation is unsupported, the existing assistant prefix remains ordinary visible assistant history and conversion warns that prefix-continuation behavior is not guaranteed.

All fallbacks and omissions must still construct a valid target payload. None relaxes consumed-source validation, output-token ceilings, safety, ordinary Client caller permissions, Client tool-call/result relationships, or payload-shape validation. An unsupported server tool is never downgraded to an ordinary Client tool: its server-specific candidate is omitted with a warning while any independently representable visible content remains available to Pi. Unsupported `inference_geo` is likewise omitted with a warning. Failure is permitted only when the remaining final target request itself is invalid.

CommandCode GOAT direct wire-probe evidence for `deepseek/deepseek-v4-flash` is version-bound evidence for this fallback, not a general OpenAI Completions capability. The independent Anthropic online certification reproduced the bounded automatic fallback on 2026-08-24: required/named forced choices remain incompatible with thinking mode, while automatic selection with only the named tool exposed remains usable. The source-code evidence comment beside the GOAT compatibility rule must remain until replacement online certification updates both code and this specification.

## 10. Anthropic-owned Pi payload execution

The Anthropic semantic executor creates one prepared projection operation after target resolution and passes it to its own Pi execution wrapper:

```text
Pi Context/options
+ Anthropic-owned PayloadProjectionOperation
→ executeWithAnthropicPi()
```

The Anthropic wrapper:

- owns `onPayload`;
- invokes the operation exactly once;
- runs Supplement projection followed by reasoning projection against the same final request and rejects duplicate or unowned outcomes;
- centrally resolves every remaining ordinary candidate to `omitted + warning`;
- rejects only internal payload-contract violations at this seam;
- calls the existing `ExecutionOperation`;
- returns the Pi `AssistantMessage` and outcomes.

This lifecycle is implemented in `src/protocols/anthropic/semantic/pi-execution.ts`. It uses only Anthropic-named contracts and the existing `ExecutionOperation`; it does not import an OpenAI Responses or shared Semantic Conversion executor. It receives prepared Pi input and one Anthropic projection operation, not raw Anthropic Wire or parser-internal objects.

## 11. Anthropic response contract

The existing response converter remains authoritative for standard Anthropic JSON/SSE validity. Deepen it as one Anthropic-owned `Pi AssistantMessage -> Anthropic JSON/SSE` module. It consumes only Pi response IR plus `AnthropicResponseRenderState`; it does not receive raw Provider streams, Provider payloads, diagnostics data, or a Provider-response interception callback. The module may inspect the actual `AssistantMessage.api/provider/model` provenance when the meaning of a retained Pi field depends on it, but a per-Provider response registry is not required merely because request projection uses per-Provider Adapters.

The response field audit starts from facts actually retained in Pi `AssistantMessage` and covers:

- response ID/model/role and content ordering;
- text, citations, thinking, redacted thinking, and all signature attachment positions;
- client tool use, caller identity, server-tool use/results, tool search, and container-upload blocks;
- `container`;
- `stop_reason`, `stop_sequence`, `pause_turn`, `refusal`, and `stop_details`;
- usage input/output/cache breakdown, thinking tokens, server-tool use, inference geography, and service tier;
- JSON and SSE start/delta/stop forms, including citations, signatures, structured tool input, and terminal deltas;
- whether each fact is response-only or required in the next full-history request.

For each Pi-retained fact, the converter chooses exactly one disposition:

1. exact Pi-native rendering;
2. provenance-aware interpretation from a Pi field such as `rawStopReason`, content signatures, or usage details;
3. a null/default explicitly defined by the Anthropic response contract;
4. visible fallback or omission with a bounded developer notice when the protocol permits loss;
5. conversion failure when a valid Anthropic response, security fact, tool relationship, output constraint, or required replay state cannot be constructed.

`onPayload` cannot recover response fields. A Provider fact that the pinned Pi response parser discarded is unavailable to this lane; the response converter uses only a protocol-valid omission/default/fallback allowed by the Anthropic response contract and warns when useful information was lost. It is never guessed, read from diagnostics, or recovered by injecting a transport.

When `thinking.display` is `"omitted"`, the converter emits the Anthropic omitted-thinking representation: visible `thinking` is the empty string and the retained signature is returned for continuity. This is response rendering, not Provider request projection and not a Client-UI responsibility. When a Pi thinking block has no non-empty signature, the converter may emit `signature: ""` as a lossy wire placeholder and warn; the next request treats that empty string as absent rather than replaying it as an opaque signature. This fallback preserves visible thinking for ordinary responses but does not claim exact native replay. It never substitutes an empty value for `redacted_thinking.data`, whose opaque data is the block content itself.

Anthropic Messages has no standard response fields that echo request `tool_choice`, sampling, reasoning activation, or other controls. Projection outcomes govern execution, developer notices, and certification only; the renderer must not invent Responses-style effective-state echo fields.

The response never exposes Provider credentials, headers, transport state, or raw payload fragments. Standard native Anthropic continuity and the approved `token_continuity` extension are the only opaque replay outputs.

### 11.1 Initial Pi-response attachment evidence

The audit begins from these pinned Pi facts and verifies their Anthropic rendering with fixtures:

| Pi response API | Retained reasoning/continuity starting point |
|---|---|
| `anthropic-messages` | thinking signature and redacted data on Pi thinking blocks |
| `bedrock-converse-stream` | Claude-family reasoning signature on Pi thinking; model-family rules remain separate |
| `google-generative-ai` | thought signatures may attach to thinking, text, or tool call |
| `google-vertex` | same attachment categories as `google-generative-ai`, independently certified |
| `openai-responses` | complete reasoning item state on thinking and message identity/phase on text |
| `azure-openai-responses` | Pi Responses-family representation with an independent Azure parser/wire fixture |
| `openai-codex-responses` | Pi Responses-family representation with Codex-specific defaults and independent fixture |
| `openai-completions` | visible reasoning plus Provider-specific reasoning state that may attach to thinking or tool calls |
| `mistral-conversations` | visible structured thinking; no opaque signature assumed |
| `pi-messages` | delegated Pi text/thinking/tool-call continuity fields |
| CommandCode Private | visible thinking; no opaque signature assumed until its Provider contract proves one |

This table routes Pi IR interpretation; it does not authorize raw Provider response handling. Exact replay support comes from Provider response → Pi `AssistantMessage` → Anthropic JSON/SSE → next complete-history request tests, while ordinary response-rendering correctness is tested directly at the Pi `AssistantMessage` seam.

## 12. Failure policy

The field audit assigns every failure one disposition. The stage labels are intentionally explicit:

- **Client request parsing**: Token is reading the Anthropic request; nothing has been sent upstream.
- **Provider request projection**: Pi built a candidate Provider payload; `onPayload` is validating or completing it before dispatch.
- **Client response rendering**: the Provider already responded and Token is constructing Anthropic JSON/SSE.
- **Next-request replay**: the current response is returned as complete history in a later Client request.

### 12.1 Fixed usability decisions

The following decisions are normative for Anthropic Messages Semantic Conversion. They may be changed only by an explicit architecture decision that updates this section, the implementation plan, the semantic audit, and the corresponding final-wire/response tests together:

1. A concrete `output_config.effort` is written once to Pi options. Pi's audited Provider Adapter and model compatibility mapping own the final effort representation. Token does not duplicate that mapping in `onPayload`; a target with no equivalent effort control omits the preference and warns.
2. `onPayload` selectively consumes only validated Supplement fields with a proven target mapping, and may perform bounded validation of audited Pi-native output. A Supplement copy of a Pi-owned value does not authorize a duplicate write. A known exact contradiction may be repaired with a developer warning; an unknown repair is never guessed.
3. Unsupported `stop_sequences` are omitted with a warning. Token does not inject stop instructions into model-visible content, truncate JSON/SSE output, or expose a strict-mode override for this loss.
4. An unsupported Anthropic server tool is omitted with a warning. It is never downgraded to a Client tool, and any independently representable visible result content is preserved. `inference_geo` follows the same candidate-only omission rule.
5. Lack of a certified Token projector does not disable an otherwise valid Pi-only request. Every unconsumed Supplement candidate is omitted with a warning. A non-degradable condition is enforced by request validation or the authoritative Pi/main-call contract before Supplement projection, never by converting an unconsumed candidate into failure.
6. A selected projector receiving a payload shape different from its audited contract fails before dispatch as an internal Pi/projector compatibility fault. This is not an end-user availability setting.
7. Response conversion consumes Pi `AssistantMessage` and Anthropic render state only. It does not inspect raw Provider responses and does not require a mirror per-Provider response registry; provenance-specific rules are internal to the Anthropic response module and exist only for Pi-retained fields.
8. If ordinary Pi thinking has no non-empty signature, Anthropic response rendering emits `signature: ""`, warns, and treats that empty value as absent on the next request. This is a lossy placeholder, not exact replay, and never applies to `redacted_thinking.data`.
9. `thinking.display: "omitted"` is a Client request field governing the Anthropic server response. The renderer emits empty visible thinking and preserves the Pi signature; it is not a Provider-generation projector or a Client-UI-only concern.
10. The Anthropic conversion operation is authoritative and performs demand-driven extraction before validation. Fields outside both positive consumers remain unread; projectors never receive raw Client Wire.
11. Supplement completeness means complete coverage of currently projection-eligible candidates, not complete pre-target preservation. Adding a candidate requires a declared source path, a current enabled target consumer, and a final-wire test; it does not require editing non-consuming Adapters.
12. The wrapper receives Pi input, prepared reasoning, and the immutable candidate Supplement together. It selects an Adapter from resolved target facts, applies only supported mappings, and centrally resolves every ordinary unconsumed candidate to `omitted + warning`. Named fallbacks are recorded only by the Adapter that constructs them. Targets with no proven mappings use the Pi-only path without a no-op Adapter.
13. Message-level `role: "system"` uses the fixed first-text promotion and later-user degradation contract, with one request-local notice and no system privilege for non-text content.
14. Unresolved ordinary Client ToolCalls receive a fixed honest synthetic `isError=true` ToolResult. Orphan, duplicate, empty-ID, result-before-call, ambiguous relationship, and server-tool lifecycle errors are not repaired.
15. Local cache breakpoints are projected only at an exact certified attachment point. Request-wide `promote` and its configuration are removed.
16. Unknown Pi response content and malformed optional ToolCall response blocks are omitted with a warning under the strongest-legal response rule; this is not configurable.
17. JSON and SSE consume the same converted Anthropic message, including `stop_reason: "refusal"`, and recompute tool-use termination after block omission.

### 12.2 Complete disposition table

The dispositions below are fixed protocol behavior; no strict-mode alternative exists:

| Stage | Condition | Disposition | Rationale |
|---|---|---|---|
| Client request parsing | malformed consumed source path, invalid consumed range, duplicate consumed identity, or broken tool-call/result relationship | fail | there is no valid consumed source meaning to project |
| Client request extraction | top-level field or nested sibling declared by no consumer | leave unread; optionally emit a bounded warning derived from positive declarations | an unclaimed field is neither supported nor invalid and cannot block dispatch |
| Client request parsing | unknown Client request content | existing `error|ignore` policy | ignoring an unknown tagged block is already an explicit compatibility choice |
| Provider request projection | unsupported forced `any` or named tool choice | automatic best effort plus warning | preserves usable tool execution without claiming a guarantee |
| Provider request projection | unsupported serial-tool guarantee | allow target parallel behavior plus warning | preserves usable tool execution without claiming cardinality |
| Provider request projection | unsupported `tool_choice.none` | remove every controllable current-request tool capability and warn | preserves availability while making the strongest possible disable attempt |
| Client request parsing / Provider request projection | absent named tool, permission/caller ambiguity, or filtering that breaks history relationships | fail | identities, permissions, and relationships cannot be guessed |
| Provider request projection | unsupported structured output schema | JSON-object/schema-prompt fallback plus warning | preserves the requested shape as model-visible guidance without claiming enforcement |
| Provider request projection | final output-token field is absent/malformed, or the Client ceiling itself is invalid | fail | an invalid source or unknown final payload cannot be repaired safely |
| Provider request projection | context-safe ceiling no longer leaves room above an otherwise valid enabled thinking budget | disable reasoning for this request and warn | preserves the output ceiling and request availability without sending an invalid budget relationship |
| Provider request projection | unsupported `stop_sequences` | omit the unsupported control and warn | stopping is a request preference; prompt injection or response truncation would invent a different behavior |
| Provider request projection | unsupported final-assistant prefill | ordinary visible assistant-history fallback plus warning | preserves the prefix context without claiming exact continuation |
| Provider request projection | exact reasoning activation/budget/adaptive mode unsupported | strongest certified target reasoning mode, or ordinary generation on a non-reasoning model, plus warning | choosing a less capable target may lose reasoning precision without making the request unusable |
| Pi option mapping / Provider request projection | unsupported reasoning effort, sampling, cache, service tier, or other declared preference | use the audited Pi-native mapping; otherwise omit only the unsupported preference and warn | Pi owns supported option mapping, and a missing preference does not invalidate the request |
| Provider request projection | explicit reasoning disable on a non-reasoning model | exact success with no warning | a model that cannot reason is already disabled |
| Provider request projection | explicit reasoning disable on a reasoning model with no disable control | remove enabling controls, accept target default, and warn | preserves availability without falsely claiming disablement |
| Client response rendering | explicit `thinking.display: "omitted"` | emit empty visible thinking and retain the Pi signature | this is an Anthropic response contract, not a Provider projection or UI option |
| Client response rendering / Next-request replay | Pi thinking has no non-empty signature | emit `signature: ""`, warn, and treat it as absent on the next request | preserves a valid visible response without pretending exact opaque continuity |
| Provider request projection | `inference_geo` or Provider/server-tool candidate has no exact target mapping | omit the candidate, warn, and dispatch | these are candidate-only preferences/capabilities; Token does not fabricate enforcement or execution |
| Client request parsing / Pi main-call contract | consumed safety, security, ordinary Client caller/tool permissions, or Client tool relationship cannot be honored | fail before Supplement projection | these relationships cannot be guessed or weakened |
| Client request parsing / Pi main-call contract | remaining consumed reachable model-visible content or document/media bytes has no valid target representation after candidate-only omissions | fail before Supplement projection | the final target request would otherwise be invalid or lose all usable model input |
| Provider request projection | optional request citation/cache annotation, redundant custom-tool type, or nullable metadata cannot be projected | retain visible content, omit only the auxiliary fact, and warn | failure would reduce availability without protecting a critical semantic |
| Client response rendering | unknown Pi response content | omit the block and warn | a future auxiliary block must not replace an otherwise legal response with an internal error |
| Client response rendering | unavailable citation, usage, container, tier, or other optional response auxiliary field | retain visible response, use a legal nullable/omitted form, and warn | auxiliary parser loss should not replace a usable response |
| Client response rendering | known Provider stop/refusal fact retained but optional detail discarded by Pi | render the strongest protocol-valid stop/refusal representation and warn | do not turn a usable response into an internal error solely for unavailable optional detail |
| Next-request replay | malformed, incompatible, or target-mismatched opaque continuity | discard only opaque state, preserve visible reasoning/text/tool identity, and warn | opaque target state must not destroy portable visible history |
| Client response rendering / Next-request replay | optional `pause_turn`, server-tool, or replay state cannot be reconstructed | preserve portable visible meaning, omit unavailable target-bound state, normalize to the strongest legal terminal, and warn | availability is preferred when no ordinary Client tool relationship is falsified |
| Provider request projection | unknown API or unaudited model family with Supplement candidates | leave Pi's payload unchanged, omit every candidate, warn, and dispatch | Supplement target unavailability is candidate-only; hard contracts were enforced earlier |
| Provider request projection | selected projector receives a final payload shape different from its audited contract | fail before dispatch | this is an internal Pi/projector compatibility fault and mutation would be unsafe |

Malformed consumed source state fails during Anthropic validation. Malformed unclaimed state remains unread. Unsupported preferences and policy-authorized fallbacks produce explicit outcomes and developer warnings. `degraded` is distinct from `omitted`, `pi-native`, and exact `payload-projected`; diagnostics and tests must never report a degraded control as applied exactly.

## 13. Certification contract

### 13.1 Local tests

The Anthropic module owns tests for:

- every consumer-declared request path and semantically relevant omission state;
- malformed unclaimed top-level fields and nested siblings remaining unread and non-terminal;
- Pi IR/options construction;
- complete candidate-only Supplement capture and absence of fields with no current target consumer;
- reasoning omitted/disabled/enabled-budget/adaptive combinations;
- concrete effort mapped once through Pi options and unsupported effort omitted with a warning;
- unsupported `stop_sequences` omitted without prompt injection or response truncation;
- unsupported server tools and `inference_geo` omitted with warnings while dispatch continues;
- message-level system first-text promotion and later-user degradation;
- fixed honest repair of unresolved ordinary Client ToolCalls, with invalid relationships still failing;
- exact-only cache attachment projection with no request-wide promotion;
- strongest-legal response block omission and JSON/SSE refusal parity;
- `thinking.display: "omitted"` and missing-signature `""` fallback;
- native, redacted, foreign, malformed, and incompatible continuity;
- each source-to-target projector;
- Provider response → Client response → next Provider request replay;
- every Pi-retained response field disposition and JSON/SSE rendering;
- no non-standard request-control echo in the Anthropic response;
- unknown targets with unconsumed candidate warnings, pre-Supplement main-call failures, and selected-projector payload-shape mismatch;
- dependency isolation from OpenAI Responses.

### 13.2 Final-wire tests

Support is proved only by tests beginning with Anthropic Client Wire and asserting the final Provider request after Pi and Anthropic-owned payload projection. Projector-only and intermediate Invocation snapshots are insufficient.

### 13.3 Online tests

Use three independent direct-protocol scripts with fixed targets:

| Script target | Fixed selector |
|---|---|
| CommandCode Private | `commandcode-private/deepseek/deepseek-v4-flash` |
| OpenCode GO | `opencode-go/deepseek-v4-flash` |
| CommandCode GOAT | `commandcode-goat/deepseek/deepseek-v4-flash` |

Each script owns its Anthropic request cases, request and response wire assertions, isolated fixed Provider Profile, report, and exit status. They do not invoke the OpenAI Responses online suite and do not use Request Journey diagnostics as an oracle.

Real-agent Anthropic certification uses only Claude Code/Claude CLI in separate product tests. Codex CLI does not speak the Anthropic Messages Client protocol and is not evidence for this lane.

## 14. Upgrade and locality gates

Every Pi AI upgrade reruns the complete Anthropic source-protocol/target-API final-wire matrix because Pi option mappings, payload shapes, and response signature placement are version-bound.

Architecture certification must prove:

- no Anthropic semantic import from OpenAI Responses;
- no OpenAI Responses semantic import from Anthropic;
- no Anthropic semantic import from a shared Semantic Conversion kernel, executor, outcome, reasoning, or supplement module;
- Anthropic Pi execution types and errors remain inside the Anthropic semantic module;
- Anthropic can be removed without editing another Client Protocol module;
- adding another Client Protocol does not modify Anthropic code.

## 15. Definition of done

The Anthropic Semantic Conversion contract is satisfied when:

1. the request audit defines positive consumers and exact source paths, every consumed fact has one owner, and unclaimed fields remain unread;
2. Anthropic owns its Invocation, supplement, reasoning, continuity, projectors, response policy, and tests;
3. Anthropic owns its Pi payload execution wrapper, `onPayload` lifecycle, outcomes, and semantic errors;
4. every enabled source-to-target mapping has a final-wire test;
5. every Pi-retained response fact has an audited attachment and Anthropic response disposition;
6. native-field continuity and `item-extension-v1` foreign continuity have explicit client capability results rather than a vacuous optional gate;
7. replay-required reasoning metadata survives every certified compatible complete-history round trip;
8. unsupported hard controls fail through request validation or the Pi/main-call contract before Supplement projection, candidate target unavailability warns without blocking dispatch, and policy-authorized fallbacks degrade honestly;
9. all three fixed-target independent Anthropic online Provider scripts pass;
10. OpenAI Responses and both Native lanes remain unchanged.
