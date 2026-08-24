# LuckyToken Anthropic Messages Semantic Conversion Architecture Specification

Status: **PROPOSED PROTOCOL CONTRACT — IMPLEMENTATION AND CERTIFICATION IN PROGRESS**
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

The cross-protocol locality rules remain authoritative in [LuckyToken Semantic Conversion Architecture Specification](./LuckyTokenSemanticConversionArchitectureSpec.md). This document defines everything specific to Anthropic Messages, including its Pi payload-callback execution lifecycle.

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

After Semantic Conversion commitment, failure does not fall through to Provider Native or Local Native.

This specification does not broaden Anthropic Provider Native eligibility. A request claimed by Provider Native bypasses this module. A resolved `anthropic-messages` target not claimed by Provider Native remains a Semantic Conversion target: request supplements need an audited Anthropic-source projector when used, while its response is rendered from Pi `AssistantMessage` by the Anthropic response module. Native eligibility cannot be assumed to cover it.

## 3. Correctness endpoint

The final Provider request is authoritative.

An Anthropic request field is supported only when one of these is proved for the resolved target:

1. Pi IR/options emit an equivalent Provider control and the Anthropic projector validates it;
2. the Anthropic projector writes a certified equivalent through the Anthropic-owned `onPayload` seam;
3. a documented fallback preserves the strongest valid model-visible meaning and emits a warning.

A hard Anthropic control that has no valid mapping fails before Provider dispatch. A preference may be omitted only with an explicit outcome and a developer warning through fail-open observation. This specification fixes each bounded non-security availability fallback; there is no end-user strict-mode override. Every fallback is reported as degraded rather than exact. Source-field presence alone never proves effectiveness.

## 4. Anthropic module seam

The module presents one deep external Interface to the Anthropic handler:

```ts
interface AnthropicSemanticRequestFacts {
  readonly receivedAt: number;
  readonly effectiveSessionId?: string;
  readonly signal?: AbortSignal;
}

interface AnthropicSemanticExecutionCapabilities {
  readonly executeOperation: ExecutionOperation;
  readonly factsSink?: ExecutionFactsSink;
}

executeAnthropicSemanticConversion(input: {
  readonly body: unknown;
  readonly model: Model<string>;
  readonly models: Models;
  readonly requestFacts: AnthropicSemanticRequestFacts;
  readonly execution: AnthropicSemanticExecutionCapabilities;
}): Promise<PreparedAnthropicResponse>;
```

The exact HTTP packaging, lane selection, Profile binding, retry, and cancellation composition remain outside this Interface. Request facts and execution capabilities are closed, narrow types; they must not become broad configuration bags. Availability disposition is a fixed Anthropic protocol contract, not request state or user configuration, and therefore does not enter the Interface, Pi IR, reasoning, or the supplement. Callers do not assemble reasoning projectors, supplements, target registries, or Pi callbacks.

Internally the module may use request conversion, reasoning, supplement, projection, response, and streaming seams. Those are Anthropic implementation details and are not extension points for other Client Protocols.

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

The existing Anthropic converter remains the sole parser. It validates each source fact once and produces all Pi, reasoning, supplement, render-state, and notice outputs in that conversion pass.

## 6. Information ownership

Every recognized request fact has one authoritative owner:

| Fact | Owner |
|---|---|
| ordered messages, system text, images, ordinary tool definitions, tool calls/results | Pi `Context` |
| target-certified Pi common options, including `temperature` and concrete `output_config.effort` | Pi options |
| thinking activation, exact budget, historical thinking, continuity | Anthropic reasoning module |
| validated source controls retained for target-dependent projection or final-wire certification | Anthropic supplement; Pi options remain authoritative where they already own the semantic |
| stream choice, `thinking.display`, and standard Anthropic response envelope | Anthropic response state |
| Pi `AssistantMessage` facts and Anthropic response mapping | Anthropic response module |
| conversion, fallback, omission, and repair notices | Anthropic-owned bounded facts published through fail-open observation |
| model resolution | runtime/composition before semantic execution |
| credentials, Profile binding, transport, retries, cancellation | existing infrastructure |
| Request Journey and telemetry | fail-open diagnostics owner |

Pi IR is conversation/history IR, not a storage carrier for source request controls. The Anthropic supplement is typed protocol state, not a raw request bag.

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
    }
  | {
      readonly kind: "adaptive";
    };

