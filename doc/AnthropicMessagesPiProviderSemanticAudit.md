# Anthropic Messages → Pi Provider Bidirectional Semantic Audit

Date: 2026-08-23

Status: implementation baseline for `@earendil-works/pi-ai` 0.84.2 and `@anthropic-ai/sdk` 0.91.1

Scope: Anthropic Messages as the Client Protocol after the request has committed to LuckyToken's Semantic Conversion lane. Provider Native and Local Native requests bypass this audit. OpenAI Responses source semantics are deliberately outside this document.

## Conclusion

The current Anthropic semantic path is valid only for a useful subset of ordinary text, base64 images, client tools, tool turns, temperature, a coarse reasoning request, and basic Pi response content. It does not yet prove the final Provider request for many recognized Anthropic controls, and it sometimes replaces source meaning with invented model-visible text.

The implementation therefore needs an Anthropic-owned Invocation and target projectors. Pi IR remains the conversation carrier; a complete Anthropic supplement retains validated facts that Pi cannot represent; the final Provider request after the kernel-owned `onPayload` is the support endpoint. The response direction requires a separate target-aware interpretation because request payload projection cannot recover facts discarded by a Pi response parser.

The most important release blockers are:

1. `stop_sequences`, every `tool_choice` form, `disable_parallel_tool_use`, and `output_config.format` are validated incompletely or dropped before final Provider construction.
2. `thinking.disabled`, `thinking.adaptive`, display omission/null/value, and effort omission/null/value collapse. Enabled thinking also lacks the required `budget_tokens < max_tokens` validation, while Pi may increase an Anthropic/Bedrock reasoning request's final output ceiling.
3. final-assistant prefill is changed into ordinary history, and unresolved tool calls may receive the invented text `No result — the tool call did not complete (interrupted or lost).` Both violate hard model-visible semantics.
4. URL images, binary/URL documents, rich search results, server-tool calls/results, caller identity, citations, cache attachment points, and tool-specific controls are rejected, flattened, omitted, or replaced by placeholders.
5. the response renderer hard-codes citations, container, stop details/sequence, inference geography, service tier, and server-tool usage to `null`; this is not evidence that the upstream Provider omitted those facts.

## Authority and method

The source grammar is the pinned official Anthropic SDK `MessageCreateParamsBase`, `ContentBlockParam`, `ToolUnion`, `ThinkingConfigParam`, `ToolChoice`, and response/SSE types in `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts`. The target builders and response parsers are the pinned Pi 0.84.2 files in `node_modules/@earendil-works/pi-ai/dist/api`. LuckyToken's baseline behavior is in `src/protocols/anthropic/request.ts`, `tools.ts`, `response.ts`, and `sse.ts`.

The audit uses these dispositions:

- **Pi-native**: an audited Pi option/IR relationship already produces the exact final target field.
- **Project**: the Anthropic-owned projector can validate or write an exact target field at the final payload seam.
- **Fallback**: a documented, protocol-valid visible degradation is possible and must warn.
- **Omit**: an optional preference may be omitted with an explicit outcome and warning.
- **Fail**: the source requirement is hard or no honest target representation is known; fail before Provider dispatch.
- **Unavailable**: the Pi response parser discarded a response fact. The response interpreter must use only a source-protocol-defined null/default, warn/omit, or fail; it may not guess.

## Request ownership matrix

