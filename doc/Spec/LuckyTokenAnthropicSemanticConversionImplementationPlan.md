# Anthropic Messages Semantic Conversion Implementation Plan

Status: **PROPOSED — BIDIRECTIONAL FIELD AUDIT REQUIRED BEFORE TDD IMPLEMENTATION**
Date: **2026-08-23**
Scope: the Anthropic Messages Client Protocol after the request has committed to the Semantic Conversion lane. This plan does not change Local Native Preservation, Provider Native Preservation, or OpenAI Responses Semantic Conversion.

## 1. Authority and objective

Use these sources in precedence order:

1. [Repository instructions](../../AGENTS.md)
2. [Anthropic Messages Semantic Conversion Architecture Specification](./LuckyTokenAnthropicSemanticConversionArchitectureSpec.md)
3. [Semantic Conversion Architecture Specification](./LuckyTokenSemanticConversionArchitectureSpec.md)
4. the Anthropic Client request/response grammar pinned in this repository and `@anthropic-ai/sdk`
5. pinned Pi AI 0.84.2 runtime and Pi Agent mirror source

Create an Anthropic-owned vertical Semantic Conversion module:

```text
Anthropic Client Wire
→ existing Anthropic validation and Pi conversion
→ Anthropic Semantic Invocation
→ Anthropic reasoning + complete Anthropic supplement
→ Anthropic-owned target projector
→ mechanism-only Pi execution kernel
→ Pi Provider
→ final Provider Wire
→ target-aware Pi response interpretation
→ Anthropic-owned response conversion
```

The module may reuse the Pi execution kernel. It does not import OpenAI Responses Invocation, supplement, reasoning, continuity, target projectors, field mappings, expected-wire fixtures, or effective-state policy.

## 2. Confirmed current gaps

The current Anthropic semantic branch has useful conversion behavior but does not provide final-target projection:

- `AnthropicRequestConversion` returns `context + options + renderState + notices`, not an Anthropic-owned semantic Invocation.
- The handler calls the existing `ExecutionOperation` directly and therefore does not pass through the projection kernel.
- `tool_choice` and `stop_sequences` are shape-checked but not converted.
- `output_config.format`, `service_tier`, `container`, and `inference_geo` are not retained for final projection.
- `thinking.display`, explicit `null` versus omission in nullable controls, and the required `budget_tokens < max_tokens` relationship are not preserved completely.
- `top_p` and `top_k` are stored in Pi `samplingParams`, which pinned Pi documents as an OpenAI-compatible-only option; this cannot prove other target APIs receive them.
- tool `cache_control`, `allowed_callers`, `defer_loading`, `eager_input_streaming`, `input_examples`, and `type` are validated but omitted from the Pi tool representation.
- historical `thinking` and `redacted_thinking` blocks enter Pi IR, but converted assistant history receives synthetic Client provenance and no Anthropic-owned target replay decision.
- explicit `thinking.disabled` and `thinking.adaptive` currently collapse into no Pi reasoning option.
- the existing shared reasoning request contract cannot represent Anthropic adaptive thinking and exact `budget_tokens` without semantic distortion.
- final-assistant prefill is degraded into ordinary history, and an unresolved tool call may be repaired with invented model-visible result text.
- the converter accepts message-level `role: "system"`, which is not part of the pinned standard Anthropic message-role union, without declaring it as a LuckyToken extension.
- legal content families such as URL image, container upload, structured document/search-result content, citations/caller fields, and server-tool result data are rejected, narrowed, or converted to placeholder text.
- the response renderer hard-codes citations, caller, container, stop details/sequence, inference geography, service tier, and server-tool usage to generic values and recognizes only a subset of Anthropic stop/content forms.

These facts establish the need for the module. Slice 0 must complete the field-by-field and target-by-target audit before implementation decides any new mapping.

## 3. Target module structure

```text
src/protocols/anthropic/
  request.ts
  response.ts
  sse.ts
  semantic/
    invocation.ts
    execution.ts
    reasoning/
      contract.ts
      request.ts
      response.ts
      continuity.ts
      registry.ts
      projectors/
    supplement/
      contract.ts
      request.ts
      registry.ts
      projectors/
    response-interpretation/
      contract.ts
      registry.ts
      adapters/
```

Keep a file only when it hides meaningful behavior behind a small Interface. Merge shallow files into their owning module.

The only shared Semantic Conversion dependency is:

```text
src/semantic-conversion/kernel/
```

Mechanism-only utilities may be shared later only after both implementations prove identical mechanics. Do not move an OpenAI Responses helper into common code merely to call it from Anthropic.

