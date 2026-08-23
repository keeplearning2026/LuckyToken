# LuckyToken Anthropic Messages Semantic Conversion Architecture Specification

Status: **PROPOSED PROTOCOL CONTRACT — REQUEST/RESPONSE FIELD AUDIT PENDING**
Date: **2026-08-23**
Scope: Anthropic Messages as the Client Protocol on the Semantic Conversion lane. This specification does not govern Anthropic Provider Native Preservation, OpenAI Responses Semantic Conversion, or any other Client Protocol.

This document is the authoritative architecture contract for:

```text
Anthropic Client Wire
→ Anthropic-owned Semantic Invocation
→ Anthropic-owned reasoning and target projection
→ LuckyToken Pi execution kernel
→ Pi Provider
→ Provider Wire
→ Pi AssistantMessage
→ Anthropic Client Wire
```

The shared kernel contract and cross-protocol locality rules remain authoritative in [LuckyToken Semantic Conversion Architecture Specification](./LuckyTokenSemanticConversionArchitectureSpec.md). This document defines everything specific to Anthropic Messages.

## 1. Decision

Anthropic Messages is a cohesive Client Protocol Semantic Module. It owns:

- Anthropic request validation and conversion;
- an Anthropic-only Semantic Invocation;
- an Anthropic-only projection supplement;
- Anthropic reasoning generation and history semantics;
- Anthropic continuity parsing and rendering;
- an Anthropic-owned request projector registry;
- Anthropic-owned target-aware Pi response interpretation;
- Anthropic response/SSE conversion and projection-notice policy;
- Anthropic unit, integration, certification, and online tests.

It does not import or reuse OpenAI Responses semantic types, supplement builders, reasoning policies, target projectors, continuity codecs, fixtures, or expected-wire assertions.

The module may reuse only the mechanism-level Pi execution kernel and leaf utilities that remain unaware of both Client Protocols and their policies.

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

This specification does not broaden Anthropic Provider Native eligibility. A request claimed by Provider Native bypasses this module. A resolved `anthropic-messages` target not claimed by Provider Native remains a Semantic Conversion target and must have its own audited Anthropic-source projector and response interpreter; Native eligibility cannot be assumed to cover it.

## 3. Correctness endpoint

The final Provider request is authoritative.

An Anthropic request field is supported only when one of these is proved for the resolved target:

1. Pi IR/options emit an equivalent Provider control and the Anthropic projector validates it;
2. the Anthropic projector writes a certified equivalent through the kernel-owned `onPayload` seam;
3. a documented fallback preserves the strongest valid model-visible meaning and emits a warning.

A hard Anthropic control that has no valid mapping fails before Provider dispatch. A preference may be omitted only with an explicit outcome and a developer warning through fail-open observation. Source-field presence alone never proves effectiveness.

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

The exact HTTP packaging, lane selection, Profile binding, retry, and cancellation composition remain outside this Interface. The request facts and execution capabilities are closed, narrow types; they must not become broad configuration bags. Callers do not assemble reasoning projectors, supplements, target registries, or Pi callbacks.

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
| target-certified Pi common options | Pi options |
| thinking activation, effort, exact budget, historical thinking, continuity | Anthropic reasoning module |
| recognized fields not proved through Pi for all supported targets | Anthropic supplement |
| stream choice and standard Anthropic response envelope | Anthropic response state |
| target-retained Pi response facts and Anthropic response mapping | Anthropic response interpreter |
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

The exact relationship between `thinking`, `thinking.display`, `output_config.effort`, and `max_tokens` must follow the pinned Anthropic grammar and target audit. An enabled budget is at least 1,024 and strictly less than the Client `max_tokens`; neither Pi preparation nor Provider projection may widen the Client's total output-token ceiling. Do not:

- collapse omitted and disabled;
- encode adaptive as Provider default;
- replace an exact budget with a guessed effort;
- collapse display omission, explicit `null`, `summarized`, and `omitted` before target resolution;
- enable thinking merely because a similarly named target field exists;
- claim disabled unless the final Provider request proves it.

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

`AnthropicProjectionSupplement` is complete for the recognized Anthropic request grammar. It is not generalized for another Client Protocol.

The field audit must classify at least:

- output token limit;
- temperature, top-p, top-k, and stop sequences;
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

For every field, the supplement contract records only the validated value and the minimum source attachment/requirement facts needed by Anthropic projectors. It does not contain:

- the raw Anthropic request;
- raw unvalidated nested records merely for future use;
- Provider payload objects;
- credentials or transport state;
- another Client Protocol's normalized field name.

