# LuckyToken OpenAI Responses Semantic Conversion Architecture Specification

Status: **PROPOSED PROTOCOL CONTRACT — IMPLEMENTED BASELINE, LOCALITY MIGRATION REQUIRED**
Date: **2026-08-23**
Scope: OpenAI Responses as the Client Protocol on the Semantic Conversion lane. This specification does not govern Responses Native Preservation, Anthropic Messages Semantic Conversion, or any other Client Protocol.

This document is the authoritative protocol contract for:

```text
OpenAI Responses Client Wire
→ Responses-owned Semantic Invocation
→ Responses-owned reasoning and target projection
→ LuckyToken Pi execution kernel
→ Pi Provider
→ Provider Wire
→ Pi AssistantMessage
→ OpenAI Responses Client Wire
```

The shared kernel and locality rules remain authoritative in [LuckyToken Semantic Conversion Architecture Specification](./LuckyTokenSemanticConversionArchitectureSpec.md). Request field evidence remains authoritative in [OpenAI Responses → Pi Provider Request Field Audit](../OpenAIResponsesPiProviderRequestFieldAudit.md). The decoupling plan requires a separate per-target response-capability audit before the locality migration is accepted.

## 1. Decision

OpenAI Responses is a cohesive Client Protocol Semantic Module. It owns:

- Responses request validation, reference/session expansion, and conversion;
- a Responses-only Semantic Invocation;
- a Responses-only projection supplement;
- Responses reasoning generation and history semantics;
- the item-local Responses continuity codec;
- a Responses-owned target projector registry;
- Responses-owned target-aware Pi response interpretation;
- Responses response/SSE conversion and effective-state echo;
- Responses unit, integration, certification, and online tests.

It does not export these semantic contracts as extension points for Anthropic or future Client Protocols.

## 2. Lane scope

Local Responses Native and Provider Responses Native claims are evaluated before this module. A request committed to either Native lane bypasses the Responses Semantic Invocation and Pi execution kernel.

After Semantic Conversion commitment, failure does not fall through to a Native lane.

`previous_response_id` expansion is Responses Client state owned before request conversion. Complete-history Provider semantic certification never substitutes it for explicit prior output items.

## 3. Correctness endpoint

The final Provider request is authoritative. A Responses control is effective only when:

1. Pi emitted an equivalent target control and the Responses projector validated it; or
2. the Responses projector emitted a certified equivalent through the kernel-owned `onPayload` seam.

An unsupported hard control fails before Provider dispatch. An unsupported preference produces an explicit omitted outcome and warning. Responses response echo uses final outcomes rather than source-field presence.

## 4. Responses module seam

The module presents one deep external Interface to the Responses handler:

```ts
interface ResponsesSemanticRequestFacts {
  readonly receivedAt: number;
  readonly effectiveSessionId?: string;
  readonly signal?: AbortSignal;
}

interface ResponsesSemanticExecutionCapabilities {
  readonly executeOperation: ExecutionOperation;
  readonly factsSink?: ExecutionFactsSink;
}

executeOpenAIResponsesSemanticConversion(input: {
  readonly body: unknown;
  readonly model: Model<string>;
  readonly models: Models;
  readonly requestFacts: ResponsesSemanticRequestFacts;
  readonly execution: ResponsesSemanticExecutionCapabilities;
}): Promise<PreparedResponsesResponse>;
```

Lane selection, reference/session expansion, Profile binding, retry composition, and HTTP response commitment remain outside this Interface. `requestFacts` and `execution` are closed narrow types; they cannot carry the raw `Request`, headers, credentials, broad configuration, Provider payloads, or Client render state. Callers do not assemble supplement projectors, reasoning adapters, Provider payloads, or Pi callbacks.

## 5. Responses Semantic Invocation

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

These types remain inside the Responses module and are not members of a global Client Invocation union.

`convertResponsesRequest()` is the sole raw-body semantic parser after optional Responses session expansion. It owns validation, Pi messages/tools, reasoning and supplement extraction, render state, notices, and item/reference relationships.

## 6. Information ownership

| Fact | Owner |
|---|---|
| input messages/items, images, tool calls/results, portable thinking blocks | Pi `Context` |
| target-certified Pi common options | Pi options |
| reasoning effort/summary intent, historical summaries, reasoning-item continuity | Responses reasoning module |
| recognized request facts not proved through Pi for all supported targets | Responses supplement |
| response IDs, metadata echo, stream/render state, tool echo, Client notices | Responses response state |
| `previous_response_id` expansion and storage policy | Responses session state |
| credentials, Profile binding, transport, retries, cancellation | existing infrastructure |

