# Anthropic Messages Semantic Conversion Implementation Plan

Status: **IMPLEMENTED — ANTHROPIC-SCOPED LOCAL AND ONLINE GATES PASS**
Date: **2026-08-24**
Scope: the Anthropic Messages Client Protocol after the request has committed to the Semantic Conversion lane. This plan does not change Direct Mode, Provider Native Preservation, or OpenAI Responses Semantic Conversion.

## 1. Authority and objective

Use these sources in precedence order:

1. [Repository instructions](../../AGENTS.md)
2. [Anthropic Messages Semantic Conversion Architecture Specification](./TokenAnthropicSemanticConversionArchitectureSpec.md)
3. [Semantic Conversion Architecture Specification](./TokenSemanticConversionArchitectureSpec.md)
4. the Anthropic Client request/response grammar pinned in this repository and `@anthropic-ai/sdk`
5. pinned Pi AI 0.84.2 runtime and Pi Agent mirror source

Create an Anthropic-owned vertical Semantic Conversion module:

```text
Anthropic Client Wire
→ one demand-driven Anthropic extraction/conversion operation
→ Anthropic Semantic Invocation { Pi input + reasoning + candidate supplement }
→ Anthropic-owned Pi payload execution wrapper
→ Pi Provider builds candidate payload
→ wrapper-owned onPayload selects one target Adapter
→ Adapter projects only its proven supplement/reasoning subset
→ final Provider Wire
→ Pi AssistantMessage
→ Anthropic-owned response conversion
```

The module owns its Pi payload-callback lifecycle and does not import a shared Semantic Conversion kernel. It also does not import OpenAI Responses Invocation, supplement, reasoning, continuity, target projectors, field mappings, expected-wire fixtures, effective-state policy, outcome types, or semantic errors.

### 1.1 Normative policy source

Section 12.1, **Fixed usability decisions**, of `TokenAnthropicSemanticConversionArchitectureSpec.md` is authoritative. This plan implements those decisions and must not introduce a stricter or more permissive alternative in a slice, test fixture, target Adapter, online script, or Advanced Setting. A future policy change updates the Architecture Spec, this plan, `AnthropicMessagesPiProviderSemanticAudit.md`, and the affected tests in one change.

## 2. Implementation baseline and remaining certification

This is a simplification refactor of the existing Anthropic vertical module, not a rewrite. The implementation already has and must preserve:

- `AnthropicConversionResult` and the protocol-owned Invocation;
- Pi Context/options construction, reasoning/continuity state, render state, and notices;
- the Anthropic-owned Pi wrapper with exclusive, exactly-once `onPayload`;
- target Adapters for the currently registered Pi text APIs and their certified mappings;
- Pi `AssistantMessage` to Anthropic JSON/SSE conversion;
- the three independent direct-protocol online scripts.

The refactor closes the remaining responsibility problems:

- request validation operates on request-local, demand-driven views; unclaimed top-level fields and nested siblings remain unread and cannot mutate Client input;
- the candidate Supplement is enumerated once, every present candidate receives exactly one final outcome, and the coordinator alone records unconsumed candidates as `omitted + warning`;
- the registry returns one Adapter object directly, with separate whole-request reasoning and Supplement operations;
- ordinary Supplement outcomes cannot represent `failed`, and no generic Pi-only fallback Adapter exists;
- valid final-assistant content and visible historical thinking use bounded history fallbacks instead of model-capability rejection;
- Pi-owned `temperature` and concrete effort mappings are verified rather than independently rewritten; target-owned fields remain selectively projected;
- only malformed consumed input, broken identities/relationships, security or data-residency violations, unavailable server capabilities/model-visible content, and internal payload-contract faults may prevent dispatch.

The Anthropic-scoped unit, integration, final-wire, and three independent online Provider gates pass on 2026-08-24. New target mappings remain demand-driven and do not require editing non-consuming Adapters.

## 3. Target module structure

```text
src/protocols/anthropic/
  request.ts
  response.ts
  sse.ts
  semantic/
    invocation.ts
    execution.ts
    pi-execution.ts
    response.ts
    reasoning/
      contract.ts
      request.ts
      continuity.ts
    supplement/
      contract.ts
      candidates.ts
      validation.ts
    projection/
      contract.ts
      registry.ts
      supplement-disposition.ts
      adapters/
```