| Anthropic source fact | Validation baseline | Current Pi behavior | Requirement | Authoritative owner | Required disposition |
|---|---|---|---|---|---|
| `model` | non-empty string | selector is resolved outside conversion | hard | runtime model resolution | resolved target model replaces selector only at the Provider boundary |
| `messages` roles | accepts `user`, `assistant`, and non-standard `system` | Pi messages; first message-level system text is promoted | hard | Pi context plus Anthropic supplement for exact source associations | standard grammar is `user|assistant`; reject message-level `system` in the current contract rather than silently widening privilege |
| top-level `system` string | string | Pi `systemPrompt` | hard | Pi context | validate final target representation; Project only when Pi loses structure |
| top-level `system` blocks | currently accepts text but drops block cache controls | joined into one string | cache preference plus hard text | Pi context + supplement | preserve text; retain each cache attachment separately; project or warn per target |
| `max_tokens` | non-negative integer; zero currently accepted | Pi `maxTokens` | hard ceiling | Pi option + reasoning validation | final Provider output ceiling must be `<=` Client value; no minimum raising or reasoning-budget addition |
| `temperature` | finite number; range not fully enforced | Pi `temperature` | preference | supplement until target validation | Pi-native when exact; repair with warning when Pi is wrong; omit only when source/target permits |
| `top_p` | finite number; range not fully enforced | untyped `samplingParams.top_p` | preference | supplement | per-target Project/Pi-native; never claim support from an intermediate option |
| `top_k` | non-negative integer | untyped `samplingParams.top_k` | preference | supplement | per-target Project; omit with warning when the target has no certified equivalent |
| `stop_sequences` | only array shape | dropped | hard output constraint | supplement | Project to exact target stop control or Fail |
| `stream` | boolean | response render state only | client response contract | Anthropic client state | JSON/SSE renderer; never project as Provider response semantics beyond Pi's required streaming transport |
| `metadata.user_id` | string/null/absence partially distinguished | Pi metadata reaches only some APIs | preference/abuse identity | supplement with Pi option candidate | validate exact final identity field or omit with warning; never map to unrelated billing metadata |
| `service_tier` | string/null shape only | dropped | preference | supplement | Project only to a certified capacity-tier field; otherwise omit/warn |
| `inference_geo` | string/null shape only | dropped | hard data-residency control when explicitly set | supplement | Project exact compatible geography or Fail |
| `container` | string/null shape only | dropped | target-bound continuation | supplement with provenance | restore only to a compatible target; otherwise discard opaque identity and warn while preserving visible content |
| top-level `cache_control` | ephemeral/ttl partly validated | optionally promoted to coarse Pi cache retention | preference | supplement | retain exact attachment/ttl; Pi-native only if final target is equivalent, else project or warn |
| `tool_choice.auto` | object shape only | dropped | hard when explicit | supplement | map target auto and serial constraint exactly |
| `tool_choice.any` | object shape only | dropped | hard | supplement | map to target required/any or Fail |
| `tool_choice.tool` | object shape only | dropped | hard | supplement | map named target restriction or Fail |
| `tool_choice.none` | object shape only | dropped | hard | supplement | disable tools at final target or Fail |
| `disable_parallel_tool_use` | not validated | dropped | hard cardinality guarantee | supplement | project the exact target serial-tool control or Fail |
| `output_config.effort` omission/null/value | omission and null collapse; unknown strings silently disappear | coarse Pi reasoning | preference except where target contract makes it hard | Anthropic reasoning | preserve tri-state; target reasoning projector validates/repairs/omits explicitly |
| `output_config.format` omission/null/schema | not retained | dropped | hard structured-output contract when non-null | supplement | Project exact schema target control or Fail; explicit null remains distinct from omission |
| `thinking` omission/disabled/enabled/adaptive | enabled budget partly validated; disabled/adaptive collapse | coarse Pi reasoning/budget | explicit disable and display omitted are hard; enabled/adaptive generation intent is target-audited | Anthropic reasoning | preserve exact activation, display, effort, budget, and source identity; target-specific outcome |
| enabled `budget_tokens` | `>=1024`, but no `< max_tokens` check | converted through a coarse budget ladder | hard relationship | Anthropic reasoning | reject invalid relationship; never widen Client total ceiling |
| historical `thinking.signature` | string required | Pi `thinkingSignature`, but synthetic Client provenance | replay-required | Anthropic reasoning/continuity | native replay only under compatible provenance; otherwise visible thinking plus bounded foreign carrier/fallback |
| historical `redacted_thinking.data` | string required | Pi redacted thinking/signature, synthetic provenance | replay-required | Anthropic reasoning/continuity | same attachment and validated provenance required |
| `luckytoken_continuity` v1 | absent in baseline | absent | replay-required extension | Anthropic continuity codec | closed-world bounded item-local decode/encode; malformed attachments warn individually |
| final assistant prefill | detected | degraded to ordinary history with notice | hard continuation constraint | supplement plus Pi association | validate exact target continuation semantics or Fail |
| unresolved tool call | baseline can synthesize a tool result | invented model-visible repair | hard relationship | Pi context conversion | remove repair; preserve exact legal history or Fail |