## 4. Anthropic-owned Invocation

The exact types are finalized by the field audit, but ownership must remain equivalent to:

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

`convertValidatedAnthropicRequestWithPolicy()` remains the one conversion implementation. Deepen its result; do not add a second raw-body parser for supplement or reasoning fields.

Each recognized Anthropic request fact has one authoritative owner:

| Fact class | Owner |
|---|---|
| messages, system text, images, ordinary tools, tool calls/results | Pi `Context` |
| target-certified Pi options | `invocation.pi.options` |
| thinking activation, effort, budget, historical thinking, opaque continuity | Anthropic reasoning |
| other recognized facts requiring target validation/projection | Anthropic supplement |
| stream mode and standard Anthropic response envelope | Anthropic Client state |
| target-retained Pi response facts and their Anthropic mapping | Anthropic response interpretation |
| conversion/projection notices | Anthropic-owned bounded facts published through fail-open observation |
| credentials, Profile, transport, retry, cancellation, diagnostics | existing infrastructure |

## 5. Anthropic reasoning

Anthropic reasoning remains independent from OpenAI Responses reasoning.

### 5.1 Request-generation grammar

The audit must distinguish at least:

```text
thinking omitted
thinking.type = disabled
thinking.type = enabled + exact budget_tokens + display omitted|null|summarized|omitted
thinking.type = adaptive + display omitted|null|summarized|omitted
output_config.effort omitted
output_config.effort = null
output_config.effort = low | medium | high | xhigh | max
```

Do not encode `adaptive` as provider default, invent a budget, or treat omission as explicit disable. Preserve exact budget separately from any coarse Pi thinking level. Validate `budget_tokens >= 1024` and `budget_tokens < max_tokens`, and ensure neither Pi's budget preparation nor target projection raises the final total output ceiling above Client `max_tokens`.

For every target API, the Anthropic reasoning projector decides:

- whether Pi options express the source request exactly;
- whether `onPayload` must validate or repair the final Provider field;
- whether an approximate effort is an allowed preference degradation;
- whether explicit disable is proved in the final wire;
- whether an unsupported hard state fails before dispatch.

### 5.2 Historical thinking and opaque continuity

The module must preserve:

- visible `thinking` text;
- `thinking.signature` attached to the same thinking block;
- `redacted_thinking.data` and its redacted representation;
- any Provider response signature attached to text or a tool call when the Anthropic Client Wire has a validated extension carrier;
- actual source Provider/API/model provenance from the Pi `AssistantMessage`.

The Anthropic standard signature field may carry only values valid under the Anthropic wire contract. Foreign Provider metadata must not masquerade as an Anthropic-native signature.

Implement the item-local `luckytoken_continuity` v1 codec defined by the Anthropic architecture specification and certify:

1. the extension has an item-local attachment point for thinking, text, and tool calls;
2. the Anthropic response encoder retains it;
3. the request parser validates it as closed-world bounded data;
4. supported complete-history clients return it without copying opaque data into model-visible text;
5. malformed, duplicate, incompatible, or unknown-version attachments are ignored individually with warnings;
6. clients that do not return it preserve visible reasoning through an honest fallback.

Record every tested client as `native-fields-only` or `item-extension-v1`. The direct raw-protocol suite must pass `item-extension-v1`; Claude Code/Claude CLI receives its own capability result. Do not satisfy the continuity gate merely by leaving every foreign attachment form uncertified.

Do not add server-side continuity storage in this plan.

## 6. Complete Anthropic request and response audit

Slice 0 creates `doc/AnthropicMessagesPiProviderSemanticAudit.md` with independent request and response matrices. The request half must classify:

- `max_tokens`;
- `temperature`, `top_p`, `top_k`, and `stop_sequences`;
- all `tool_choice` variants and `disable_parallel_tool_use`;
- `output_config.format`;
- `metadata.user_id`;
- `service_tier`;
- `inference_geo`;
- `container`;
- top-level, system-block, content-block, and tool `cache_control` attachment semantics;
- tool `strict`, `allowed_callers`, `defer_loading`, `eager_input_streaming`, `input_examples`, and typed server-tool controls;
- thinking fields owned by the reasoning module;
- stream and response-only fields owned by Client rendering;
- final-assistant prefill/continuation and unresolved tool-call relationships;
- standard `user|assistant` message roles and the explicit accept/reject contract for any LuckyToken `system`-message extension;
- text citations/cache, URL images, container uploads, every document source/title/context/citations/cache form, and every search-result source/content/citations/cache form;
- tool references, tool-use/server-tool caller/cache, tool-result nested content, and every typed server-tool result family;
- every other recognized content type currently degraded, omitted, repaired, or rejected.