Keep a file only when it hides meaningful behavior behind a small Interface. Merge shallow files into their owning module. The root Anthropic `response.ts`/`sse.ts` path remains the response Interface; add only narrow internal helpers for Pi-retained provenance or continuity when they hide real behavior. Do not create a parallel per-Provider response registry by default.

There is no shared Semantic Conversion dependency. `pi-execution.ts` owns the Anthropic `onPayload` lifecycle and calls only the existing protocol-neutral `ExecutionOperation` capability. Mechanism-only leaf utilities may be shared later only after two protocol implementations prove identical mechanics, and they still may not call Pi, own `onPayload`, carry projection outcomes, or classify semantic failures. Do not move an OpenAI Responses helper into common code merely to call it from Anthropic.

## 4. Anthropic-owned Invocation

Keep the three existing cohesive Interfaces; do not replace them with one facade that owns raw request parsing, execution, and response rendering together:

```ts
convertValidatedAnthropicRequestWithPolicy(...)
  -> AnthropicConversionResult

executeAnthropicSemanticInvocation({
  models,
  model,
  invocation,
  execution,
}) -> { message, outcomes }

convertAssistantMessageToAnthropicWithPolicy(...)
  -> AnthropicResponseConversion
```

The protocol-owned Invocation remains:

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

`convertValidatedAnthropicRequestWithPolicy()` remains the one conversion implementation. Deepen it into the sole demand-driven raw-body operation; do not add a second parser for Supplement or reasoning fields.

Before validation, construct two immutable consumer views from the exact positive declarations in Architecture Section 5.1:

1. the main Anthropic view for Pi Context/options, reasoning/continuity, render state, and non-degradable main-call checks;
2. the Anthropic Supplement view for current projection candidates only.

Selection must copy only own properties and declared nested paths. Do not pass the complete raw request to either downstream validator. A claimed object validator reads only its declared children; an unclaimed sibling remains unread. Keep the continuity envelope closed-world because the complete envelope is a consumed bounded opaque contract.

Derive bounded top-level unclaimed-field warnings from present own keys minus the union of both positive declarations. This set difference is observation only: do not persist it as an ignored/unsupported/non-projection registry, do not inspect the values, and do not let notice publication affect dispatch.

The conversion order is fixed: select consumer views, validate only their consumed paths, produce the strongest correct Pi Context/tools/options and reasoning/render state, then capture the current projection candidates during the same operation. A Supplement copy may retain a Pi-owned value only for a declared final-wire verifier/repairer; Pi remains authoritative and the copy does not authorize a duplicate Provider write. Candidate completeness describes coverage of the current Supplement consumer, not preservation of every Client field before target selection.

Availability behavior is a fixed Anthropic protocol contract rather than source semantics or user configuration. Do not add an `AnthropicSemanticAvailabilityPolicy`, Advanced Setting, strict-mode flag, or executor argument. Each target capability gap uses the one bounded fallback named by the Architecture Spec, emits `degraded` or `omitted` plus a developer warning, and remains distinct from malformed-source, security/permission, server-tool, relationship, and payload-contract failures.

Each consumed Anthropic request fact has one authoritative owner:

| Fact class | Owner |
|---|---|
| messages, system text, images, ordinary tools, tool calls/results | Pi `Context` |
| target-certified Pi options, including `temperature` and concrete `output_config.effort` | `invocation.pi.options` |
| thinking activation, exact budget, historical thinking, opaque continuity | Anthropic reasoning |
| current projection candidates retained for target validation/projection | Anthropic supplement; Pi options and main-call checks remain authoritative for their semantics |
| stream mode, `thinking.display`, and standard Anthropic response envelope | Anthropic Client render state |
| Pi `AssistantMessage` facts and their Anthropic mapping | Anthropic response module |
| conversion/projection notices | Anthropic-owned bounded facts published through fail-open observation |
| credentials, Profile, transport, retry, cancellation, diagnostics | existing infrastructure |

Unclaimed source fields have no semantic owner. They are neither supported nor invalid, and malformed values in them do not block dispatch.

Do not give a Supplement copy independent final-write ownership over a Pi-owned option. In particular, `temperature` remains Pi-owned when its validated source value is retained for a current final-wire verifier; a projector must not reinsert it when Pi intentionally omitted it. Retain `max_tokens` as `supplement.outputTokenCeiling` only while enabled target projectors verify or repair the Anthropic total generated-token ceiling after Pi thinking preparation. Projectors use that candidate only to lower a certified final Provider ceiling; they never use it as an independent sampling option.

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