## Content and tool audit

| Source family | Current behavior | Intended owner and outcome |
|---|---|---|
| text text | Pi text | Pi context; exact ordered text required |
| text citations/cache | citations/cache dropped | supplement association; Project to exact nested target block, otherwise warn/fail according to citation/cache requirement |
| base64 image | Pi image | Pi context; validate final target media support |
| URL image | rejected | supplement/association; Project for targets with URL-image input, otherwise Fail rather than inventing fetched data |
| container upload | unknown/rejected | supplement/association; compatible target-bound Project or Fail |
| document `content` | text children flattened | Pi visible text plus supplement for document semantics; exact document mapping where certified, otherwise explicit visible fallback/warning only if citations/context are not required |
| document `text` | flattened to text | same as above |
| document `base64`/`url` | rejected as resolver-dependent | direct target Project when the target accepts the source; no server fetch or invented content; otherwise Fail |
| document title/context/citations/cache | dropped | supplement association; Project or explicit loss disposition |
| search result source/title/content/citations/cache | baseline expects wrong string `content` and flattens it | preserve official structured block in supplement; Project or honest visible fallback with warning when safe |
| client `tool_use` id/name/input | Pi tool call | Pi context plus association; exact relationship is hard |
| tool-use caller/cache | dropped | supplement association; Project only to targets with an equivalent caller/cache contract |
| client `tool_result` nested content | text/image subset reaches Pi; structured facts flatten/drop | Pi tool relationship plus supplement associations; exact tool ID relationship is hard; nested content follows its own family rule |
| `tool_reference` | becomes Pi `addedToolNames` | Pi-native only for audited targets; otherwise supplement Project or Fail if the reference changes available tools |
| server-tool use | placeholder transcript | placeholder is prohibited; preserve typed block for compatible target or Fail |
| web search/fetch result | placeholder transcript | preserve typed result for compatible target or Fail/fallback only when complete visible result can be retained honestly |
| code/bash/text-editor/tool-search result | placeholder transcript | placeholder is prohibited; typed Project or Fail |
| ordinary client tool name/description/schema | Pi tool | Pi context; final target validation required |
| tool `strict` | Pi constrained sampling | Pi context plus supplement validation | Pi-native where exact; repair/project or Fail when source requires strictness |
| tool cache/callers/defer/eager/examples/type | validated shallowly then dropped | supplement per tool identity; target-specific Project/Omit/Fail |
| typed Anthropic server tools | treated as ordinary tool shapes or narrowed | supplement retains discriminated source contract; only project to a proven equivalent server-hosted tool |

No placeholder string may stand in for a server tool, server result, unresolved client tool result, document, citation, or opaque continuity value.

## Target request matrix

Legend: **P** = Pi-native or exact Project available after payload-shape certification; **M** = model/provider compatibility decision required; **O** = optional preference may warn and omit; **F** = no certified hard mapping, so fail.

| Target Pi API | max ceiling | sampling | stop | tool choice | serial tools | JSON schema | reasoning | identity/tier/geo | rich Anthropic blocks |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| CommandCode Private (`commandcode-private` custom payload) | P | M | F | M | F | F | M | O/F geo | M |
| unclaimed `anthropic-messages` | P | M | P | P | P | P | M | P | P where exact source wire is retained |
| `openai-completions` | P | M | P | P | P | M | M | M/F geo | M |
| `openai-responses` | P | M | F | P | P | P | M | M/F geo | M |
| `azure-openai-responses` | P | M | F | P | P | P | M | M/F geo | M |
| `openai-codex-responses` | M | M | F | M | P | M | M | M/F geo | M |
| `google-generative-ai` | P | P | P | P | F unless certified | P | M | O/F geo | M |
| `google-vertex` | P | P | P | P | F unless certified | P | M | O/F geo | M |
| `mistral-conversations` | P | M | P | P | P | P | M | O/F geo | M |
| Bedrock Claude family | P | M | P | P | F unless certified | M | M | O/F geo | M |
| Bedrock non-Claude family | P | M | P | P | F unless certified | M | M | O/F geo | M |
| `pi-messages` | P | O | F | P | F | F | M | O/F geo | M |