For each field, record:

```text
source validation
source requirement strength
current Pi IR/option behavior
Pi behavior for every target API
proven final Provider mapping
unsupported/fallback/failure rule
projection outcome and protocol-valid response/notice disposition
required final-wire test
```

The supplement captures all validated request facts whose final meaning is not already proved by Pi for every supported target in this module. It is an Anthropic type, not a universal request-control model.

The response half is indexed by actual Pi response API plus Provider/model compatibility and records:

```text
Provider response source fact
pinned Pi response-parser behavior
AssistantMessage field and attachment point, if retained
Anthropic JSON and SSE rendering
response-only versus next-request replay semantics
valid null/default, fallback, warning, or critical failure
Provider response → Pi → Anthropic response fixture
next-history final Provider request fixture when replay-required
```

It must explicitly cover citations, caller identity, server tools/results, container uploads, container, every stop reason/detail/sequence, complete usage details, and every reasoning signature location listed in the architecture specification. A hard-coded `null` is valid only when the Anthropic target contract defines it for the actual source fact; Pi parser loss is not evidence of semantic absence.

Target-bound facts such as a Provider container remain narrowly typed with source provenance and compatibility conditions. They do not become generic semantic fields merely to avoid a protocol-local type.

The converter records stable request-local associations from source message/content/tool identities to the Pi blocks it creates. It must not put marker text in Pi IR. A projector may restore a nested field only after resolving an unambiguous target payload attachment.

## 7. Anthropic-owned target projectors

Create an independent projector for every certified target family reached by the Anthropic Semantic Conversion lane:

```text
Anthropic Client → CommandCode Private
Anthropic Client → Anthropic Messages when not Provider-Native-claimed
Anthropic Client → OpenAI Completions
Anthropic Client → OpenAI Responses
Anthropic Client → Azure OpenAI Responses
Anthropic Client → OpenAI Codex Responses
Anthropic Client → Google Generative AI
Anthropic Client → Google Vertex
Anthropic Client → Mistral
Anthropic Client → Bedrock Claude families
Anthropic Client → Bedrock non-Claude families
Anthropic Client → Pi Messages
```

Models claimed by the Anthropic Provider Native lane bypass this module. That does not prove every `anthropic-messages` target is Native-eligible: unclaimed targets receive an independently audited semantic projector and response interpreter, or an explicit field-level unsupported/failure disposition. They are not rejected merely because another target with the same API ID used a Native lane.

Each projector owns:

- exact payload shape validation;
- Pi-native validation;
- source-to-target field mapping;
- hard/preference classification outcomes;
- compatibility predicates;
- repair warnings;
- unsupported and failure behavior.

Projectors do not reuse the OpenAI Responses target projector registry. Similar Provider fields may be implemented twice when the source semantics differ or independence is more valuable than line-count reduction.

Even when an implementation helper is shared within the Anthropic module, every Pi API row has separate registration, compatibility predicates, payload-shape fixtures, and final-wire certification.

## 8. Anthropic-owned response interpretation

Create a separate response-interpreter registry keyed by the actual final Pi `AssistantMessage.api` plus certified Provider/model compatibility. It consumes only Pi response IR, Anthropic render state, projection outcomes, and validated request-local continuity associations. It does not receive raw Provider streams, diagnostics payloads, or OpenAI Responses Client types.

For every target row, implement only dispositions established by the response half of the semantic audit:

1. render exact Pi-retained content, usage, stop, ID, and opaque attachment facts;
2. interpret target-specific Pi fields only under matching provenance;
3. use only Anthropic-defined null/default values;
4. preserve replay metadata through native fields or `luckytoken_continuity` v1;
5. warn on permitted response loss and fail when valid response structure, security, tool relationships, or required replay semantics cannot be constructed.

The response interpreter never uses `onPayload`. If Pi has discarded a Provider response field, the implementation records the audit disposition rather than adding a response interception layer or guessing the value.

Anthropic responses do not echo request control effectiveness. Successful request outcomes remain internal certification facts; omission/fallback/repair notices go only to the fail-open observation seam.

## 9. Anthropic semantic execution

The Anthropic semantic executor:

1. receives the resolved Pi Model after Native lane selection has completed;
2. invokes the existing Anthropic converter once;
3. selects its own reasoning and supplement projector for the resolved target;
4. creates one Anthropic-owned `PayloadProjectionOperation`;
5. composes reasoning first and non-overlapping supplement projection second;
6. passes only Pi input plus that operation to `executeWithPiKernel()`;
7. converts the returned Pi `AssistantMessage` and outcomes into an Anthropic response;
8. returns exact projection outcomes for observation and certification without adding request-control echo fields to the Anthropic response.

