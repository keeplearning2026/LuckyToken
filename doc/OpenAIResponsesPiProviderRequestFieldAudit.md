# OpenAI Responses → Pi Provider Request Field Audit

Date: 2026-08-23

Scope: the pinned `pi-agent/packages/ai/src` implementation in this repository and LuckyToken's current Semantic Conversion request path.

Primary protocol source: the pinned official OpenAI TypeScript SDK 6.40.0.

## Conclusion

LuckyToken currently has three correctness gaps that should be treated as high priority:

1. `text.format`, `parallel_tool_calls`, and `tool_choice: "required"` are silently lost on the Semantic Conversion path. `tool_choice` for a named function is also discarded, although a notice is emitted. The final Provider request therefore does not preserve the client's control semantics.
2. Most target Providers already have a corresponding native request control for required/named tool choice. The main blocker is Pi's generic `SimpleStreamOptions → streamSimple()` contract, not universal Provider incapability.
3. `top_p` currently reaches only the three OpenAI-compatible builders that apply `samplingParams`. `service_tier`, `truncation`, `text.*`, `parallel_tool_calls`, and most identity/cache controls have no typed generic projection. Blindly putting them in `samplingParams` works only in those builders and is not a cross-Provider solution.

There are also confirmed protocol-contract bugs at the Responses edge itself: the current parser implements an obsolete `tool_choice` allowed-list shape, accepts the wrong `prompt_cache_retention` spelling, rejects legal `null` values for `conversation`/`prompt`, collapses absent reasoning and explicit `reasoning.effort:"none"`, and the response renderer reports requested/default controls rather than the controls that reached the final Provider request.

Correctness must be evaluated at the final Provider request. A field parsed into a LuckyToken object or placed in `SimpleStreamOptions` is not supported unless the selected Pi adapter's final builder emits an equivalent Provider-wire control.

## Sources and method

