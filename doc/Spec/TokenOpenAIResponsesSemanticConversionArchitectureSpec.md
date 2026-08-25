# Token OpenAI Responses Semantic Conversion Architecture Specification

Status: **LOCAL IMPLEMENTATION COMPLETE — ONLINE CERTIFICATION PENDING**
Date: **2026-08-24**
Scope: OpenAI Responses as the Client Protocol on the Semantic Conversion lane. This specification does not govern Responses Native Preservation, Anthropic Messages Semantic Conversion, or any other Client Protocol.

This document is the authoritative protocol contract for:

```text
OpenAI Responses Client Wire
→ Responses-owned Semantic Invocation
→ Responses-owned reasoning, target projection, and semantic execution
→ Pi Provider
→ Provider Wire
→ Pi AssistantMessage
→ OpenAI Responses Client Wire
```

The locality rules remain authoritative in [Token Semantic Conversion Architecture Specification](./TokenSemanticConversionArchitectureSpec.md). Request field evidence remains authoritative in [OpenAI Responses → Pi Provider Request Field Audit](../OpenAIResponsesPiProviderRequestFieldAudit.md). The protocol-local migration and demand-driven request extraction are implemented locally and accepted by offline architecture and final-wire certification. Separate per-target online Provider certification remains required before a release-level support claim.

## 1. Decision

OpenAI Responses is a cohesive Client Protocol Semantic Module. It owns:

- Responses request validation, reference/session expansion, and conversion;
- a Responses-only Semantic Invocation;
- a Responses-only projection supplement;
- Responses reasoning generation and history semantics;
- the item-local Responses continuity codec;
- a Responses-owned target projector registry;
- Responses-owned semantic execution, projection outcomes, and semantic errors;
- Responses-owned target-aware Pi response interpretation;
- Responses response/SSE conversion and effective-state echo;
- Responses unit, integration, certification, and online tests.

It does not export these semantic contracts as extension points for Anthropic or future Client Protocols.

## 2. Lane scope

Local Responses Native and Provider Responses Native claims are evaluated before this module. A request committed to either Native lane bypasses the complete Responses Semantic Module, including its semantic executor.

After Semantic Conversion commitment, failure does not fall through to a Native lane.

`previous_response_id` expansion is Responses Client state owned before request conversion. Complete-history Provider semantic certification never substitutes it for explicit prior output items.

## 3. Correctness endpoint

The final Provider request is authoritative. A Responses control is effective only when:

1. Pi emitted an equivalent target control and the Responses projector validated it; or
2. the Responses projector emitted a certified equivalent through the Responses-executor-owned `onPayload` seam.

The Responses supplement projector is availability-first: if a candidate fact has no certified target mapping, it leaves the Provider payload unchanged, records `omitted`, emits a warning, and does not prevent dispatch merely because of that candidate. A named bounded fallback records `degraded`. Any request guarantee that must prevent dispatch is validated or enforced before the supplement seam. Responses response echo uses final outcomes rather than source-field presence.

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

`convertResponsesRequest()` is the sole raw-body conversion operation after optional Responses session expansion. It performs one demand-driven extraction, then constructs Pi messages/tools, reasoning and supplement facts, render state, notices, and item/reference relationships. Downstream parsers receive only a consumer-selected request view and never reinterpret the complete raw body.

### 5.1 Demand-driven request extraction

Responses request conversion does not validate the complete OpenAI Responses schema. It extracts only fields required by one of two Responses-owned consumers.

The main request consumer constructs the selector, session/render facts, Pi Context/options, tools, and reasoning semantics from this allowlist:

```text
model
input
instructions
stream
metadata
previous_response_id
store
reasoning
tools
tool_choice
max_output_tokens
temperature
top_p
prompt_cache_retention
safety_identifier
user
```

The Supplement consumer constructs `ResponsesProjectionSupplement` from this allowlist:

```text
text
include
parallel_tool_calls
tool_choice
max_output_tokens
temperature
top_p
prompt_cache_key
prompt_cache_retention
safety_identifier
user
service_tier
truncation
```