Pi IR is not a carrier for Responses request controls that it cannot express.

## 7. Responses reasoning contract

### 7.1 Request intent

Responses reasoning preserves these states distinctly:

```ts
type ResponsesReasoningEffort =
  | { readonly kind: "provider-default" }
  | { readonly kind: "disabled" }
  | {
      readonly kind: "enabled";
      readonly level: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    };

type ResponsesReasoningSummary =
  | { readonly kind: "provider-default" }
  | {
      readonly kind: "requested";
      readonly value: "auto" | "concise" | "detailed";
    };
```

Omission and explicit `effort: "none"` never collapse. Summary preference is independent from effort.

### 7.2 Historical reasoning

Visible `summary_text` is model-visible historical reasoning. A complete Responses reasoning item additionally carries item identity, status, optional reasoning content, and encrypted content required for exact Responses-family replay.

The module never fabricates a reasoning item ID or encrypted content from summary text. When the target cannot accept historical reasoning, preserve non-empty visible summary through certified unsigned reasoning or assistant-content fallback.

### 7.3 Target policies

The Responses reasoning registry owns explicit policies for all pinned Pi text APIs:

1. `anthropic-messages`;
2. `openai-completions`;
3. `openai-responses`;
4. `azure-openai-responses`;
5. `openai-codex-responses`;
6. `google-generative-ai`;
7. `google-vertex`;
8. `mistral-conversations`;
9. `bedrock-converse-stream`;
10. `pi-messages`;
11. LuckyToken's registered `commandcode-private` API.

Each policy chooses native replay, payload projection, content fallback, omission, or failure from the actual source provenance and resolved target compatibility.

## 8. Responses continuity codec

The item-level extension field is `luckytoken_continuity`.

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
        readonly value: string;
        readonly representation?: "redacted";
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

Rules:

- attach continuity to the output item that owns the reasoning, text part, or tool call;
- keep Responses-native `encrypted_content` in its standard field;
- do not duplicate visible text, summary, tool name, or arguments in the envelope;
- omit deterministically reconstructable field selectors;
- validate keys closed-world and apply the existing overall request/response byte bounds;
- ignore malformed, duplicate, misplaced, incompatible, or unknown-version attachments individually with warnings;
- restore opaque state only under compatible source Provider/API/model provenance;
- retain visible reasoning when opaque replay is unavailable;
- do not add server-side continuity storage.

## 9. Responses Projection Supplement

`ResponsesProjectionSupplement` is complete for the recognized Responses request grammar and remains Responses-owned.

Its audited field families include:

- `text.format` and verbosity;
- response `include` and top logprobs controls;
- `parallel_tool_calls`;
- complete `tool_choice`, including required, named, hosted, and allowed sets;
- output token ceiling, temperature, and top-p;
- prompt cache key and retention;
- safety identifier and deprecated Responses `user`;
- service tier and truncation;
- background/store behavior;
- context management and stream options;
- remaining response-contract controls identified by the field audit.

These source names and values are not generalized into an all-protocol supplement. A future Client Protocol defines its own types even when a target Provider field looks similar.

Every supplement fact records its Responses requirement strength. Required/named tool choice, structured output, explicit reasoning disable, truncation guarantees, and the Client output-token ceiling are hard where the Responses contract requires them. Preferences may degrade only with warnings.

## 10. Responses target projectors

The registry is private to Responses and selects by resolved `model.api` plus certified Provider/model compatibility facts.

Each source-to-target projector owns:

- exact Pi-built payload shape validation;
- validation of Pi-native mappings;
- certified repair/addition;
- field ownership and conflict detection;
- compatibility restrictions;
- explicit outcomes and warning text.

The projector matrix includes CommandCode Private and the ten pinned Pi text API families. A mapping implemented for Responses is not automatically reusable by Anthropic.

### 10.1 Pi-first validation

Audited Pi options remain the first writer. The projector validates the final field and records `pi-native` when correct. It repairs only a known field/value and emits `pi-native-mapping-repaired`. Unknown payload shapes fail rather than accepting a silent drop.

### 10.2 Output-token ceiling