Omission, explicit `null`, explicit disable, and an empty value remain distinct whenever the Anthropic grammar distinguishes them. Block- and tool-local facts carry stable request-local semantic identities such as source message/content indexes, tool name, or call ID. The converter records their association to the Pi block/tool it created without inserting marker text into Pi IR. A target projector mutates a nested Provider field only when that association resolves unambiguously in the audited payload; otherwise it warns or fails according to requirement strength.

The official Anthropic request role grammar is not silently widened. If LuckyToken retains message-level `role: "system"` as a product extension, the audit names it as such, defines its privilege and degradation contract, and tests it separately from standard Anthropic Messages. Otherwise it is rejected during validation.

Target-bound state such as container identity remains explicitly Anthropic-owned with provenance and compatibility conditions. A field becomes a shared mechanism only when it has no Client semantic meaning.

## 9. Anthropic target projectors

The registry is private to the Anthropic Semantic Module and selects by resolved `model.api` plus certified Provider/model compatibility facts.

Initial target families are:

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

Every projector is an Anthropic-source/target-API Adapter. It owns:

- exact Pi payload shape validation;
- validation of Pi-native fields;
- certified repair or added-field projection;
- reasoning and supplement field ownership;
- compatibility conditions;
- hard/preference decisions;
- explicit outcomes.

It may duplicate logic that exists in an OpenAI Responses projector. It does not import that projector or its source semantic types.

One implementation may cover more than one target API only when their exact pinned payload contracts are identical. Registration, compatibility decisions, and final-wire certification remain separate for every API row.

### 9.1 Pi-first rule

When a Pi option is audited for the resolved target, use it first. `onPayload` still validates the final Provider request. A mismatch may be repaired only when the exact target field/value is certified; every repair emits a developer warning.

### 9.2 One writer

Anthropic reasoning and ordinary supplement projection compose inside one Anthropic projection operation. Each final Provider field has one owner. A detected overlap fails before payload mutation.

### 9.3 Unknown target

An unknown API or unaudited payload shape receives no guessed mutation. The Anthropic module resolves every remaining source fact to an omitted or failed outcome before dispatch.

## 10. Pi execution kernel use

The Anthropic semantic executor creates one prepared projection operation after target resolution and passes only this to the shared kernel:

```text
Pi Context/options
+ Anthropic-owned PayloadProjectionOperation
→ executeWithPiKernel()
```

The kernel:

- owns `onPayload`;
- invokes the operation exactly once;
- enforces failed outcomes;
- calls the existing `ExecutionOperation`;
- returns the Pi `AssistantMessage` and outcomes.

The kernel never receives `AnthropicSemanticInvocation`, `AnthropicProjectionSupplement`, raw Anthropic Wire, or an Anthropic target registry.

## 11. Anthropic response contract

The existing response converter remains authoritative for standard Anthropic JSON/SSE validity. It is deepened behind an Anthropic-owned response-interpreter registry selected from the actual Pi `AssistantMessage.api/provider/model` and certified compatibility facts. This registry is independent from the request projector registry and imports no OpenAI Responses Client code.

The response field audit covers, for every target API:

- response ID/model/role and content ordering;
- text, citations, thinking, redacted thinking, and all signature attachment positions;
- client tool use, caller identity, server-tool use/results, tool search, and container-upload blocks;
- `container`;
- `stop_reason`, `stop_sequence`, `pause_turn`, `refusal`, and `stop_details`;
- usage input/output/cache breakdown, thinking tokens, server-tool use, inference geography, and service tier;
- JSON and SSE start/delta/stop forms, including citations, signatures, structured tool input, and terminal deltas;
- whether each fact is response-only or required in the next full-history request.

For each fact, the interpreter chooses exactly one disposition:

1. exact Pi-native rendering;
2. certified target-aware interpretation from a Pi field such as `rawStopReason`, content signatures, or usage details;
3. a null/default explicitly defined by the Anthropic response contract;
4. visible fallback or omission with a bounded developer notice when the protocol permits loss;
5. conversion failure when a valid Anthropic response, security fact, tool relationship, output constraint, or required replay state cannot be constructed.

`onPayload` cannot recover response fields. A Provider fact that the pinned Pi response parser discarded is marked unavailable in the response audit; it is never guessed, read from diagnostics, recovered by injecting a transport, or silently represented by hard-coded `null` when that would claim a false semantic.