The request converter never creates `onPayload`. The kernel remains unaware that the request originated as Anthropic Messages.

## 10. TDD implementation slices

### Slice 0 — Bidirectional field audit and red end-to-end fixtures

1. Create the Anthropic request/response semantic audit.
2. Capture current Pi input and final Provider body for each target API using test transports.
3. Capture Provider response fixtures, the resulting Pi `AssistantMessage`, Anthropic JSON/SSE output, and next-history Provider request for every replay-required fact.
4. Add failing request tests for stop sequences, forced/named tool choice, serial-tool constraint, structured output, non-OpenAI top-p/top-k, display/explicit-null reasoning states, explicit reasoning disable/adaptive, output-ceiling/budget interaction, assistant prefill, and full-history provenance.
5. Add failing response tests for citations/caller, server tools/results, container, stop details/sequence/pause/refusal, complete usage, every opaque attachment location, and SSE deltas.
6. Add dependency assertions prohibiting imports from OpenAI Responses semantic modules.

Gate: every recognized Anthropic request and response fact has an explicit current behavior, intended owner, target disposition, and end-to-end test before implementation begins.

### Slice 1 — Anthropic Invocation and complete supplement

1. Deepen the existing conversion result into `AnthropicConversionResult`.
2. Capture the complete typed Anthropic supplement in the same validation pass.
3. Preserve current correct Pi messages, tools, options, render state, and notices. Do not preserve invented model-visible repairs: an unresolved tool relationship is retained exactly when validly representable and otherwise fails according to its critical relationship contract.
4. Keep empty-supplement Pi input equivalent to the current converter.

Gate: Client Wire → Anthropic Invocation tests cover every audited field without knowing a Provider payload shape.

### Slice 2 — Anthropic reasoning request semantics

1. Implement the independent activation/effort/budget contract.
2. Preserve omission, disabled, enabled-budget, and adaptive distinctly.
3. Preserve `thinking.display` and `output_config.effort` omission, explicit `null`, and concrete values distinctly.
4. Enforce exact budget/output-ceiling relationships without Pi widening the Client ceiling.
5. Extract historical thinking/redacted thinking and attachment identities.
6. Add target-specific preparation and final-payload validation one target at a time.

Gate: no Anthropic reasoning state is encoded through an OpenAI Responses reasoning type or guessed default.

### Slice 3 — Anthropic response continuity loop

1. Extract actual Provider/API/model provenance from Pi responses.
2. Render native Anthropic thinking/redacted fields where valid.
3. Implement and certify the bounded item-local `luckytoken_continuity` v1 codec.
4. Restore compatible attachments in the next complete-history Provider request.
5. Preserve visible reasoning and discard only incompatible opaque state on model switch.

Gate: native fields and direct-protocol `item-extension-v1` pass Provider response → Anthropic Client response → next Client request → final Provider request; Claude Code/Claude CLI receives an explicit carrier capability result.

### Slice 4 — Anthropic target projectors

Implement projectors independently in this order:

1. CommandCode Private;
2. Anthropic Messages semantic targets not claimed by Provider Native;
3. OpenAI Completions;
4. OpenAI Responses;
5. Azure OpenAI Responses;
6. OpenAI Codex Responses;
7. Google Generative AI;
8. Google Vertex;
9. Mistral;
10. Bedrock by certified model family;
11. Pi Messages.

For each target, begin with a failing Client Wire → final Provider Wire test. Unsupported facts retain explicit outcomes; no projector copies unknown supplement fields blindly.

Gate: every enabled mapping has a final-wire test and every unconsumed field has an explicit outcome.

### Slice 5 — Target-aware response interpreters

1. Implement the Anthropic-owned response registry from the audit one target API at a time.
2. Preserve all Pi-retained response content, signatures, stop facts, usage, IDs, and attachments in valid Anthropic JSON/SSE form.
3. Replace hard-coded null/default output only when the target-aware audit proves a stronger mapping; never fabricate an unavailable Provider fact.
4. Emit developer notices through the fail-open observation seam and keep them out of Anthropic Wire.
5. Fail critical response conversions rather than normalizing them into a false successful Anthropic result.

Gate: every target has Provider response → Pi → Anthropic JSON/SSE fixtures and all replay-required facts continue into the next final Provider request.

### Slice 6 — Kernel integration