Do not encode `adaptive` as provider default, invent a budget, or treat omission as explicit disable while claiming an exact mapping. Preserve exact budget separately from any coarse Pi thinking level. The fixed nearest-mode or target-default fallback consumes that exact source state only after target resolution and reports `degraded`. Validate `budget_tokens >= 1024` and `budget_tokens < max_tokens`, and ensure neither Pi's budget preparation nor target projection raises the final total output ceiling above Client `max_tokens`. If later context-safe clamping leaves no valid room above the budget, disable reasoning for that request and warn.

Map a concrete `output_config.effort` once into the audited Pi reasoning option. Pi's Provider Adapter and `model.thinkingLevelMap` own its target representation. Accept a certified Pi compatibility mapping as `pi-native`; when the target has no equivalent effort control, omit only the preference and warn. The Anthropic projector may validate that Pi produced the audited representation, but it must not independently remap the same effort. Store `thinking.display` in `AnthropicResponseRenderState`; it controls Anthropic response rendering and is not a Provider-generation projection.

For a target with a proven reasoning mapping, the selected target Adapter decides only:

- whether Pi options express the source request exactly;
- whether `onPayload` must validate or repair the final Provider field;
- whether Pi emitted the audited effort representation or the unsupported preference must be omitted with a warning;
- whether explicit disable is proved in the final wire or honestly reported as target-default degradation;
- which reasoning facts it consumed and their outcomes.

Reasoning keeps its own protocol contract and outcomes; it is not reclassified as an ordinary Supplement candidate merely to reuse central omission logic. A target with no proven reasoning mapping does not receive a placeholder reasoning projector and instead uses the explicit reasoning fallback/omission rule defined by the Architecture Spec.

### 5.2 Historical thinking and opaque continuity

The module must preserve:

- visible `thinking` text;
- `thinking.signature` attached to the same thinking block;
- `redacted_thinking.data` and its redacted representation;
- any Provider response signature attached to text or a tool call when the Anthropic Client Wire has a validated extension carrier;
- actual source Provider/API/model provenance from the Pi `AssistantMessage`.

The Anthropic standard signature field may carry only values valid under the Anthropic wire contract. Foreign Provider metadata must not masquerade as an Anthropic-native signature.

When a Pi thinking block has no non-empty signature, render the standard Anthropic thinking block with `signature: ""`, emit a bounded warning, and treat that empty value as absent when the Client returns the block in later history. This is a lossy placeholder, not exact continuity. Preserve visible thinking and use the target Adapter's valid unsigned-thinking or content fallback on replay. Never substitute an empty value for `redacted_thinking.data`.

Implement the item-local `token_continuity` v1 codec defined by the Anthropic architecture specification and certify:

1. the extension has an item-local attachment point for thinking, text, and tool calls;
2. the Anthropic response encoder retains it;
3. the request parser validates it as closed-world bounded data;
4. supported complete-history clients return it without copying opaque data into model-visible text;
5. malformed, duplicate, incompatible, or unknown-version attachments are ignored individually with warnings;
6. clients that do not return it preserve visible reasoning through an honest fallback.

Record every tested client as `native-fields-only` or `item-extension-v1`. The direct raw-protocol suite must pass `item-extension-v1`; Claude Code/Claude CLI receives its own capability result. Do not satisfy the continuity gate merely by leaving every foreign attachment form uncertified.

Do not add server-side continuity storage in this plan.

## 6. Demand-driven Anthropic request and complete response audit

Slice 0 updates `doc/AnthropicMessagesPiProviderSemanticAudit.md` with independent request and response matrices. The request half begins with the two positive consumer declarations from Architecture Section 5.1. It must distinguish:

- main-consumer paths used for Pi Context/options, reasoning/continuity, render state, or a non-degradable main-call check;
- Supplement-consumer paths used by at least one current enabled target Adapter for projection, verification, repair, or one named bounded fallback;
- deliberate overlap required for Pi-first final-wire verification or a main-call constraint that also has a certified Provider projection;
- source fields and nested siblings claimed by neither consumer, which remain unread and are not part of the semantic audit matrix.