type AnthropicEffortIntent =
  | { readonly kind: "omitted" }
  | { readonly kind: "explicit-null" }
  | {
      readonly kind: "specified";
      readonly level: "low" | "medium" | "high" | "xhigh" | "max";
    };
```

The exact relationship between `thinking`, `output_config.effort`, and `max_tokens` must follow the pinned Anthropic grammar and target audit. An enabled budget is at least 1,024 and strictly less than the Client `max_tokens`; neither Pi preparation nor Provider projection may widen the Client's total output-token ceiling. A concrete `output_config.effort` is mapped to the audited Pi reasoning option and remains Pi-owned through Provider request construction. Pi's certified `thinkingLevelMap` or Provider compatibility mapping is an equivalent mapping rather than a LuckyToken precision loss; when the resolved target supports no equivalent effort control, omit only that preference and warn. `onPayload` must not independently remap an effort already owned by Pi options.

`thinking.display` is a Client-response rendering instruction, not a Provider-generation control. The request converter validates it and stores its omission/null/value state in `AnthropicResponseRenderState`; it is not projected into the Provider request on the Semantic Conversion lane. Before target resolution and outside an explicitly selected availability fallback, do not:

- collapse omitted and disabled;
- encode adaptive as Provider default while claiming an exact mapping;
- replace an exact budget with a guessed effort while claiming an exact mapping;
- collapse display omission, explicit `null`, `summarized`, and `omitted` before Anthropic response rendering;
- enable thinking merely because a similarly named target field exists;
- claim disabled unless the final Provider request proves it; target-default fallback reports `degraded` instead.

### 7.2 Historical reasoning

The module preserves visible historical thinking as Pi `ThinkingContent` when valid, while separately retaining the source facts needed for replay decisions:

- message/content attachment;
- whether the source block was `thinking` or `redacted_thinking`;
- native signature or redacted data;
- actual originating Provider/API/model when produced by LuckyToken;
- whether the value is opaque and target-bound.

Synthetic Client history provenance is not sufficient for exact replay. The target reasoning projector restores opaque state only when validated source provenance is compatible with the resolved target contract.

### 7.3 Client-wire continuity

Anthropic-native values use their standard wire positions only when they satisfy the Anthropic field contract:

- `thinking.signature` for a compatible Anthropic thinking signature;
- `redacted_thinking.data` for a compatible redacted Anthropic payload.

Foreign Provider signatures do not masquerade as those fields. The approved foreign-continuity carrier is an item-local `luckytoken_continuity` extension on the Anthropic content block that owns the state:

```ts
interface LuckyTokenAnthropicContinuityEnvelopeV1 {
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
- `item-extension-v1`: the client returns `luckytoken_continuity` unchanged in complete history, enabling certified foreign opaque replay.

Direct-protocol tests must certify `item-extension-v1`. Claude Code/Claude CLI tests separately determine whether that real client preserves the extension; absence is reported as a declared capability limit, not counted as a successful foreign-continuity round trip.

No server-side continuity store is part of this contract.

## 8. Anthropic Projection Supplement

`AnthropicProjectionSupplement` is a preservation carrier: after the existing converter has produced the strongest correct Pi `Context` and Pi options, it retains the validated source facts needed for target-dependent projection or final-wire certification. For contract stability it may also retain a validated source value already represented in Pi options, but that copy is not a second owner and does not authorize a duplicate Provider write. It is not a raw second request model or a promise that every target can project every retained fact. Anthropic reasoning/continuity remains its separately typed special case; concrete effort remains Pi-owned.

The field audit must classify at least:

- the Anthropic total-output ceiling retained separately only because Pi thinking preparation may reinterpret its ordinary `maxTokens` option;
- top-p, top-k, and stop sequences whose Pi support is target-dependent or absent;
- every tool-choice form and parallel-tool constraint;
- structured output format, including omitted versus explicit `null`;
- end-user metadata;
- service tier and inference geography;
- container reuse;
- cache controls and their exact attachment points;
- tool strictness, loading/caller/streaming controls, examples, and typed server tools;
- final-assistant prefill/continuation semantics;
- official `user|assistant` message-role grammar and any separately declared LuckyToken `system`-message extension;
- text citations/cache, URL images, container uploads, and document `base64`/`url`/`content` sources with title/context/citations/cache;
- search-result source/content/citations/cache, tool references, tool-use/server-tool caller/cache, tool-result nested content, and every typed server-tool result family;
- every other known content block or relationship degraded, omitted, repaired, or rejected by current Pi conversion.

For every field, the supplement contract records only the validated value and the minimum source attachment/requirement facts needed by Anthropic projectors or final-wire certification. It does not contain:

- the raw Anthropic request;
- raw unvalidated nested records merely for future use;
- Provider payload objects;
- credentials or transport state;
- another Client Protocol's normalized field name.

“Complete supplement” therefore means complete preservation before target selection, not complete target support. Adding a retained Anthropic field changes the supplement capture and its default unconsumed disposition; it does not require changes to every existing target Adapter.

The pinned Pi option remains the sole final writer for `temperature`, even when the Supplement retains the validated Client value alongside other sampling controls. The projector may observe the final field only for bounded certification; it must not restore a temperature that Pi intentionally omitted for a target incompatibility such as Anthropic extended thinking. The separately retained output-token fact is named `outputTokenCeiling` because it is not a second ordinary Pi `maxTokens` value: it preserves Anthropic's hard total-output ceiling after Pi may have added or clamped a thinking budget.

Omission, explicit `null`, explicit disable, and an empty value remain distinct whenever the Anthropic grammar distinguishes them. Block- and tool-local facts carry stable request-local semantic identities such as source message/content indexes, tool name, or call ID. The converter records their association to the Pi block/tool it created without inserting marker text into Pi IR. A target projector mutates a nested Provider field only when that association resolves unambiguously in the audited payload; otherwise it warns or fails according to requirement strength.

The official Anthropic request role grammar is not silently widened. If LuckyToken retains message-level `role: "system"` as a product extension, the audit names it as such, defines its privilege and degradation contract, and tests it separately from standard Anthropic Messages. Otherwise it is rejected during validation.

Target-bound state such as container identity remains explicitly Anthropic-owned with provenance and compatibility conditions. A field becomes a shared mechanism only when it has no Client semantic meaning.

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

This list is not a requirement to implement every target before the module is usable. A target without a projector still uses Pi normally; present supplement facts receive their explicit unconsumed warning/failure dispositions.

Every projector is an Anthropic-source/target-API Adapter with one small Interface: it receives the Pi-built payload, resolved target facts, the complete immutable Anthropic supplement, and prepared Anthropic reasoning; it returns a copied payload plus the facts it consumed and their outcomes. Its implementation owns only:

- exact Pi payload shape validation;
- validation of Pi-native fields relevant to the mappings it actually uses;
- certified repair or added-field projection for those mappings;
- the minimum compatibility conditions for those mappings;
- consumed-field outcomes.

A projector is positive-only. It implements only facts it can express with a proven target representation; it does not add branches whose sole result is “unsupported,” “ignored,” or “omitted.”

The Anthropic execution module, not each Adapter, applies the common disposition to Supplement facts left unconsumed: optional facts are omitted with warnings, policy-degradable facts use only their named fallback, and critical facts fail. An Adapter must not add switch branches for fields it cannot project and does not claim support merely by accepting the full Supplement input.

It may duplicate logic that exists in an OpenAI Responses projector. It does not import that projector or its source semantic types.

One implementation may cover more than one target API only when the mappings it implements use identical pinned payload contracts. Certification is per enabled mapping, not per theoretical target/field cross-product.

### 9.1 Pi-first rule

When a Pi option is audited for the resolved target, use it first. `onPayload` may validate its final Provider representation but must not become a second writer for that semantic. A certified Pi compatibility mapping, including a mapped reasoning-effort value, is accepted as `pi-native`. A contradictory value may be repaired only when the exact target field/value is certified; every repair emits a developer warning. If the exact repair is unknown, do not guess.

### 9.2 One writer

Anthropic reasoning and ordinary supplement projection compose inside one Anthropic projection operation. Each final Provider field has one owner. A detected overlap fails before payload mutation.

### 9.3 Unknown target

An unknown API receives no guessed mutation. A request that needs no Anthropic supplement projection may still use Pi's ordinary Provider Adapter. For each remaining supplement fact, omit an optional fact with a warning and fail only when omission would break a critical semantic such as a server-tool capability, security/permission control, output ceiling, or tool relationship.

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

Reasoning disable is already exact when the resolved model does not support reasoning and the final payload contains no reasoning-enabling control. If the model supports reasoning but the target has no certified disable field, LuckyToken removes known reasoning-enabling controls, accepts the target default, records a degradation, and warns. Exact-budget or adaptive activation uses the nearest certified target reasoning mode; a non-reasoning target uses ordinary generation. If a context-safe final token ceiling no longer leaves room above an enabled budget, reasoning is disabled for that request and warned rather than widening the Client ceiling or rejecting an otherwise usable request. None of these fallbacks remaps Pi-owned `output_config.effort`. The Anthropic response renderer independently enforces `thinking.display: "omitted"`.

When exact final-assistant continuation is unsupported, the existing assistant prefix remains ordinary visible assistant history and conversion warns that prefix-continuation behavior is not guaranteed.

All fallbacks must still construct a valid target payload. None relaxes source validation, output-token ceilings, inference geography, safety, caller permissions, tool-call/result relationships, or payload-shape validation. A server tool is never downgraded to an ordinary client tool or removed as an availability fallback: if the resolved target cannot provide the requested server-executed capability, conversion fails before dispatch.

CommandCode GOAT direct wire-probe evidence for `deepseek/deepseek-v4-flash` is version-bound evidence for this fallback, not a completed online certification or a general OpenAI Completions capability. Its required/named forced choices are rejected in thinking mode, while an automatic request with only the named tool exposed succeeded in the recorded probe set. The source-code evidence comment beside the GOAT compatibility rule must remain until a replacement online certification updates both code and this specification.

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
- enforces failed outcomes;
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

The response never exposes Provider credentials, headers, transport state, or raw payload fragments. Standard native Anthropic continuity and the approved `luckytoken_continuity` extension are the only opaque replay outputs.

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

- **Client request parsing**: LuckyToken is reading the Anthropic request; nothing has been sent upstream.
- **Provider request projection**: Pi built a candidate Provider payload; `onPayload` is validating or completing it before dispatch.
- **Client response rendering**: the Provider already responded and LuckyToken is constructing Anthropic JSON/SSE.
- **Next-request replay**: the current response is returned as complete history in a later Client request.

### 12.1 Fixed usability decisions

The following decisions are normative for Anthropic Messages Semantic Conversion. They may be changed only by an explicit architecture decision that updates this section, the implementation plan, the semantic audit, and the corresponding final-wire/response tests together:

1. A concrete `output_config.effort` is written once to Pi options. Pi's audited Provider Adapter and model compatibility mapping own the final effort representation. LuckyToken does not duplicate that mapping in `onPayload`; a target with no equivalent effort control omits the preference and warns.
2. `onPayload` selectively consumes only validated Supplement fields with a proven target mapping, and may perform bounded validation of audited Pi-native output. A Supplement copy of a Pi-owned value does not authorize a duplicate write. A known exact contradiction may be repaired with a developer warning; an unknown repair is never guessed.
3. Unsupported `stop_sequences` are omitted with a warning. LuckyToken does not inject stop instructions into model-visible content, truncate JSON/SSE output, or expose a strict-mode override for this loss.
4. An unsupported Anthropic server tool fails before dispatch. It is not downgraded to a client tool and is not removed based on `tool_choice` reachability.
5. Lack of a certified LuckyToken projector does not disable an otherwise valid Pi-only request. Optional supplement facts are omitted with warnings; unprojected critical facts fail.
6. A selected projector receiving a payload shape different from its audited contract fails before dispatch as an internal Pi/projector compatibility fault. This is not an end-user availability setting.
7. Response conversion consumes Pi `AssistantMessage` and Anthropic render state only. It does not inspect raw Provider responses and does not require a mirror per-Provider response registry; provenance-specific rules are internal to the Anthropic response module and exist only for Pi-retained fields.
8. If ordinary Pi thinking has no non-empty signature, Anthropic response rendering emits `signature: ""`, warns, and treats that empty value as absent on the next request. This is a lossy placeholder, not exact replay, and never applies to `redacted_thinking.data`.
9. `thinking.display: "omitted"` is a Client request field governing the Anthropic server response. The renderer emits empty visible thinking and preserves the Pi signature; it is not a Provider-generation projector or a Client-UI-only concern.
10. The existing Anthropic conversion is authoritative and runs first. The Supplement may remain a stable, relatively complete validated carrier, while Pi IR/options remain authoritative for facts they already own. Projectors consume only their proven subset and never treat Supplement presence alone as permission to rewrite Provider fields.
11. Supplement completeness means complete pre-target preservation, not universal target support. A target Adapter projects only its proven subset, and adding a supplement field does not require editing every Adapter.
12. The wrapper receives Pi input, prepared reasoning, and the complete immutable supplement together. It selects an Adapter from resolved target facts, applies only supported mappings, and centrally resolves every unconsumed fact to its documented warning, fallback, or failure. Targets with no proven mappings use the Pi-only path without a no-op Adapter.

The trade-off and rationale are recorded in [`ADR-0005`](../adr/0005-anthropic-semantic-conversion-usability-policy.md).

### 12.2 Complete disposition table

The dispositions below are fixed protocol behavior; no strict-mode alternative exists:

| Stage | Condition | Disposition | Rationale |
|---|---|---|---|
| Client request parsing | malformed source grammar, invalid ranges, duplicate IDs, or broken tool-call/result relationships | fail | there is no valid source meaning to project |
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
| Provider request projection | inference geography, safety, security, or caller/tool permissions | fail | policy boundaries cannot be weakened by conversion availability |
| Provider request projection | reachable model-visible content, document/media bytes, or server-tool semantics with no valid target representation | fail | dropping input changes what the model can know or do; server-executed tools are never reclassified as ordinary tools |
| Provider request projection | optional request citation/cache annotation, redundant custom-tool type, or nullable metadata cannot be projected | retain visible content, omit only the auxiliary fact, and warn | failure would reduce availability without protecting a critical semantic |
| Client response rendering | unknown Pi response content | existing `error|ignore` policy | the Client explicitly chooses whether an unknown response block may be dropped |
| Client response rendering | unavailable citation, usage, container, tier, or other optional response auxiliary field | retain visible response, use a legal nullable/omitted form, and warn | auxiliary parser loss should not replace a usable response |
| Client response rendering | known Provider stop/refusal fact retained but optional detail discarded by Pi | render the strongest protocol-valid stop/refusal representation and warn | do not turn a usable response into an internal error solely for unavailable optional detail |
| Next-request replay | malformed, incompatible, or target-mismatched opaque continuity | discard only opaque state, preserve visible reasoning/text/tool identity, and warn | opaque target state must not destroy portable visible history |
| Client response rendering / Next-request replay | `pause_turn` continuation, server-tool relationship, or replay-required state cannot be reconstructed | fail | ordinary success would be false and may break the next turn |
| Provider request projection | unknown API or unaudited model family with only optional supplement facts | leave Pi's payload unchanged, omit those facts, and warn | none | lack of a LuckyToken projector does not make Pi's ordinary Provider Adapter unusable |
| Provider request projection | unknown API or unaudited model family with an unprojected critical fact | fail before dispatch | none | critical semantics cannot be silently lost or guessed |
| Provider request projection | selected projector receives a final payload shape different from its audited contract | fail before dispatch | none | this is an internal Pi/projector compatibility fault and mutation would be unsafe |

Malformed source state fails during Anthropic validation. Unsupported preferences and policy-authorized fallbacks produce explicit outcomes and developer warnings. `degraded` is distinct from `omitted`, `pi-native`, and exact `payload-projected`; diagnostics and tests must never report a degraded control as applied exactly.

## 13. Certification contract

### 13.1 Local tests

The Anthropic module owns tests for:

- every recognized request field and omission state;
- Pi IR/options construction;
- complete supplement capture;
- reasoning omitted/disabled/enabled-budget/adaptive combinations;
- concrete effort mapped once through Pi options and unsupported effort omitted with a warning;
- unsupported `stop_sequences` omitted without prompt injection or response truncation;
- unsupported server tools failing before dispatch;
- `thinking.display: "omitted"` and missing-signature `""` fallback;
- native, redacted, foreign, malformed, and incompatible continuity;
- each source-to-target projector;
- Provider response → Client response → next Provider request replay;
- every Pi-retained response field disposition and JSON/SSE rendering;
- no non-standard request-control echo in the Anthropic response;
- unknown targets with optional versus critical supplement facts, and selected-projector payload-shape mismatch;
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

1. the field audit is complete and every recognized source fact has one owner;
2. Anthropic owns its Invocation, supplement, reasoning, continuity, projectors, response policy, and tests;
3. Anthropic owns its Pi payload execution wrapper, `onPayload` lifecycle, outcomes, and semantic errors;
4. every enabled source-to-target mapping has a final-wire test;
5. every Pi-retained response fact has an audited attachment and Anthropic response disposition;
6. native-field continuity and `item-extension-v1` foreign continuity have explicit client capability results rather than a vacuous optional gate;
7. replay-required reasoning metadata survives every certified compatible complete-history round trip;
8. unsupported hard controls fail before dispatch, policy-authorized availability fallbacks degrade honestly, and preferences warn honestly;
9. all three fixed-target independent Anthropic online Provider scripts pass;
10. OpenAI Responses and both Native lanes remain unchanged.