The Client control is a response-output ceiling, not an input-request byte or token limit. The final Provider ceiling may be lower for context safety but must never exceed the Client hard limit. A Provider minimum that would exceed it fails.

### 10.3 One writer

Responses reasoning and supplement projection compose inside one Responses projection operation. Each final Provider field has one owner. Overlap fails before mutation.

## 11. Pi execution kernel use

The Responses semantic executor creates one Responses-owned projection operation after model resolution and passes only:

```text
Pi Context/options
+ Responses-owned PayloadProjectionOperation
→ executeWithPiKernel()
```

The kernel never receives `ResponsesSemanticInvocation`, `ResponsesProjectionSupplement`, raw Responses Wire, continuity envelopes, or the Responses target registry.

## 12. Responses response contract

Responses response JSON/SSE rendering remains protocol-owned. The Responses reasoning response extractor plus renderer form a target-aware response interpreter selected from the actual Pi `AssistantMessage.api/provider/model`; Anthropic Messages and future Client Protocols do not consume it.

It must:

- preserve valid Pi content and tool relationships;
- render reasoning summaries and complete native Responses reasoning items correctly;
- emit item-local continuity from actual Pi response provenance;
- retain Client model/metadata/session behavior;
- report only `pi-native` or `payload-projected` controls as effective;
- avoid echoing unsupported source controls as though applied;
- keep diagnostics fail-open and outside response authority.

The interpreter audits every supported Pi response API for text/thinking/tool attachment fields, response IDs, raw stop reasons, usage, and opaque continuity. In particular, it preserves Anthropic/Bedrock thinking signatures and redacted state, Google/Vertex signatures at their original thinking/text/tool-call positions, complete Responses-family reasoning item state, OpenAI Completions reasoning details where Pi retains them, Pi Messages carriers, and visible-only Mistral/CommandCode reasoning. A Provider response fact discarded by Pi cannot be recovered with request `onPayload`; it receives an explicit fallback/omission/failure disposition rather than a guessed value.

## 13. Failure contract

- malformed Client Wire fails during Responses validation;
- invalid continuity attachments warn and preserve visible content unless critical structure is broken;
- unsupported hard controls fail before Provider dispatch;
- unsupported preferences produce omitted outcomes and warnings;
- incompatible target payload shapes fail rather than guessing;
- model switches discard incompatible opaque state while preserving portable visible meaning;
- Native-lane failure never falls through to this module after commitment.

## 14. Certification contract

### 14.1 Local tests

Responses owns independent tests for:

- complete Client Wire → Responses Invocation capture;
- every reasoning effort/summary omission combination;
- continuity codec shape, bounds, duplicates, and attachment positions;
- same-model replay and model-switch fallback;
- every source-to-target projector mapping and unsupported outcome;
- effective-state response rendering;
- final Provider body after Pi and kernel projection;
- dependency isolation from Anthropic and the kernel.

### 14.2 Round trip

Provider response → Responses Client response → next complete-history Client request → final Provider request must restore compatible replay fields, attachment points, relationships, and provenance. Independent one-way adapter tests are insufficient.

### 14.3 Online tests

CommandCode Private, CommandCode GOAT, and OpenCode GO use separate direct Responses scripts with independent reports and final-wire assertions. Real Codex CLI tests remain separate. Generic online scripts do not claim `previous_response_id` behavior.

## 15. Locality and upgrade gates

Every Pi AI upgrade reruns the complete Responses source-protocol/target-API request-wire matrix and the Provider-response → Pi → Responses capability matrix.

Architecture certification proves:

- no Responses semantic import from Anthropic;
- no Anthropic semantic import from Responses;
- no Responses type or registry in the Pi execution kernel;
- Responses can be removed without editing another Client Protocol module;
- adding a Client Protocol does not modify Responses code.

## 16. Definition of done

The Responses protocol contract is satisfied when:

1. Responses owns its Invocation, supplement, reasoning, continuity, projectors, response policy, and tests;
2. the Pi execution kernel remains mechanism-only;
3. current final-wire and round-trip behavior survives the locality migration;
4. every enabled mapping has a final-wire test and every unconsumed fact has an explicit outcome;
5. every target response API has Pi attachment and Client rendering/replay coverage;
6. all three direct Responses online Provider scripts pass;
7. Anthropic and both Native lanes remain unchanged.