Anthropic Messages has no standard response fields that echo request `tool_choice`, sampling, reasoning activation, or other controls. Projection outcomes govern execution, developer notices, and certification only; the renderer must not invent Responses-style effective-state echo fields.

The response never exposes Provider credentials, headers, transport state, or raw payload fragments. Standard native Anthropic continuity and the approved `luckytoken_continuity` extension are the only opaque replay outputs.

### 11.1 Initial Provider-response attachment evidence

The audit begins from these pinned Pi facts and must verify them with fixtures before support is enabled:

| Pi response API | Retained reasoning/continuity starting point |
|---|---|
| `anthropic-messages` | thinking signature and redacted data on Pi thinking blocks |
| `bedrock-converse-stream` | Claude-family reasoning signature on Pi thinking; model-family rules remain separate |
| `google-generative-ai` | thought signatures may attach to thinking, text, or tool call |
| `google-vertex` | same attachment categories as Google shared conversion, independently certified |
| `openai-responses` | complete reasoning item state on thinking and message identity/phase on text |
| `azure-openai-responses` | Responses shared representation with an independent Azure parser/wire fixture |
| `openai-codex-responses` | Responses shared representation with Codex-specific defaults and independent fixture |
| `openai-completions` | visible reasoning plus Provider-specific reasoning state that may attach to thinking or tool calls |
| `mistral-conversations` | visible structured thinking; no opaque signature assumed |
| `pi-messages` | delegated Pi text/thinking/tool-call continuity fields |
| CommandCode Private | visible thinking; no opaque signature assumed until its Provider contract proves one |

This table is evidence routing, not certification. Exact support comes only from Provider response → Pi `AssistantMessage` → Anthropic JSON/SSE → next complete-history request tests.

## 12. Failure policy

The field audit assigns requirement strength. At minimum:

- explicit `any`, named, and `none` tool choice plus serial-tool guarantees are hard;
- structured output contracts are hard;
- the Client response-output token ceiling is hard;
- stop sequences and final-assistant prefill are hard output constraints;
- explicit reasoning disable is hard;
- explicit `thinking.display: "omitted"` is hard because exposing hidden reasoning is not an acceptable degradation;
- tool-call/result relationships are hard;
- a security or data-residency constraint such as explicit inference geography is hard unless its source contract proves otherwise;
- sampling, effort, cache, and service preferences may be omitted only when the source contract permits degradation.

Malformed source state fails during Anthropic validation. Unsupported hard semantics and incompatible target payload shapes fail before Provider dispatch. Unsupported preferences produce outcomes and warnings. On the response path, refusal details, `pause_turn` continuation, and tool/server-tool relationships are critical whenever the source Provider emitted them; the renderer must fail rather than normalize them into a false ordinary success when Pi retained evidence that cannot be represented safely.

## 13. Certification contract

### 13.1 Local tests

The Anthropic module owns tests for:

- every recognized request field and omission state;
- Pi IR/options construction;
- complete supplement capture;
- reasoning omitted/disabled/enabled-budget/adaptive combinations;
- native, redacted, foreign, malformed, and incompatible continuity;
- each source-to-target projector;
- Provider response → Client response → next Provider request replay;
- every target response field disposition and JSON/SSE rendering;
- no non-standard request-control echo in the Anthropic response;
- unknown targets and payload-shape mismatch;
- dependency isolation from OpenAI Responses.

### 13.2 Final-wire tests

Support is proved only by tests beginning with Anthropic Client Wire and asserting the final Provider request after Pi and kernel projection. Projector-only and intermediate Invocation snapshots are insufficient.

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
- no Anthropic type or registry in the Pi execution kernel;
- Anthropic can be removed without editing another Client Protocol module;
- adding another Client Protocol does not modify Anthropic code.

## 15. Definition of done

The Anthropic Semantic Conversion contract is satisfied when:

1. the field audit is complete and every recognized source fact has one owner;
2. Anthropic owns its Invocation, supplement, reasoning, continuity, projectors, response policy, and tests;
3. the shared kernel remains mechanism-only;
4. every enabled source-to-target mapping has a final-wire test;
5. every target response fact has an audited Pi attachment and Anthropic response disposition;
6. native-field continuity and `item-extension-v1` foreign continuity have explicit client capability results rather than a vacuous optional gate;
7. replay-required reasoning metadata survives every certified compatible complete-history round trip;
8. unsupported hard controls fail before dispatch and preferences warn honestly;
9. all three fixed-target independent Anthropic online Provider scripts pass;
10. OpenAI Responses and both Native lanes remain unchanged.