The initial positive source-path audit covers only currently consumed forms of:

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
- standard `user|assistant` message roles and the explicit accept/reject contract for any Token `system`-message extension;
- text citations/cache, URL images, container uploads, every document source/title/context/citations/cache form, and every search-result source/content/citations/cache form;
- tool references, tool-use/server-tool caller/cache, tool-result nested content, and every typed server-tool result family;
- any other tagged content path only when a current enabled Adapter or main-call contract positively consumes it.

For each consumed path, record:

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

The Supplement captures only validated projection candidates with a current downstream consumer. A main-consumer fact whose final meaning is not proved by Pi does not automatically enter the Supplement: add it only with an enabled target mapping/verifier or named fallback and a final-wire test. Conversely, security, permission, data-residency, server-tool, minimum-request, and relationship contracts are enforced by request validation or the Pi/main-call contract before the candidate-only Supplement seam. It is an Anthropic type, not a universal request-control model.

For top-level fields outside both declarations, record only the bounded warning behavior and its byte/count limits. Do not add one audit row per unknown field and do not parse its value. For a claimed object, test that malformed declared children fail while malformed or future unclaimed siblings remain unread and non-terminal.

The response half starts from Pi `AssistantMessage`. It may use the message's actual API/Provider/model provenance when a retained Pi field requires it, and records:

```text
AssistantMessage field and attachment point, if retained
Anthropic JSON and SSE rendering
response-only versus next-request replay semantics
valid null/default, fallback, warning, or critical failure
Pi AssistantMessage → Anthropic response fixture
next-history final Provider request fixture when replay-required
```

It must explicitly cover every corresponding fact that Pi IR can retain: citations, caller identity, server tools/results, container uploads, container, stop reason/detail/sequence, usage details, and every reasoning signature location listed in the architecture specification. A hard-coded `null` is valid only when the Anthropic target contract defines it for the Pi fact. Facts discarded before Pi IR are unavailable to this response module and receive only a protocol-valid omission/default/fallback; the implementation does not add raw Provider response interception.

Target-bound facts such as a Provider container remain narrowly typed with source provenance and compatibility conditions. They do not become generic semantic fields merely to avoid a protocol-local type.

The converter records stable request-local associations from source message/content/tool identities to the Pi blocks it creates. It must not put marker text in Pi IR. A projector may restore a nested field only after resolving an unambiguous target payload attachment.

## 7. Anthropic-owned target projectors

Register a target Adapter only when the Anthropic Semantic Conversion lane has at least one proven supplement or reasoning mapping for that target. The eligible audit families are:

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

Models claimed by the Anthropic Provider Native lane bypass this module. That does not prove every `anthropic-messages` target is Native-eligible: unclaimed targets use Pi normally and receive an independently audited semantic projector only for supplement fields that need one. Their Pi `AssistantMessage` is rendered by the Anthropic response module. They are not rejected merely because another target with the same API ID used a Native lane.

The list above is an audit backlog, not a requirement to create every Adapter or project every supplement field. Do not add an empty Adapter, an exhaustive field switch, or a placeholder mapping to make the matrix appear complete.

Each Adapter receives the Pi-built payload, resolved target facts, immutable candidate Supplement, and prepared reasoning. It returns a copied payload plus consumed facts and outcomes, and owns only:

- exact payload-shape validation required by its enabled mappings;
- Pi-native validation relevant to those mappings;
- proven source-to-target field mappings;
- minimum compatibility predicates;
- repair warnings;
- consumed-field outcomes.

A projector is positive-only. Do not add a branch merely to emit “unsupported,” “ignored,” or “omitted” for a Supplement field. Return outcomes only for facts the Adapter actually projected, validated, repaired, or deliberately degraded through a target-specific fallback. The Anthropic coordinator is the sole owner of `omitted + warning` for every ordinary candidate left unconsumed. Supplement target unavailability never becomes `failed` and never prevents dispatch.

If no projector is certified for the resolved API/model, an ordinary Pi-only request remains usable and every Supplement candidate is omitted with a warning. Non-degradable semantics were already handled by source validation or the Pi/main-call contract; do not encode them as critical Supplement candidates. If a selected projector receives a final payload shape different from its audited contract, fail before dispatch because this indicates Pi dependency drift, a wrong selection, or an incompatible custom Provider and cannot be repaired by guessing.