Every **P** or **M** cell requires its own Anthropic Client Wire → Pi → final Provider payload fixture. A Provider/API row is not enabled merely because another API uses a similar JSON key. `samplingParams` is evidence only for builders that actually merge it; it is never the semantic owner.

### Pi 0.84.2 starting evidence

- CommandCode Private is not an `openai-completions` alias. Its registered `commandcode-private` Provider builds `{config, memory, taste, skills, permissionMode, threadId, params}` and exposes `onPayload` before validating and serializing that exact custom body. `params` supports model, system, messages, tools, max tokens, temperature, and reasoning effort, but has no stop, top-p/top-k, forced/serial-tool, or structured-output field.
- `anthropic-messages` builds `max_tokens`, temperature when compatible, tools, thinking, metadata, and direct tool choice, then calls `onPayload`. Its simple wrapper can add a thinking budget to max tokens, so the Anthropic Client ceiling requires explicit correction.
- `openai-completions` builds Chat messages/tools, max token field, temperature, tool choice and provider/model-specific reasoning, merges `samplingParams` last, then calls `onPayload` before transport.
- Responses and Azure Responses expose a final payload callback and merge selected simple options; target lifecycle and response-shape semantics still require separate certification.
- Codex Responses uses a distinct builder with hard-coded defaults and cannot inherit the generic Responses row.
- Google Generative AI and Vertex build separate native shapes (`generationConfig` versus `config`) and need separate registrations even where their semantics match.
- Mistral builds camel-case SDK payload fields and later serializes them to snake case. Projection must occur against the exact object passed to `onPayload`, not a guessed HTTP JSON shape.
- Bedrock passes an AWS `ConverseStreamCommandInput`-shaped object to `onPayload`; Claude and non-Claude reasoning fields differ.
- Pi Messages passes `{model, context, options}` and delegates Pi IR. It is not an arbitrary Provider-wire extension bag.

## Response audit

Pi `AssistantMessage` can retain ordered text, thinking, tool calls, response/provider/API/model provenance, a response ID, `rawStopReason`, `endTurn`, basic usage, reasoning/cache counts, and signatures on thinking/text/tool-call attachment points. It has no general fields for Anthropic citations, server-tool blocks, container, stop details, matched stop sequence, inference geography, service tier, or server-tool usage.

| Provider response fact | Pi 0.84.2 retention | Baseline Anthropic output | Required response disposition | Next-request replay |
|---|---|---|---|---|
| response ID/API/provider/model | retained | ID used; client selector intentionally echoed as model | exact | provenance feeds continuity compatibility |
| text | retained | exact text, citations forced null | exact text; citations handled separately | visible history |
| text citations | generally discarded | `null` | source-defined null only when absence is proved; otherwise unavailable warning/failure policy | response-only unless client returns citations as history semantics |
| thinking text | retained | Anthropic thinking block | exact visible thinking | yes |
| Anthropic thinking signature/redacted data | retained on Pi thinking for Anthropic/Claude Bedrock | currently emitted as standard Anthropic fields without real provenance test | standard field only for certified compatible source; otherwise item extension | yes, same block |
| Google/Vertex text/thinking/tool signature | retained at Pi attachment-specific fields | text/tool signatures dropped; thinking may masquerade as Anthropic signature | item-local foreign continuity envelope | yes, same attachment |
| Responses/Azure/Codex reasoning state | retained in Pi signature-like fields/identity | incompletely rendered | item-local foreign continuity envelope; never `thinking.signature` | yes |
| Chat-Completions reasoning details | provider/model-dependent on thinking/tool calls | incompletely rendered | target-aware certified carrier or visible fallback | yes when replay contract requires |
| client tool call | retained | exact id/name/input; caller forced direct | exact tool call; caller disposition separate | yes |
| caller identity | generally discarded | forced `{type:"direct"}` | direct is valid only when proved; otherwise unavailable and critical where caller changes permissions/relationships | yes when required by server-tool relationship |
| server-tool calls/results and container uploads | not representable in Pi content union | unsupported or normalized | unavailable; fail if Pi retained evidence of a critical non-client-tool relationship, otherwise bounded loss per target audit | usually yes for continuation |
| container | discarded | `null` | null only when target response contract proves absence; otherwise unavailable notice | target-bound replay when retained through a certified future Pi field only |
| ordinary end/max/tool stop | retained as normalized `stopReason`; raw value often retained | `end_turn|max_tokens|tool_use` | target-aware exact mapping | response-only except tool relationship |
| `stop_sequence` + matched sequence | raw reason retained; matched sequence discarded | normalized `end_turn`, sequence null | cannot claim exact matched sequence; fail when emitted by source and value is required, unless target contract supplies a safe null | response-only |
| `pause_turn` | Anthropic parser maps to stop and retains raw reason | normalized `end_turn` | render `pause_turn` only with a valid continuation contract; otherwise critical failure | yes |
| `refusal` + details | Anthropic parser turns it into error and usually prevents a committed message | ordinary success renderer does not receive it | upstream failure path; never normalize to success | no ordinary history |
| input/output usage | retained | exact or atomic fail-open zero fallback | exact retained counts; malformed usage may use documented atomic observability fallback | response-only |
| cache read/write/1h | retained partly | mapped | exact retained split only | response-only |
| thinking usage | retained partly | mapped when valid | exact retained value only | response-only |
| inference geo/service tier/server-tool usage | discarded | forced null | target-defined null only when absence is proved; otherwise unavailable warning | response-only |