The allowlists deliberately overlap for `tool_choice`, `max_output_tokens`, `temperature`, `top_p`, `prompt_cache_retention`, `safety_identifier`, and `user`. The main consumer gives Pi the strongest available representation; the Supplement preserves the same fact only to verify or repair the final Provider request under a certified target mapping.

The conversion operation selects own properties for each consumer before invoking either parser. A key present in neither allowlist is not read, parsed, shape-validated, projected, guessed, or used as a dispatch condition. This includes `stream_options`, `top_logprobs`, `context_management`, `background`, `conversation`, `prompt`, and future Client extensions while they have no consumer. Such a key is omitted with a bounded request-local warning derived from the request keys minus the union of both allowlists; this derived observation is not a third semantic list.

Each exact top-level omission uses `action:"ignore"` and code `openai-responses_unconsumed_request_field_ignored`. The converter reports at most the first 15 present keys in deterministic request-key order; when more exist, one final `openai-responses_additional_unconsumed_request_fields_ignored` notice makes 16 the absolute maximum. Identifier keys use `$.field`; other keys use safely quoted bracket JSONPath. The converter does not traverse an unconsumed value, and unclaimed siblings inside a consumed object do not receive separate notices.

For a claimed object, its consumer validates only the paths it reads. Unclaimed sibling keys are ignored. A consumed discriminator or required child remains validated: an unknown value that prevents construction of a claimed semantic is not guessed. A missing or malformed minimum request fact, malformed consumed value, security or permission constraint, invalid tool-call/result relationship, or invalid final payload remains an explicit error.

Native Preservation eligibility and lane commitment precede this operation. A request committed to a Native lane bypasses demand-driven extraction and preserves the authoritative raw body.

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
11. Token's registered `commandcode-private` API.

Each policy chooses native replay, payload projection, content fallback, omission, or failure from the actual source provenance and resolved target compatibility.

## 8. Responses continuity codec

The item-level extension field is `token_continuity`.