After the selected Adapter returns, the Anthropic coordinator records each ordinary unconsumed candidate as `omitted + warning`. Target-specific bounded fallbacks exist only in the Adapter that constructs or verifies them: unsupported `any` may use target auto with all reachable tools; unsupported named choice may use target auto after exposing only the named tool; unsupported `none` may remove every controllable current-request tool capability; unsupported serial use may permit target parallel behavior; structured output may use the certified JSON/schema-prompt fallback; reasoning may use its certified target-default/nearest-mode fallback; and prefill may remain visible assistant history. Unsupported `stop_sequences` are simply omitted with a warning—never injected into a prompt or simulated by response truncation. Missing identities, broken relationships, permissions, invalid payloads, unsupported server tools, and other non-degradable constraints fail through the main-call contract before this disposition. Do not duplicate negative disposition branches in every Adapter or generalize them into a shared cross-protocol policy flag.

Projectors do not reuse the OpenAI Responses target projector registry. Similar Provider fields may be implemented twice when the source semantics differ or independence is more valuable than line-count reduction.

Even when an implementation helper is shared within the Anthropic module, every enabled mapping has an explicit target compatibility predicate, payload-shape fixture, and final-wire certification. An unaudited target/field pair remains unimplemented rather than receiving a speculative registry row.

## 8. Anthropic-owned response conversion

Deepen the existing response converter as one Anthropic-owned module. It consumes only Pi `AssistantMessage`, Anthropic render state, projection outcomes, and validated request-local continuity associations. It does not receive raw Provider streams, diagnostics payloads, Provider payloads, or OpenAI Responses Client types. Target provenance may select a small internal interpretation rule for a Pi-retained field, but do not require a parallel per-Provider response registry merely because request projectors vary by Provider.

For every Pi response field, implement only dispositions established by the response half of the semantic audit:

1. render exact Pi-retained content, usage, stop, ID, and opaque attachment facts;
2. interpret target-specific Pi fields only under matching provenance;
3. use only Anthropic-defined null/default values;
4. preserve replay metadata through native fields or `token_continuity` v1;
5. warn on permitted response loss and fail when valid response structure, security, tool relationships, or required replay semantics cannot be constructed.

The response module never uses `onPayload`. If Pi has discarded a Provider response field, the implementation records the audit disposition rather than adding a response interception layer or guessing the value. For `thinking.display: "omitted"`, render empty visible thinking and retain the Pi signature. If the signature is absent, emit `signature: ""` plus a warning and treat it as absent on replay; do not empty `redacted_thinking.data`.

Anthropic responses do not echo request control effectiveness. Successful request outcomes remain internal certification facts; omission/fallback/repair notices go only to the fail-open observation seam.

## 9. Anthropic semantic execution

The Anthropic semantic executor:

1. receives the resolved Pi Model and the already converted `AnthropicSemanticInvocation` after Native lane selection has completed;
2. prepares reasoning/history/continuity once for that target;
3. passes the prepared Invocation as one unit to the Anthropic Pi wrapper;
4. selects at most one target Adapter from the resolved model facts, with no Adapter for a Pi-only target;
5. creates one Anthropic-owned `PayloadProjectionOperation` that closes over only the immutable reasoning and supplement;
6. passes Pi input plus that operation to `executeWithAnthropicPi()`;
7. after Pi builds the candidate payload, lets the selected Adapter consume only its proven subset and centrally records every remaining Supplement candidate as omitted with a warning;
8. converts the returned Pi `AssistantMessage` and outcomes into an Anthropic response;
9. returns exact projection outcomes for observation and certification without adding request-control echo fields to the Anthropic response.

The request converter never creates `onPayload`. The Anthropic Pi execution wrapper owns that callback and receives no raw Anthropic request object.

## 10. TDD implementation slices

### Slice 0 — Bidirectional field audit and red end-to-end fixtures