1. Route only the Anthropic Semantic Conversion branch through the mechanism-only kernel.
2. Keep Provider Native handling unchanged and before semantic conversion.
3. Preserve request identity, Profile binding, retry, transport, streaming, response parsing, and diagnostics ownership.
4. Assert that neither the Anthropic converter nor target projector supplies `onPayload` directly to Pi.

Gate: basic requests with all optional projection features omitted produce equivalent Pi input, Provider payload, and Anthropic response.

### Slice 7 — Protocol-valid response and cleanup

1. Keep Anthropic response JSON/SSE within its standard schema plus the approved continuity extension; do not add request-control echo fields.
2. Publish omission/fallback/repair notices only through fail-open observation.
3. Remove tests and documentation that call ignored fields supported.
4. Delete superseded direct-execution semantic paths.
5. Keep Client response rendering valid when a preference is omitted or visible reasoning falls back.

Gate: no Anthropic response invents Responses-style effective state, and observation claims a control reached the Provider only for `pi-native` or `payload-projected` outcomes.

### Slice 8 — Independent online certification

Add exactly three independently runnable direct Anthropic protocol scripts:

```text
test/online/run-commandcode-private-anthropic.ts
  provider: commandcode-private
  selector: commandcode-private/deepseek/deepseek-v4-flash

test/online/run-opencode-go-anthropic.ts
  provider: opencode-go
  selector: opencode-go/deepseek-v4-flash

test/online/run-commandcode-goat-anthropic.ts
  provider: commandcode-goat
  selector: commandcode-goat/deepseek/deepseek-v4-flash
```

Each script fixes and validates its Provider/model/fresh isolated Profile tuple and owns its Anthropic request construction, expected semantics, request/response wire assertions, report, and exit status. They may share only mechanism-level server, capture, timeout, credential-isolation, and report-format utilities. They do not invoke a generic semantic-case runner, the Responses suite, or Request Journey diagnostics.

Each script must cover, when the target supports the meaning:

- JSON and SSE success;
- final output-token ceiling;
- temperature, top-p, top-k, and stop sequences;
- automatic, required/any, named, none, and serial tool use;
- structured JSON output;
- reasoning disabled, enabled budget, adaptive/effort behavior;
- full-history visible reasoning and opaque continuity replay;
- unsupported hard control failing before upstream dispatch;
- captured final Provider body assertions.

Each script also asserts the returned Anthropic JSON/SSE and at least one complete-history replay case supported by that target. A successful HTTP status or plausible model text is not sufficient.

CommandCode GOAT retains its exact model compatibility restrictions. Real-agent testing uses only Claude Code/Claude CLI through a separate entry point, report, and exit status; Codex CLI is excluded because it cannot issue Anthropic Messages Client requests.

## 11. Required test commands

Use guarded commands:

```text
npm run test:unit
npm run test:integration
npm run test:certification
npm run lint
npm run typecheck
npm test
```

Online scripts use the repository's temporary `CODEX_HOME` guard and independent Provider credentials. No packaging step is required.

## 12. Fixed constraints

- Do not modify Pi AI or `node_modules`.
- Do not import OpenAI Responses semantic contracts or projectors.
- Do not create a global Client Protocol Invocation, supplement, reasoning union, or projector registry.
- Do not pass raw Anthropic Wire into a target projector.
- Do not add a compatibility shim or dual execution path.
- Do not use diagnostics to determine test correctness.
- Do not use request `onPayload`, a custom transport, or consumed-stream rereading to recover Provider response facts.
- Do not enter Local Native or Provider Native after Semantic lane commitment.
- Do not add server-owned continuity storage.
- Do not claim `previous_response_id`; it is not an Anthropic Client capability.

## 13. Definition of done

Anthropic Semantic Conversion is complete when:

1. it owns an independent Invocation, complete supplement, reasoning/continuity module, target projector registry, response conversion, and tests;
2. it shares only the mechanism-level Pi execution kernel and proven leaf utilities;
3. every audited field has one owner and an explicit final outcome;
4. every supported mapping is proved from Anthropic Client Wire to final Provider Wire;
5. every target response fact has a Provider response → Pi → Anthropic JSON/SSE disposition and fixture;
6. native and `item-extension-v1` full-history reasoning continuity is restored with correct provenance and attachment for every certified client capability;
7. unsupported hard controls fail before dispatch, critical response conversion fails rather than fabricating success, and optional losses warn honestly;
8. the three fixed-target independent online Provider scripts pass, and Claude Code/Claude CLI has a separate real-agent result;
9. OpenAI Responses and both Native lanes remain behaviorally unchanged.