```ts
interface TokenContinuityEnvelopeV1 {
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

`ResponsesProjectionSupplement` is complete for the currently projection-eligible Responses request facts and remains Responses-owned. Projection eligibility means that at least one certified target Adapter can apply the fact or that the final Provider payload must be checked or repaired for that fact.

Its audited field families include:

- `text.format` and verbosity;
- response `include`;
- `parallel_tool_calls`;
- complete `tool_choice`, including required, named, hosted, and allowed sets;
- output token ceiling, temperature, and top-p;
- prompt cache key and retention;
- safety identifier and deprecated Responses `user`;
- service tier and truncation.

These source names and values are not generalized into an all-protocol supplement. A future Client Protocol defines its own types even when a target Provider field looks similar.

Facts without a current certified Supplement consumer do not enter the Supplement merely to be discarded later. A field claimed by the main request consumer remains with that consumer. A field claimed by neither allowlist remains unread and receives only the bounded omission warning defined by Section 5.1. The Supplement carries no `hard`/`preference` requirement label because target unavailability is never a terminal decision at this seam.

### 9.1 Complete useful candidate facts, selective projection

Each validated fact in `ResponsesProjectionSupplement` is a **Projection Candidate Fact**. The Supplement is the complete immutable carrier of projection-eligible Responses request facts that Pi options and Pi AI IR do not prove for every supported target. It is not a list of mandatory payload patches, and presence in the Supplement does not claim that Pi failed to apply the fact or that the resolved target supports it.

Completeness is established before target selection over that projection-eligible set. The selected Responses target Adapter reads only facts for which it owns a positive strategy:

1. If the final Pi-built Provider payload already expresses a certified semantic equivalent, leave the payload unchanged and record `pi-native`.
2. If Pi has no authoritative representation for the fact and the resolved target has a certified mapping, project that mapping exactly once and record `payload-projected`.
3. If an audited Pi-native mapping is missing or wrong, repair it only when the exact target field, replacement value, and compatibility condition are certified; record `payload-projected` with `pi-native-mapping-repaired`.
4. If the resolved target has no certified mapping, the Adapter does not consume the fact and does not add a target-specific unsupported branch. The Responses projection coordinator centrally records `omitted` with a warning. A named bounded `degraded` fallback remains Adapter-owned only when it actually constructs or verifies that fallback. Supplement unavailability alone never produces `failed` and never prevents Provider dispatch.

Adding a projection-eligible candidate does not require every target Adapter to add a mapping. Every candidate not explicitly consumed by the selected Adapter is resolved centrally under the same Responses-owned availability disposition. No raw pass-through, guessed target field, global `ignoreErrors`, or best-effort mutation is permitted.

### 9.2 Candidate-only non-failure boundary

The following rules are normative for every `ResponsesProjectionSupplement` projector:

1. The supplement supplies candidate facts to apply where a certified equivalent is available; it does not impose an independent request-success condition.
2. When the resolved Provider cannot express a candidate through a certified mapping, the Adapter leaves it unconsumed and the projection coordinator returns `omitted` with a warning. It never returns `failed`, throws, or creates a Client error merely because the candidate is unavailable.
3. A projector throws only when its own internal contract is broken: the Pi payload does not match the exact audited shape, two semantic owners claim the same final field, or the proposed mutation would construct an invalid final Provider payload.
4. Any Client request condition that genuinely must be rejected is validated before supplement construction or represented in the authoritative Pi/main-call contract. It must not be smuggled into a supplement candidate and later rejected by a target projector.

`ResponsesProjectionRecord.outcome` therefore excludes `failed` by type. Reasoning preparation and other non-Supplement contracts may still have their own terminal outcomes; they do not weaken this boundary.

One relevant availability disposition is fixed at this seam:

- `max_output_tokens`: when the target has a certified output-ceiling field, the projector accepts a Pi value at or below the Client ceiling and repairs a missing or excessive value to the Client ceiling with `pi-native-mapping-repaired`. When no certified field exists, it records `omitted` with a warning and dispatches. Semantic Conversion does not locally truncate model output because doing so can corrupt tool arguments, structured output, and streaming relationships.

## 10. Responses target projectors

The registry is private to Responses and selects by resolved `model.api` plus certified Provider/model compatibility facts.

Each source-to-target projector owns:

- exact Pi-built payload shape validation;
- validation of Pi-native mappings;
- certified repair/addition;
- field ownership and conflict detection;
- compatibility restrictions;
- positive projection outcomes; the coordinator owns generic unconsumed-candidate warnings.

The projector matrix includes CommandCode Private and the ten pinned Pi text API families. A mapping implemented for Responses is not automatically reusable by Anthropic.

### 10.1 Pi-first validation

Audited Pi options remain the first writer. The projector validates the final field and records `pi-native` when correct; it must not rewrite an already-equivalent value merely because the same fact is present in the supplement. It repairs only a known field/value and emits `pi-native-mapping-repaired`. Unknown payload shapes fail rather than accepting a silent drop.

Equivalence is fact-specific. Exact values require semantic equality; output-token ceilings accept a final value at or below the Client limit; tool controls include the final tool catalog and call relationships; structured output and reasoning use their target-owned certified shapes and provenance rules. A generic JSON comparison is not a substitute for those contracts.

### 10.2 Output-token ceiling

The Client control is a response-output ceiling, not an input-request byte or token limit. The projector records `pi-native` only when the final Provider ceiling is at or below the Client value. It may project a certified target ceiling, but it never widens one. If the target/Pi path cannot represent the candidate equivalently, this supplement seam records `omitted` and warns; any product contract that must reject such a request must enforce that guarantee before projection.

### 10.3 One writer

Responses reasoning and supplement projection compose inside one Responses projection operation. Each final Provider field has one owner. Overlap fails before mutation.

## 11. Responses-owned semantic execution

After model resolution, the Responses semantic executor creates one Responses-owned projection operation, exclusively owns Pi's `onPayload`, enforces terminal reasoning or main-call-contract outcomes, and invokes the existing narrow Pi execution capability supplied through `ResponsesSemanticExecutionCapabilities`. It does not reinterpret an omitted Supplement candidate as a terminal outcome.

```text
Responses Semantic Invocation
+ resolved Model
+ ResponsesSemanticExecutionCapabilities
→ Responses-owned execution/onPayload
→ Pi Provider
```

The semantic executor, its projection-operation Interface, projection outcome union, and typed projection rejection remain inside `src/protocols/openai-responses/semantic/`. They are not imported from Anthropic or a shared Semantic Conversion kernel. The supplied Pi execution capability remains mechanism-only and receives no raw Responses Wire, target registry, continuity envelope, or semantic classification policy.

During locality migration, copy the current spec-conforming shared implementation into the Responses module, then update only Responses imports and composition. Do not change a shared implementation while another protocol still depends on it. After all protocol cutovers prove zero production references, delete the obsolete shared semantic files and directory.

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

- malformed consumed Client facts and missing minimum request facts fail during Responses validation;
- request keys claimed by neither demand-driven consumer remain unread, produce a bounded warning, and never prevent Provider dispatch by themselves;
- invalid continuity attachments warn and preserve visible content unless critical structure is broken;
- every unconsumed Responses Supplement candidate returns a centrally generated `omitted` outcome and warning without payload mutation;
- Supplement unavailability alone never returns `failed`, throws a projector exception, or prevents Provider dispatch;
- an unsupported `max_output_tokens` ceiling warns and dispatches, while every certified ceiling field is preserved at or repaired below the Client value;
- target semantic unavailability is represented by an outcome, not by throwing a projector exception;
- projector exceptions are reserved for violated internal contracts such as an incompatible audited payload shape, duplicate control ownership, or an invalid final payload construction;
- the Responses semantic executor may use a Responses-owned typed rejection for terminal failures produced outside candidate unavailability, but must preserve projection rejection as distinct from Provider failure and execution-invariant failure;
- the Responses protocol edge renders a projection rejection as an explicit Client protocol error before response commitment; it does not expose a generic Provider failure or internal-server classification;
- incompatible target payload shapes fail rather than guessing;
- model switches discard incompatible opaque state while preserving portable visible meaning;
- Native-lane failure never falls through to this module after commitment.

## 14. Certification contract

### 14.1 Local tests

Responses owns independent tests for:

- complete Client Wire → Responses Invocation capture;
- demand-driven main/Supplement extraction, overlap, unclaimed top-level keys, unclaimed nested sibling keys, and bounded warnings;
- the real Codex `stream_options.reasoning_summary_delivery` request dispatches without projecting `stream_options`;
- every reasoning effort/summary omission combination;
- continuity codec shape, bounds, duplicates, and attachment positions;
- same-model replay and model-switch fallback;
- every source-to-target projector mapping and centralized unconsumed-candidate outcome;
- effective-state response rendering;
- final Provider body after Pi and Responses-owned projection;
- dependency isolation from Anthropic and any shared Semantic Conversion implementation.

### 14.2 Round trip

Provider response → Responses Client response → next complete-history Client request → final Provider request must restore compatible replay fields, attachment points, relationships, and provenance. Independent one-way adapter tests are insufficient.

### 14.3 Online tests

CommandCode Private, CommandCode GOAT, and OpenCode GO use separate direct Responses scripts with independent reports and final-wire assertions. Real Codex CLI tests remain separate. Generic online scripts do not claim `previous_response_id` behavior.

## 15. Locality and upgrade gates

Every Pi AI upgrade reruns the complete Responses source-protocol/target-API request-wire matrix and the Provider-response → Pi → Responses capability matrix.

Architecture certification proves:

- no Responses semantic import from Anthropic;
- no Anthropic semantic import from Responses;
- no Responses import from a shared Semantic Conversion executor, outcome union, semantic error class, Invocation, supplement, reasoning policy, or projector registry;
- Responses can be removed without editing another Client Protocol module;
- adding a Client Protocol does not modify Responses code.

## 16. Definition of done

The Responses protocol contract is satisfied when:

1. Responses owns its demand-driven request extraction, Invocation, supplement, reasoning, continuity, projectors, response policy, and tests;
2. Responses owns its semantic executor, `onPayload`, projection outcomes, and semantic errors;
3. current final-wire and round-trip behavior survives the locality migration;
4. every enabled mapping has a final-wire test and every unconsumed fact has an explicit outcome;
5. every target response API has Pi attachment and Client rendering/replay coverage;
6. all three direct Responses online Provider scripts pass;
7. no obsolete shared Semantic Conversion directory remains, while Anthropic and both Native lanes remain behaviorally unchanged.