## Response-parser attachment registry baseline

| Actual Pi API | Certified starting attachment point to test |
|---|---|
| `anthropic-messages` | thinking signature and redacted data on Pi thinking block |
| `bedrock-converse-stream` Claude | thinking signature on Pi thinking block |
| `bedrock-converse-stream` non-Claude | no signature assumed |
| `google-generative-ai` | thought signature may attach to Pi thinking, text, or tool call |
| `google-vertex` | same three categories, independent fixture |
| `openai-responses` | complete reasoning item state on Pi thinking and message identity/phase on Pi text |
| `azure-openai-responses` | same categories, independent Azure fixture |
| `openai-codex-responses` | same categories with Codex-specific fixture |
| `openai-completions` | visible reasoning and provider-specific reasoning state on thinking/tool-call blocks |
| `mistral-conversations` | visible structured thinking; no opaque signature assumed |
| `pi-messages` | delegated Pi text/thinking/tool-call fields |
| CommandCode Private | visible thinking; no opaque signature assumed until proved |

This registry is a test-routing baseline, not a support claim. Support requires Provider response fixture → Pi `AssistantMessage` → Anthropic JSON/SSE → next complete-history Client request → final Provider request.

## Required red and final-wire fixtures

The first failing request fixtures cover:

- exact stop sequences;
- any/named/none/auto tool choice and serial-tool guarantees;
- JSON Schema output;
- top-p/top-k on non-OpenAI targets;
- thinking omission, disable, enabled exact budget, adaptive, display omission/null/value, and effort omission/null/value;
- total output ceiling with reasoning;
- final assistant prefill;
- native and foreign full-history provenance;
- every current placeholder/flattening path listed above;
- dependency isolation from OpenAI Responses semantic modules.

The first failing response fixtures cover citations/caller, server tools/results, container uploads/container, stop sequence/details/pause/refusal, complete usage, all signature attachment points, JSON rendering, SSE deltas, and next-history replay.

## Online certification boundary

Direct online certification uses three independent scripts and fixed selectors:

- `commandcode-private/deepseek/deepseek-v4-flash`;
- `opencode-go/deepseek-v4-flash`;
- `commandcode-goat/deepseek/deepseek-v4-flash`.

Those scripts construct Anthropic Messages requests directly and assert the captured final Provider body, returned Anthropic JSON/SSE, and at least one complete-history replay. They do not use diagnostics as an oracle. Real-agent certification is separate and uses only Claude Code/Claude CLI; Codex CLI cannot issue Anthropic Messages Client requests and is excluded.