1. Replace the request half of the Anthropic semantic audit with the exact main and Supplement consumer declarations from Architecture Section 5.1; keep the response audit complete for Pi-retained target facts.
2. Capture current Pi input and final Provider body for each target API using test transports.
3. Capture Pi `AssistantMessage` fixtures, Anthropic JSON/SSE output, and next-history Provider request for every replay-required fact; retain selected Provider response → Pi fixtures only as Pi dependency certification, not as an input to the Anthropic response module.
4. Add failing request tests for forced/named/none tool choice, serial-tool constraint, structured output, reasoning disable/exact budget/adaptive mode, assistant prefill, output-ceiling/budget interaction, full-history provenance, unsupported server tools, and selected-projector payload-shape mismatch.
5. Add red disposition tests proving every unsupported degradable control produces only its documented best-effort fallback, a `degraded` outcome, and a warning without fabricating tool calls, schema-valid output, exact reasoning, or exact prefill continuation. Add separate omission-and-warning tests for unsupported `stop_sequences` and unsupported Pi-owned preferences.
6. Add Pi IR → Anthropic response tests for display omission, missing thinking signature, caller ambiguity, server tools/results, container, pause continuation, unknown terminal states, complete usage, every opaque attachment location, and SSE deltas; add warning-fallback tests for optional citations, safely representable stop/refusal facts, and other auxiliary loss.
7. Add red extraction tests proving malformed unclaimed top-level values and claimed-object siblings remain unread and non-terminal, malformed consumed paths still fail, and unclaimed warnings are bounded and fail-open.
8. Add dependency assertions prohibiting imports from OpenAI Responses semantic modules.

Gate: every request path in a positive consumer has an explicit owner, target disposition, and end-to-end test; every field outside both consumers remains unread; every Pi-retained response fact has an explicit response disposition.

### Slice 1 — Demand-driven Anthropic Invocation and candidate Supplement

1. Deepen the existing conversion result into `AnthropicConversionResult`.
2. Add one source-selection step that creates the main and Supplement consumer views before validation; downstream validators never receive the complete raw request.
3. Capture the complete set of currently declared projection candidates in the same conversion operation; remove dormant Supplement fields whose last target consumer is absent.
4. Narrow the ordinary Supplement outcome type so target unavailability cannot construct `failed`; keep reasoning and main-call terminal outcomes separate.
5. Preserve current correct Pi messages, tools, options, render state, and notices. Do not preserve invented model-visible repairs: an unresolved tool relationship is retained exactly when validly representable and otherwise fails according to its critical relationship contract.
6. Emit bounded top-level unclaimed-field notices without inspecting values; keep empty-Supplement Pi input equivalent to the current converter.

Gate: Client Wire → Anthropic Invocation tests cover every consumer-declared path, prove unclaimed paths are non-terminal, and prove every Supplement member has at least one current target consumer without exposing a Provider payload shape to the request converter.

### Slice 2 — Anthropic reasoning request semantics

1. Implement the independent activation/effort/budget contract.
2. Preserve omission, disabled, enabled-budget, and adaptive distinctly.
3. Preserve `thinking.display` in Client render state; map concrete `output_config.effort` once to Pi options and test the target's audited Pi mapping.
4. Enforce exact budget/output-ceiling relationships without Pi widening the Client ceiling.
5. Extract historical thinking/redacted thinking and attachment identities.
6. Add target-specific preparation and final-payload validation one target at a time.

Gate: no Anthropic reasoning state is encoded through an OpenAI Responses reasoning type or guessed default.

### Slice 3 — Anthropic response continuity loop

1. Extract actual Provider/API/model provenance from Pi responses.
2. Render native Anthropic thinking/redacted fields where valid.
3. Implement and certify the bounded item-local `token_continuity` v1 codec.
4. Restore compatible attachments in the next complete-history Provider request.
5. Preserve visible reasoning and discard only incompatible opaque state on model switch.

Gate: native fields and direct-protocol `item-extension-v1` pass Provider response → Anthropic Client response → next Client request → final Provider request; Claude Code/Claude CLI receives an explicit carrier capability result.

### Slice 4 — Anthropic target projectors

Preserve and simplify every currently registered Adapter: CommandCode Private, Anthropic Messages, OpenAI Completions, Responses/Azure/Codex, Google/Vertex, Mistral, certified Bedrock families, and Pi Messages. Registry selection returns the Adapter object directly. Each Adapter may expose one whole-payload reasoning operation and one positive-only Supplement operation; there is no second ID dispatch and no per-message `onPayload` call.

After this baseline, add another Adapter or mapping only when a present Supplement fact, a real target requirement, exact payload evidence, and a final-wire test all exist. Do not scaffold theoretical target/field combinations.

Before enabling the first fallback, add a configuration test proving Anthropic rejects an obsolete or invented `conversion.availability` object. The fixed disposition must not appear in Advanced Settings, OpenAI Responses configuration, or the narrow Anthropic Pi execution input.

For each enabled mapping, begin with a failing Client Wire → final Provider Wire test. Unconsumed candidates receive the single central `omitted + warning` outcome; no projector copies unknown Supplement fields blindly or declares negative cases it does not consume. A pure candidate enumerator plus set subtraction is the complete ordinary disposition algorithm.