The pinned OpenAI SDK defines `text`, `parallel_tool_calls`, `tool_choice`, `max_output_tokens`, `reasoning`, `service_tier`, `store`, `top_p`, and `truncation` as separate Responses request controls ([responses.d.ts:6129](../node_modules/openai/resources/responses/responses.d.ts#L6129), [responses.d.ts:6191](../node_modules/openai/resources/responses/responses.d.ts#L6191), [responses.d.ts:6213](../node_modules/openai/resources/responses/responses.d.ts#L6213), [responses.d.ts:6250](../node_modules/openai/resources/responses/responses.d.ts#L6250), [responses.d.ts:6267](../node_modules/openai/resources/responses/responses.d.ts#L6267), [responses.d.ts:6285](../node_modules/openai/resources/responses/responses.d.ts#L6285), [responses.d.ts:6302](../node_modules/openai/resources/responses/responses.d.ts#L6302), [responses.d.ts:6309](../node_modules/openai/resources/responses/responses.d.ts#L6309), [responses.d.ts:6317](../node_modules/openai/resources/responses/responses.d.ts#L6317), [responses.d.ts:6351](../node_modules/openai/resources/responses/responses.d.ts#L6351), [responses.d.ts:6359](../node_modules/openai/resources/responses/responses.d.ts#L6359)). In particular, `text.format.json_schema` is a required-output contract rather than a presentation hint ([responses.d.ts:2151](../node_modules/openai/resources/responses/responses.d.ts#L2151), [responses.d.ts:4925](../node_modules/openai/resources/responses/responses.d.ts#L4925)).

Pi has ten built-in chat APIs ([types.ts:17](../pi-agent/packages/ai/src/types.ts#L17)). LuckyToken invokes them through `models.streamSimple()` ([execution.ts:119](../src/execution.ts#L119)), so the effective common contract is `SimpleStreamOptions`, not each adapter's richer direct `stream()` option type. The common contract contains `temperature`, `samplingParams`, `maxTokens`, cache retention/session ID, metadata, and reasoning/deferred controls, but no response format, parallel-tool flag, typed tool choice, top-p field, service tier, truncation, store, or background field ([types.ts:175](../pi-agent/packages/ai/src/types.ts#L175), [types.ts:303](../pi-agent/packages/ai/src/types.ts#L303)). `buildBaseOptions()` forwards only that named subset ([simple-options.ts:21](../pi-agent/packages/ai/src/api/simple-options.ts#L21)).

`samplingParams` is intentionally applied only by OpenAI-compatible Completions, Responses, and Azure Responses adapters ([types.ts:181](../pi-agent/packages/ai/src/types.ts#L181)). It is an untyped body escape hatch, so this audit marks mappings that depend on it as **partial**, even when the final JSON key can be emitted.

An `onPayload` callback is not counted as adapter support: it can replace any payload after construction and would merely move Provider-wire construction into the caller.

Legend:

- **T**: the typed `SimpleStreamOptions` path expresses the semantic and the final builder emits an equivalent target control.
- **P**: partial: builder support is model-dependent/coarser, requires an adapter-specific direct option, or relies on the untyped `samplingParams` escape hatch.
- **N**: no normal Pi option-to-builder mapping. Serializer-only support or a possible `onPayload` mutation does not qualify.

## Reference comparison: OpenCodex

OpenCodex is materially closer to the required end-to-end behavior for these controls because it retains canonical `toolChoice`, `parallelToolCalls`, `textFormat`, `serviceTier`, and `promptCacheKey` facts after parsing instead of dropping them at the Responses edge ([request.ts](../reference/opencodex/src/types/request.ts#L230), [parser.ts](../reference/opencodex/src/responses/parser.ts#L745)). Its parser also recognizes the current SDK `{type:"allowed_tools", mode, tools}` shape and keeps the required/auto mode ([parser.ts](../reference/opencodex/src/responses/parser.ts#L122)).

For the same Responses request routed to an OpenAI Chat Completions wire, OpenCodex:

- converts a specified function to Chat `{type:"function", function:{name}}` and preserves bare `"required"` where the target capability permits it ([openai-chat.ts](../reference/opencodex/src/adapters/openai-chat.ts#L1267));
- converts Responses `text.format` into Chat `response_format`, including JSON Schema name, description, schema, and strictness ([openai-chat.ts](../reference/opencodex/src/adapters/openai-chat.ts#L1464));
- writes `parallel_tool_calls` only under an explicit target capability rather than assuming every OpenAI-compatible endpoint accepts it ([openai-chat.ts](../reference/opencodex/src/adapters/openai-chat.ts#L1481)).

It also demonstrates real non-OpenAI mappings that the current Pi generic path cannot reach: Responses required/named tool choice maps to Anthropic `any`/named `tool`, JSON Schema maps to Anthropic `output_config.format`, and a named Google choice maps to `ANY + allowedFunctionNames` ([anthropic.ts](../reference/opencodex/src/adapters/anthropic.ts#L967), [google.ts](../reference/opencodex/src/adapters/google.ts#L353)).

OpenCodex is evidence, not a drop-in contract. It still degrades controls according to its own target capability tables, and some parser paths ignore malformed/unsupported format shapes. The applicable lesson is its information flow: retain a typed semantic control until the physical target is known, then let the target adapter either emit an equivalent wire field or report/fail the loss.

## Matrix A: model-output and tool controls

| Pi API | `text.format` | `parallel_tool_calls` | tool required | named function | `max_output_tokens` | `temperature` | `top_p` | reasoning effort | reasoning summary |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `anthropic-messages` | N | N | P | P | P | P | N | P | P |
| `openai-completions` | P | P | P | P | T | T | P | P | N |
| `openai-responses` | P | P | P | P | P | T | P | T | P |
| `azure-openai-responses` | P | P | P | P | P | T | P | T | P |
| `openai-codex-responses` | N | P | P | N | N | T | N | T | P |
| `google-generative-ai` | N | N | P | N | T | T | N | P | N |
| `google-vertex` | N | N | P | N | T | T | N | P | N |
| `mistral-conversations` | N | N | P | P | T | T | N | P | N |
| `bedrock-converse-stream` | N | N | P | P | P | T | N | P | P |
| `pi-messages` | N | N | P | P | T | T | N | T | N |

### Matrix A limitations

- `max_output_tokens → maxTokens` is not uniformly equivalent. `buildBaseOptions()` may lower the cap against Pi's context estimate, which still respects the caller's upper bound, but OpenAI Responses/Azure raise values below 16 instead of rejecting them ([simple-options.ts:12](../pi-agent/packages/ai/src/api/simple-options.ts#L12), [openai-responses.ts:296](../pi-agent/packages/ai/src/api/openai-responses.ts#L296), [azure-openai-responses.ts:292](../pi-agent/packages/ai/src/api/azure-openai-responses.ts#L292)). More seriously, the Anthropic and Bedrock `streamSimple()` paths treat `maxTokens` as visible-answer capacity and add a thinking budget, whereas Responses defines `max_output_tokens` as the combined reasoning-plus-visible ceiling ([simple-options.ts:61](../pi-agent/packages/ai/src/api/simple-options.ts#L61), [anthropic-messages.ts:840](../pi-agent/packages/ai/src/api/anthropic-messages.ts#L840), [bedrock-converse-stream.ts:481](../pi-agent/packages/ai/src/api/bedrock-converse-stream.ts#L481)). Those mappings are partial when reasoning is enabled.
- Anthropic drops `temperature` whenever extended thinking is enabled and for models whose compat says temperature is unsupported ([anthropic-messages.ts:1020](../pi-agent/packages/ai/src/api/anthropic-messages.ts#L1020)).
- Reasoning effort is intentionally approximate on token-budget and coarse-level Providers. Mistral collapses the generic levels to its model-specific prompt mode or `none|high` effort ([mistral-conversations.ts:190](../pi-agent/packages/ai/src/api/mistral-conversations.ts#L190), [mistral-conversations.ts:896](../pi-agent/packages/ai/src/api/mistral-conversations.ts#L896)); Google maps them to model-specific levels or budgets ([google-generative-ai.ts:311](../pi-agent/packages/ai/src/api/google-generative-ai.ts#L311)); Anthropic and Bedrock choose adaptive effort or budget thinking by model ([anthropic-messages.ts:828](../pi-agent/packages/ai/src/api/anthropic-messages.ts#L828), [bedrock-converse-stream.ts:471](../pi-agent/packages/ai/src/api/bedrock-converse-stream.ts#L471)).
- Bedrock's final reasoning builder currently emits `additionalModelRequestFields` only for Anthropic Claude model IDs; it returns `undefined` for other Bedrock models even when the generic reasoning option is present ([bedrock-converse-stream.ts:1111](../pi-agent/packages/ai/src/api/bedrock-converse-stream.ts#L1111), [bedrock-converse-stream.ts:1155](../pi-agent/packages/ai/src/api/bedrock-converse-stream.ts#L1155)).
- `reasoning.summary` has no common Pi request option. OpenAI Responses, Azure Responses, and Codex have direct `reasoningSummary` options, while Anthropic/Bedrock expose only the coarser `summarized|omitted` thinking display control ([openai-responses.ts:91](../pi-agent/packages/ai/src/api/openai-responses.ts#L91), [azure-openai-responses.ts:55](../pi-agent/packages/ai/src/api/azure-openai-responses.ts#L55), [openai-codex-responses.ts:72](../pi-agent/packages/ai/src/api/openai-codex-responses.ts#L72), [anthropic-messages.ts:230](../pi-agent/packages/ai/src/api/anthropic-messages.ts#L230), [bedrock-converse-stream.ts:78](../pi-agent/packages/ai/src/api/bedrock-converse-stream.ts#L78)).
- Responses reasoning has two distinct states that the current Pi invocation collapses: omitted reasoning means "use the selected model/API default", while `effort:"none"` is an explicit off request. LuckyToken converts both to absent `SimpleStreamOptions.reasoning`; `streamSimple()` then interprets absence differently by API, including explicitly disabling thinking for Anthropic and Google ([request.ts:674](../src/protocols/openai-responses/request.ts#L674), [anthropic-messages.ts:816](../pi-agent/packages/ai/src/api/anthropic-messages.ts#L816), [google-generative-ai.ts:296](../pi-agent/packages/ai/src/api/google-generative-ai.ts#L296), [google-vertex.ts:313](../pi-agent/packages/ai/src/api/google-vertex.ts#L313)). This distinction needs a typed tri-state rather than omission plus a notice.

## Matrix B: lifecycle, routing, cache, and identity controls

| Pi API | `truncation` | `service_tier` | prompt cache | Responses `metadata` | `user` / `safety_identifier` | `background` | `store` | `include` / `top_logprobs` |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `anthropic-messages` | N | N | P | N | P | N | N | N |
| `openai-completions` | N | P | P | P | P | N | P | N |
| `openai-responses` | P | P | P | P | P | P | P | P |
| `azure-openai-responses` | P | P | P | P | P | P | P | P |
| `openai-codex-responses` | N | P | P | N | N | N | N | N |
| `google-generative-ai` | N | N | N | N | N | N | N | N |
| `google-vertex` | N | N | N | N | N | N | N | N |
| `mistral-conversations` | N | N | P | N | N | N | N | N |
| `bedrock-converse-stream` | N | N | P | N | N | N | N | N |
| `pi-messages` | N | N | P | N | N | N | N | N |

### Matrix B limitations

- The **P** entries for OpenAI Responses/Azure lifecycle controls mean only that `samplingParams` is merged into the final body. Pi does not expose Responses background/deferred lifecycle through those adapters, so emitting `background:true` is not a complete implementation. The generic `deferred` option is declared but no built-in API request builder consumes it ([types.ts:303](../pi-agent/packages/ai/src/types.ts#L303)).
- Pi's prompt-cache abstraction is `cacheRetention + sessionId`; it is not an exact representation of `prompt_cache_key + prompt_cache_retention`. Anthropic/Bedrock add content cache markers; Mistral sends a prompt cache key and affinity header; OpenAI-family adapters derive the key from `sessionId` ([anthropic-messages.ts:963](../pi-agent/packages/ai/src/api/anthropic-messages.ts#L963), [bedrock-converse-stream.ts:770](../pi-agent/packages/ai/src/api/bedrock-converse-stream.ts#L770), [mistral-conversations.ts:327](../pi-agent/packages/ai/src/api/mistral-conversations.ts#L327), [openai-responses.ts:284](../pi-agent/packages/ai/src/api/openai-responses.ts#L284)). Google builders ignore both common cache fields.
- Retention duration is also not portable: Responses `"24h"` becomes Pi `"long"`, but Anthropic and Bedrock currently project `long` to one-hour cache markers. That may be a useful best effort, but it is not an exact 24-hour round trip and must be reported as a degradation rather than described as preserved.
- Responses `metadata` is response-object annotation/storage metadata. LuckyToken can echo it without sending it to the model Provider. It is not semantically interchangeable with Bedrock `requestMetadata`, which the Pi source defines as AWS cost-allocation tags ([bedrock-converse-stream.ts:90](../pi-agent/packages/ai/src/api/bedrock-converse-stream.ts#L90)).
- `user`/`safety_identifier` is a stable end-user abuse/caching identity. Pi's only typed common carrier is `metadata`; Anthropic alone extracts `metadata.user_id` into its Provider request ([anthropic-messages.ts:1076](../pi-agent/packages/ai/src/api/anthropic-messages.ts#L1076)). OpenAI-compatible builders can receive native identity keys only through `samplingParams`.
- `include` and `top_logprobs` request response data that Pi IR and LuckyToken's Responses renderer do not generally represent. Merely injecting their request keys would not preserve the requested response contract, so they remain **N** except for wire-only OpenAI Responses/Azure partials.

## Per-adapter evidence

### `anthropic-messages`

The direct adapter supports `toolChoice: auto|any|none|{type:"tool",name}` ([anthropic-messages.ts:252](../pi-agent/packages/ai/src/api/anthropic-messages.ts#L252)) and emits it as Anthropic `tool_choice` ([anthropic-messages.ts:1083](../pi-agent/packages/ai/src/api/anthropic-messages.ts#L1083)). Thus Responses `required` can map to Anthropic `any`, and a named function can map to `{type:"tool",name}`. However, `streamSimple()` calls `buildBaseOptions()` and does not copy any tool choice, so LuckyToken's actual generic path cannot currently reach those fields ([anthropic-messages.ts:816](../pi-agent/packages/ai/src/api/anthropic-messages.ts#L816)).

Anthropic's pinned SDK supports `disable_parallel_tool_use` on `auto`, `any`, and named-tool choices ([messages.d.ts:1119](../node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts#L1119)), but Pi's option and builder never expose it. This is a demonstrated Pi adapter gap for `parallel_tool_calls:false`.

The pinned Anthropic SDK also supports `output_config.format`, but Pi only writes `output_config.effort` for adaptive thinking and has no format option ([messages.d.ts:1908](../node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts#L1908), [anthropic-messages.ts:1045](../pi-agent/packages/ai/src/api/anthropic-messages.ts#L1045)). Therefore structured text output is not currently mapped even though the upstream protocol can express it.

### `openai-completions`

The direct option accepts the OpenAI Chat Completions tool-choice union, and unlike most adapters its `streamSimple()` explicitly reads a runtime `toolChoice` property before building the request ([openai-completions.ts:143](../pi-agent/packages/ai/src/api/openai-completions.ts#L143), [openai-completions.ts:617](../pi-agent/packages/ai/src/api/openai-completions.ts#L617), [openai-completions.ts:745](../pi-agent/packages/ai/src/api/openai-completions.ts#L745)). It is still **P**, because `SimpleStreamOptions` does not declare that property.

The builder maps max tokens and temperature, and finally merges `samplingParams` over all named fields ([openai-completions.ts:696](../pi-agent/packages/ai/src/api/openai-completions.ts#L696), [openai-completions.ts:716](../pi-agent/packages/ai/src/api/openai-completions.ts#L716), [openai-completions.ts:724](../pi-agent/packages/ai/src/api/openai-completions.ts#L724), [openai-completions.ts:885](../pi-agent/packages/ai/src/api/openai-completions.ts#L885)). Consequently:

- `top_p` is a supported intended use of `samplingParams`.
- Responses `text.format` can be shape-converted to Chat Completions `response_format`, and `parallel_tool_calls`, `service_tier`, `user`, or supported `store` can be emitted, but only as untyped, endpoint-dependent partial mappings.
- The builder itself defaults supported `store` to `false`; a sampling parameter can override it because the merge is last ([openai-completions.ts:712](../pi-agent/packages/ai/src/api/openai-completions.ts#L712)).

### `openai-responses`

The direct adapter has typed `serviceTier` and the full Responses `toolChoice`, and the builder emits them ([openai-responses.ts:91](../pi-agent/packages/ai/src/api/openai-responses.ts#L91), [openai-responses.ts:304](../pi-agent/packages/ai/src/api/openai-responses.ts#L304), [openai-responses.ts:315](../pi-agent/packages/ai/src/api/openai-responses.ts#L315)). `streamSimple()` forwards neither field ([openai-responses.ts:197](../pi-agent/packages/ai/src/api/openai-responses.ts#L197)). The final `samplingParams` merge can inject/override `text`, `parallel_tool_calls`, `tool_choice`, `top_p`, `truncation`, `metadata`, `background`, and `store` ([openai-responses.ts:337](../pi-agent/packages/ai/src/api/openai-responses.ts#L337)), but that remains an untyped escape hatch and does not by itself implement background or extra-output lifecycle.

For a compatible Responses client and Responses Provider, LuckyToken's Native Preservation lane should forward the authoritative raw body instead of relying on these partial semantic mappings.

### `azure-openai-responses`

Azure maps max tokens, temperature, tools, reasoning, and prompt-cache key but has no direct typed tool choice or service-tier option ([azure-openai-responses.ts:270](../pi-agent/packages/ai/src/api/azure-openai-responses.ts#L270)). Its last-step `samplingParams` merge can inject the otherwise missing Responses keys ([azure-openai-responses.ts:324](../pi-agent/packages/ai/src/api/azure-openai-responses.ts#L324)). These are wire-capable but untyped partials, with the same lifecycle caveat as `openai-responses`.

### `openai-codex-responses`

The direct adapter exposes reasoning effort/summary, service tier, text verbosity, and `auto|none|required` tool choice, but not named-tool choice ([openai-codex-responses.ts:72](../pi-agent/packages/ai/src/api/openai-codex-responses.ts#L72)). The builder hard-codes `store:false`, `parallel_tool_calls:true`, default `tool_choice:"auto"`, and `text.verbosity`, then conditionally emits temperature, service tier, and reasoning ([openai-codex-responses.ts:516](../pi-agent/packages/ai/src/api/openai-codex-responses.ts#L516)). It ignores `samplingParams` and, critically, never emits the `maxTokens` carried by `buildBaseOptions()`. Thus `max_output_tokens` is currently lost on this API.

ChatGPT Codex explicitly rejects `store:true` ([openai-codex-responses.ts:1477](../pi-agent/packages/ai/src/api/openai-codex-responses.ts#L1477)). `parallel_tool_calls:false`, named tool choice, and `text.format` cannot be preserved by this builder.

### `google-generative-ai` and `google-vertex`

Both direct adapters expose only `auto|none|any` tool choice plus thinking controls ([google-generative-ai.ts:40](../pi-agent/packages/ai/src/api/google-generative-ai.ts#L40), [google-vertex.ts:45](../pi-agent/packages/ai/src/api/google-vertex.ts#L45)). `any` is the available required-tool mapping. The Pi adapter does not expose Google's allowed-function-name restriction, so named function choice is absent.

Their builders emit only temperature, max output tokens, tools/function-calling mode, and thinking configuration ([google-generative-ai.ts:355](../pi-agent/packages/ai/src/api/google-generative-ai.ts#L355), [google-vertex.ts:454](../pi-agent/packages/ai/src/api/google-vertex.ts#L454)). `streamSimple()` does not forward direct tool choice ([google-generative-ai.ts:296](../pi-agent/packages/ai/src/api/google-generative-ai.ts#L296), [google-vertex.ts:313](../pi-agent/packages/ai/src/api/google-vertex.ts#L313)). No sampling, format, parallel-tool, cache, identity, service-tier, truncation, store, or background option reaches the final request.

### `mistral-conversations`

The direct adapter can express `required` and named-function tool choice ([mistral-conversations.ts:33](../pi-agent/packages/ai/src/api/mistral-conversations.ts#L33), [mistral-conversations.ts:903](../pi-agent/packages/ai/src/api/mistral-conversations.ts#L903)), but `streamSimple()` does not copy it ([mistral-conversations.ts:180](../pi-agent/packages/ai/src/api/mistral-conversations.ts#L180)).

The wire serializer knows how to rename `topP`, `responseFormat`, and `parallelToolCalls` if those properties already exist ([mistral-conversations.ts:357](../pi-agent/packages/ai/src/api/mistral-conversations.ts#L357)). The actual payload builder never reads options for those properties; it only populates tools, temperature, max tokens, tool choice, reasoning, and prompt-cache key ([mistral-conversations.ts:498](../pi-agent/packages/ai/src/api/mistral-conversations.ts#L498)). Serializer-only key renaming is therefore **not** support for Responses `text.format`, `top_p`, or `parallel_tool_calls`.

### `bedrock-converse-stream`

The direct adapter supports `auto|any|none|{type:"tool",name}` and maps these to Bedrock tool configuration ([bedrock-converse-stream.ts:69](../pi-agent/packages/ai/src/api/bedrock-converse-stream.ts#L69), [bedrock-converse-stream.ts:997](../pi-agent/packages/ai/src/api/bedrock-converse-stream.ts#L997)). `required` can map to `any`; named function can map to Bedrock `tool`. `streamSimple()` does not carry tool choice ([bedrock-converse-stream.ts:461](../pi-agent/packages/ai/src/api/bedrock-converse-stream.ts#L461)).

The final command emits max tokens and temperature, model-specific reasoning fields, cache points, and optional direct `requestMetadata` ([bedrock-converse-stream.ts:234](../pi-agent/packages/ai/src/api/bedrock-converse-stream.ts#L234), [bedrock-converse-stream.ts:1111](../pi-agent/packages/ai/src/api/bedrock-converse-stream.ts#L1111)). It has no format, parallel-tool, top-p, service-tier, truncation, background, or store mapping. Bedrock `requestMetadata` is not a valid substitute for Responses storage metadata or safety identity.

### `pi-messages`

The Pi Messages wire explicitly carries temperature, max tokens, reasoning, cache retention, session ID, and `auto|none|required|named-function` tool choice ([pi-messages.ts:31](../pi-agent/packages/ai/src/api/pi-messages.ts#L31), [pi-messages.ts:365](../pi-agent/packages/ai/src/api/pi-messages.ts#L365)). Its `streamSimple()` explicitly reads a runtime direct `toolChoice`, so this is achievable without changing that builder, but the property is still absent from the common TypeScript contract ([pi-messages.ts:421](../pi-agent/packages/ai/src/api/pi-messages.ts#L421)). No other audited Responses control is included in the Pi Messages request payload.

## LuckyToken current behavior and concrete losses

LuckyToken validates and constructs `ModelsSimpleStreamOptions` in the Responses client adapter ([request.ts:775](../src/protocols/openai-responses/request.ts#L775), [request.ts:2161](../src/protocols/openai-responses/request.ts#L2161)). The current behavior is:

| Responses field | Current Semantic Conversion behavior | Correctness assessment |
|---|---|---|
| `text.format` | Never parsed or projected. | Silent loss of a required output-schema contract; must project or fail. |
| `parallel_tool_calls` | Never parsed; rendered response always says `true`. | Incorrect for client `false`; final Provider request and response echo both lose it ([response.ts:706](../src/protocols/openai-responses/response.ts#L706)). |
| `tool_choice:"required"` | Parsed as `"required"`, but `applyToolChoiceFilter()` has no required branch, so it is silently omitted. | Critical semantic loss ([request.ts:726](../src/protocols/openai-responses/request.ts#L726), [request.ts:2099](../src/protocols/openai-responses/request.ts#L2099)). |
| named `tool_choice` | Parsed as `forced`, then deliberately dropped with a degradation notice. | Avoidable loss for OpenAI Completions/Responses, Anthropic, Mistral, Bedrock, and Pi Messages targets, all of whose direct builders support a named tool. |
| `max_output_tokens` | Mapped to `options.maxTokens`. | Exact only for some targets. Codex drops it; Responses/Azure raise sub-16 values; Anthropic/Bedrock can add a reasoning budget beyond the Responses combined cap ([request.ts:2216](../src/protocols/openai-responses/request.ts#L2216)). |
| `temperature` | Mapped to `options.temperature`. | Generally correct; Anthropic may legitimately omit it when thinking/model compatibility forbids it. |
| `top_p` | Put in `options.samplingParams.top_p`. | Reaches only OpenAI Completions/Responses/Azure; silently ignored by every other adapter ([request.ts:2223](../src/protocols/openai-responses/request.ts#L2223), [types.ts:181](../pi-agent/packages/ai/src/types.ts#L181)). |
| `reasoning.effort` | Converted to Pi's generic reasoning level. | Portable but sometimes approximate. Explicit `none` and absence collapse to the same value, and `reasoning.summary` / deprecated `generate_summary` are ignored ([request.ts:674](../src/protocols/openai-responses/request.ts#L674)). |
| `truncation` | Never parsed. | Silent loss. `auto` changes input-history semantics and must not be treated as equivalent to omission. |
| `service_tier` | Never parsed. | Operational loss; map on capable OpenAI-family targets, otherwise omit with a warning. |
| `prompt_cache_key` | Never parsed. | Silent loss of cache affinity. It should be considered as a source for Pi `sessionId` only under an explicit cache/affinity contract. |
| `prompt_cache_retention` | Maps `"in-memory"` and `"24h"` to Pi short/long. | Bug: pinned official SDK spells the first value `"in_memory"`; current code rejects the valid spelling and accepts the wrong one ([request.ts:864](../src/protocols/openai-responses/request.ts#L864), [responses.d.ts:6236](../node_modules/openai/resources/responses/responses.d.ts#L6236)). |
| `metadata` | String entries are retained for local response echo. | Correct as response annotation, but not Provider metadata. Do not conflate it with model-visible semantics ([request.ts:2256](../src/protocols/openai-responses/request.ts#L2256)). |
| `user` / `safety_identifier` | Mapped to `options.metadata.user_id`. | Reaches Anthropic only; silently ignored by other adapters ([request.ts:875](../src/protocols/openai-responses/request.ts#L875), [request.ts:2229](../src/protocols/openai-responses/request.ts#L2229)). |
| `background:true` | Explicit conversion error. | Correct until a target adapter and deferred lifecycle implement it end to end ([request.ts:839](../src/protocols/openai-responses/request.ts#L839)). |
| `store` | Type-checked; Responses-owned session state applies local persistence policy rather than forwarding it to the model Provider. | Correct layer ownership for semantic conversion; this is not a Pi model request option ([session-state.ts:484](../src/protocols/openai-responses/session-state.ts#L484)). |
| `conversation` / `prompt` | Any defined value is an explicit conversion error. | Rejecting non-null values is correct until local resolution or native preservation owns them; rejecting `null` is a parser bug because the SDK defines null as absence. |
| `include`, `top_logprobs`, `context_management`, `stream_options`, `text.verbosity` | Not explicitly validated or projected. | Silent protocol loss. Some are response-shape or lifecycle controls rather than model semantics, but each recognized field still needs direct handling, warning, or failure. |
| hosted tools (`web_search`, `file_search`, `computer`, MCP, shell, etc.) | Most are skipped because Pi `Tool` represents caller-executed function/schema/grammar tools only. | Intentional capability degradation must be reported; a hosted Provider tool cannot be advertised as a locally executable Pi tool ([types.ts:480](../pi-agent/packages/ai/src/types.ts#L480), [request.ts:661](../src/protocols/openai-responses/request.ts#L661)). |

The boundary correctly rejects `max_output_tokens:0`; the remaining sub-16 problem is target-specific because the Pi OpenAI Responses/Azure builders silently raise positive values below 16 rather than letting the selected target reject them.

## Confirmed Responses edge contract drift

These failures occur before Provider capability mapping and therefore need independent fixes:

- The official allowed-list choice is `{type:"allowed_tools", mode:"auto"|"required", tools:[...]}`. LuckyToken instead recognizes `{type:"allowed", allowed_tools:string[]}` and rejects the current SDK shape ([responses.d.ts:5866](../node_modules/openai/resources/responses/responses.d.ts#L5866), [request.ts:726](../src/protocols/openai-responses/request.ts#L726), [request.ts:806](../src/protocols/openai-responses/request.ts#L806)). It also cannot preserve `mode:"required"`.
- The SDK permits omitted `input`; this is meaningful for an instructions-only request (and for stateful request forms). LuckyToken currently requires a string or array unconditionally ([responses.d.ts:6169](../node_modules/openai/resources/responses/responses.d.ts#L6169), [request.ts:786](../src/protocols/openai-responses/request.ts#L786)). If LuckyToken intends to require self-contained requests, it should still allow an explicit empty input or instructions-only form under a documented local contract rather than misreporting the SDK shape.
- `metadata` must contain string values with the SDK's count/length bounds. LuckyToken silently removes non-string entries and does not enforce those bounds, converting an invalid request into a different valid response annotation instead of rejecting it ([shared.d.ts:134](../node_modules/openai/resources/shared.d.ts#L134), [request.ts:2257](../src/protocols/openai-responses/request.ts#L2257)).
- The valid cache-retention value is `"in_memory"`; current tests enshrine the wrong `"in-memory"` spelling. This is a test/spec drift, not merely a missing feature.

`ResponseCreateParamsBase` is the HTTP create surface audited here. Fields that exist only on a different Responses client-event/WebSocket shape must not be silently added to this contract.

## Response-side fidelity

The endpoint's response currently cannot honestly report which controls took effect:

- `parallel_tool_calls` is always rendered as `true`, including after a client requested `false` and the field was dropped ([response.ts:717](../src/protocols/openai-responses/response.ts#L717)).
- `tool_choice` is narrowed to the three string choices and every object choice is normalized to `"auto"`, although the SDK Response union allows allowed-list and specified-tool objects ([responses.d.ts:778](../node_modules/openai/resources/responses/responses.d.ts#L778), [response.ts:159](../src/protocols/openai-responses/response.ts#L159), [response.ts:676](../src/protocols/openai-responses/response.ts#L676)).
- `instructions` is always `null`; the converted top-level instruction is not echoed ([response.ts:713](../src/protocols/openai-responses/response.ts#L713)).
- `temperature` and `top_p` are echoed from request-local render state even when the selected adapter removes or ignores them. For example, non-OpenAI adapters ignore `top_p`, but the Responses response can still claim it took effect.
- `include` is not retained in render state, so the renderer cannot honor the requested optional-output projection. In particular, verified `reasoning.encrypted_content` is emitted whenever it is available, independently of whether the client requested that include ([response.ts:454](../src/protocols/openai-responses/response.ts#L454)).

The response should be built from a small request-local record of the **effective final Provider controls**, not directly from raw client intent and hard-coded defaults. If a target has no equivalent and the conversion degrades with a warning, the response must not echo the dropped value as effective.

## Design implications

The minimum coherent fix is not a Provider-name switch inside the Responses client adapter. The shared semantic request contract needs explicit, typed controls whose target mapping remains owned by each Pi adapter:

1. Add a typed generic tool choice capable of `auto|none|required|named`, and make each `streamSimple()` map it to its existing direct option. Fail before execution for named choice on Google/Codex until their adapters implement an equivalent restriction.
2. Add `parallelToolCalls?: boolean`. Map it to OpenAI-family/Mistral `parallel_tool_calls` and Anthropic `disable_parallel_tool_use`; Codex must stop hard-coding `true`. For targets without a proven control, reject `false` rather than silently allowing parallel calls.
3. Add a typed structured-output constraint distinct from tool argument schemas. Map Responses `text.format` to Responses `text.format`, Chat Completions/Mistral `response_format`, Anthropic `output_config.format`, and Google response MIME/schema configuration only where the pinned builder is updated and the target schema subset is validated. If strict schema adherence cannot be preserved, fail the conversion.
4. Add named `topP` rather than relying on OpenAI-only `samplingParams`; populate the corresponding native builder fields where supported.
5. Preserve the tri-state distinction between reasoning omitted, explicitly disabled, and enabled at a level. Define `max_output_tokens` as the combined Provider output ceiling and make thinking-budget adapters fit inside it rather than add to it.
6. Keep operational controls separate: service tier is OpenAI-family-specific; Responses metadata/store remain client-protocol lifecycle state; cache key/retention needs a narrow adapter-neutral cache contract; background requires full deferred fetch/cancel lifecycle, not just a body key.
7. Add end-to-end tests that assert the final Provider request, not merely the intermediate options. At minimum cover each supported API for required/named tool choice, `parallel_tool_calls:false`, structured JSON schema output, `top_p`, reasoning summary behavior, output-token ceilings, response echo, and incompatible-target failure/warning.

Until those typed mappings exist, placing explicitly converted, allow-listed keys into `samplingParams` is an acceptable narrow workaround only for the three builders that demonstrably merge it. Never copy the whole client body: the last-step merge can also overwrite authoritative fields such as `model`, `input/messages`, `stream`, and `store`. The workaround must not be presented as support for Anthropic, Google, Vertex, Mistral, Bedrock, Codex Responses, or Pi Messages.