Add the Anthropic-only `degraded` projection outcome before enabling availability fallback. The warning publisher must distinguish degradation from omission and exact Pi repair. No effective-state or observation path may claim an exact forced/serial/none/schema/stop/reasoning/prefill control when the final request used a fallback.

Gate: every enabled mapping has a final-wire test, every Supplement candidate has at least one enabled consumer, and every unconsumed candidate has a central omission outcome without preventing dispatch.

### Slice 5 — Pi IR to Anthropic response conversion

1. Deepen the Anthropic-owned response module at the Pi `AssistantMessage` seam; use target provenance only for Pi fields whose retained meaning requires it.
2. Preserve all Pi-retained response content, signatures, stop facts, usage, IDs, and attachments in valid Anthropic JSON/SSE form.
3. Implement `thinking.display: "omitted"` as empty visible thinking with retained signature; use `signature: ""` plus a warning only when Pi supplied no signature, and treat it as absent on replay.
4. Replace hard-coded null/default output only when Pi IR proves a stronger mapping; never fabricate an unavailable Provider fact.
5. Emit developer notices through the fail-open observation seam and keep them out of Anthropic Wire.
6. Fail critical response conversions rather than normalizing them into a false successful Anthropic result.

Gate: the response module is fully tested from Pi `AssistantMessage` to Anthropic JSON/SSE, selected Provider response → Pi dependency fixtures cover retained opaque fields, and all replay-required facts continue into the next final Provider request.

### Slice 6 — Anthropic-owned Pi execution integration

1. Route only the Anthropic Semantic Conversion branch through `executeWithAnthropicPi()`.
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
- unsupported server tool and other hard controls failing before upstream dispatch;
- captured final Provider body assertions.

For every unsupported degradable control, the script asserts the documented final-wire fallback; there is no strict-policy case. Developer-warning publication is asserted by local execution tests because online scripts do not use diagnostics as an oracle. Unsupported `stop_sequences` must be absent from the final Provider body and the Provider response must not be post-truncated. Structured-output tests must parse but never assume schema conformance; reasoning tests distinguish Pi's certified effort mapping from unsupported exact-budget/adaptive activation and distinguish a genuinely non-reasoning model from a reasoning model whose target cannot disable it; prefill tests prove ordinary-history placement. In particular, CommandCode GOAT `deepseek/deepseek-v4-flash` must independently reproduce both recorded direct-wire results: named/required thinking-mode requests are rejected by the upstream wire while the bounded automatic single-tool fallback remains usable, and an accepted `thinking: {type: "disabled"}` request can still return thinking. The latter is a degraded target-default outcome, not an exact disable guarantee. Preserve the dated wire-evidence comments beside the GOAT compatibility rules; they may be removed only after a replacement online certification updates the source, audit, and this plan.

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
- Do not enter Direct Mode or Provider Native after Semantic lane commitment.
- Do not add server-owned continuity storage.
- Do not claim `previous_response_id`; it is not an Anthropic Client capability.

## 13. Definition of done

Anthropic Semantic Conversion is complete when:

1. it owns an independent Invocation, demand-driven candidate Supplement, reasoning/continuity module, target projector registry, Pi IR → Anthropic response module, and tests;
2. it owns its Pi payload execution wrapper and shares no Semantic Conversion executor, Invocation, supplement, reasoning, projector, outcome, or error type with another Client Protocol;
3. every consumer-declared request path has one owner and explicit outcome, every Supplement member has a current target consumer, and unclaimed paths remain unread;
4. every supported mapping is proved from Anthropic Client Wire to final Provider Wire;
5. every Pi-retained response fact has a Pi `AssistantMessage` → Anthropic JSON/SSE disposition and fixture, with Provider response → Pi dependency fixtures only where retained opaque fields require certification;
6. native and `item-extension-v1` full-history reasoning continuity is restored with correct provenance and attachment for every certified client capability;
7. unsupported non-degradable controls fail through source validation or the Pi/main-call contract before Supplement projection, fixed availability fallbacks degrade honestly without a strict-mode switch, unconsumed candidates warn without blocking dispatch, and critical response conversion fails rather than fabricating success;
8. the three fixed-target independent online Provider scripts pass, and Claude Code/Claude CLI has a separate real-agent result;
9. OpenAI Responses and both Native lanes remain behaviorally unchanged.
