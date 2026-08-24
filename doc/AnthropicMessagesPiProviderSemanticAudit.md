# Anthropic Messages → Pi Provider Bidirectional Semantic Audit

Date: 2026-08-23

Status: implementation baseline for `@earendil-works/pi-ai` 0.84.2 and `@anthropic-ai/sdk` 0.91.1

Scope: Anthropic Messages as the Client Protocol after the request has committed to LuckyToken's Semantic Conversion lane. Provider Native and Local Native requests bypass this audit. OpenAI Responses source semantics are deliberately outside this document.

## Conclusion

The current Anthropic semantic path is valid only for a useful subset of ordinary text, base64 images, client tools, tool turns, temperature, a coarse reasoning request, and basic Pi response content. It does not yet prove the final Provider request for many recognized Anthropic controls, and it sometimes replaces source meaning with invented model-visible text.

The implementation therefore needs an Anthropic-owned Invocation and selective target projection. The existing converter first produces the strongest Pi IR/options; a complete Anthropic supplement then carries every remaining validated fact Pi cannot represent, without implying universal target support. The wrapper selects a target Adapter only when it has a proven mapping, that Adapter consumes only its supported subset, and the Anthropic executor centrally resolves unconsumed facts. The final Provider request after the Anthropic-owned `onPayload` is the request support endpoint; response conversion starts from Pi `AssistantMessage` and adds no raw Provider interception layer.

The most important release blockers are:

1. `stop_sequences`, every `tool_choice` form, `disable_parallel_tool_use`, and `output_config.format` are validated incompletely or dropped before final Provider construction.
2. `thinking.disabled`, `thinking.adaptive`, display omission/null/value, and effort omission/null/value collapse. Enabled thinking also lacks the required `budget_tokens < max_tokens` validation, while Pi may increase an Anthropic/Bedrock reasoning request's final output ceiling.
3. final-assistant prefill is changed into ordinary history, and unresolved tool calls may receive the invented text `No result — the tool call did not complete (interrupted or lost).` Both violate hard model-visible semantics.
4. URL images, binary/URL documents, rich search results, server-tool calls/results, caller identity, citations, cache attachment points, and tool-specific controls are rejected, flattened, omitted, or replaced by placeholders.
5. the response renderer hard-codes citations, container, stop details/sequence, inference geography, service tier, and server-tool usage to `null`; this is not evidence that the upstream Provider omitted those facts.

## Authority and method

The fixed usability decisions in `Spec/LuckyTokenAnthropicSemanticConversionArchitectureSpec.md` section 12.1 are normative. This audit records evidence and target dispositions; it does not redefine those decisions.

The source grammar is the pinned official Anthropic SDK `MessageCreateParamsBase`, `ContentBlockParam`, `ToolUnion`, `ThinkingConfigParam`, `ToolChoice`, and response/SSE types in `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts`. The target builders and response parsers are the pinned Pi 0.84.2 files in `node_modules/@earendil-works/pi-ai/dist/api`. LuckyToken's baseline behavior is in `src/protocols/anthropic/request.ts`, `tools.ts`, `response.ts`, and `sse.ts`.

The audit uses these dispositions:

- **Pi-native**: an audited Pi option/IR relationship already produces the exact final target field.
- **Project**: the Anthropic-owned projector can validate or write an exact target field at the final payload seam.
- **Fallback**: a documented, protocol-valid visible degradation is possible and must warn.
- **Fixed fallback**: a documented, protocol-valid degradation is required by the Anthropic contract and must report `degraded`, never exact application.
- **Omit**: an optional preference may be omitted with an explicit outcome and warning.
- **Fail**: the source requirement is hard or no honest target representation is known; fail before Provider dispatch.
- **Unavailable**: the Pi response parser discarded a response fact. The Anthropic response module must use only a source-protocol-defined null/default, warn/omit, or fail; it may not guess or intercept the raw Provider response.

## Request ownership matrix

| Anthropic source fact | Validation baseline | Current Pi behavior | Requirement | Authoritative owner | Required disposition |
|---|---|---|---|---|---|
| `model` | non-empty string | selector is resolved outside conversion | hard | runtime model resolution | resolved target model replaces selector only at the Provider boundary |
| `messages` roles | accepts `user`, `assistant`, and non-standard `system` | Pi messages; first message-level system text is promoted | hard | Pi context plus Anthropic supplement for exact source associations | standard grammar is `user|assistant`; reject message-level `system` in the current contract rather than silently widening privilege |
| top-level `system` string | string | Pi `systemPrompt` | hard | Pi context | validate final target representation; Project only when Pi loses structure |
| top-level `system` blocks | currently accepts text but drops block cache controls | joined into one string | cache preference plus hard text | Pi context + supplement | preserve text; retain each cache attachment separately; project or warn per target |
| `max_tokens` | non-negative integer; zero currently accepted | Pi `maxTokens`, plus source total ceiling retained as `supplement.outputTokenCeiling` | hard ceiling | Pi option + narrow ceiling fact | final Provider output ceiling must be `<=` Client value; fail when zero cannot produce a valid Provider request; if later context clamping leaves no room for an otherwise valid thinking budget, disable reasoning and warn |
| `temperature` | finite number; range not fully enforced | Pi `temperature` | preference | Pi options; Supplement copy is non-authoritative | Pi is the sole final writer; a retained source copy does not authorize reinsertion when Pi intentionally omits it for target incompatibility |
| `top_p` | finite number; range not fully enforced | untyped `samplingParams.top_p` | preference | supplement | per-target Project/Pi-native; never claim support from an intermediate option |
| `top_k` | non-negative integer | untyped `samplingParams.top_k` | preference | supplement | per-target Project; omit with warning when the target has no certified equivalent |
| `stop_sequences` | only array shape | dropped | preference | supplement | Project an exact target stop control when available; otherwise omit and warn; never inject prompt text or truncate the response |
| `stream` | boolean | response render state only | client response contract | Anthropic client state | JSON/SSE renderer; never project as Provider response semantics beyond Pi's required streaming transport |
| `metadata.user_id` | string/null/absence partially distinguished | Pi metadata reaches only some APIs | preference/abuse identity | supplement with Pi option candidate | validate exact final identity field or omit with warning; never map to unrelated billing metadata |
| `service_tier` | string/null shape only | dropped | preference | supplement | Project only to a certified capacity-tier field; otherwise omit/warn |
| `inference_geo` | string/null shape only | dropped | hard data-residency control when explicitly set | supplement | Project exact compatible geography or Fail |
| `container` | string/null shape only | dropped | target-bound continuation | supplement with provenance | restore only to a compatible target; otherwise discard opaque identity and warn while preserving visible content |
| top-level `cache_control` | ephemeral/ttl partly validated | optionally promoted to coarse Pi cache retention | preference | supplement | retain exact attachment/ttl; Pi-native only if final target is equivalent, else project or warn |
| `tool_choice.auto` | object shape only | dropped | exact auto; serial sub-control is degradable | supplement | map target auto exactly; unsupported serial allows target parallel behavior and warns |
| `tool_choice.any` | object shape only | dropped | degradable orchestration | supplement | map to target required/any when exact; otherwise target auto with all reachable tools plus warning |
| `tool_choice.tool` | object shape only | dropped | degradable orchestration, but tool identity is hard | supplement | map named restriction when exact; otherwise expose only the named tool with target auto plus warning; missing name fails |
| `tool_choice.none` | object shape only | dropped | degradable disable request | supplement | disable exactly when available; otherwise remove every controllable current-request tool capability and warn |
| `disable_parallel_tool_use` | not validated | dropped | degradable cardinality guarantee | supplement | project exact serial control when available; otherwise allow target parallel behavior plus warning |
| `output_config.effort` omission/null/value | omission and null collapse; unknown strings silently disappear | Pi reasoning option | preference | Pi options | map a concrete value once; accept certified `thinkingLevelMap`/compat mapping as Pi-native; otherwise omit and warn; projector does not remap it |
| `output_config.format` omission/null/schema | not retained | dropped | degradable structured-output contract when non-null | supplement | Project exact schema target control; otherwise JSON-object/schema-prompt fallback and warning; explicit null remains distinct from omission |
| `thinking` omission/disabled/enabled/adaptive | enabled budget partly validated; disabled/adaptive collapse | coarse Pi reasoning/budget | degradable generation intent | Anthropic reasoning + Client render state | preserve exact activation/budget/source identity; keep `display` only for Anthropic response rendering; exact mapping first, then fixed target-default/nearest fallback with warning |
| enabled `budget_tokens` | `>=1024` and `< max_tokens` | converted through a coarse budget ladder | hard source relationship; target-degradable after context clamping | Anthropic reasoning | reject an invalid source relationship; if context clamping later leaves no valid ceiling above the budget, disable reasoning and warn |
| historical `thinking.signature` | string required | Pi `thinkingSignature`, but synthetic Client provenance | replay-required | Anthropic reasoning/continuity | native replay only under compatible provenance; otherwise visible thinking plus bounded foreign carrier/fallback |
| historical `redacted_thinking.data` | string required | Pi redacted thinking/signature, synthetic provenance | replay-required | Anthropic reasoning/continuity | same attachment and validated provenance required |
| `luckytoken_continuity` v1 | absent in baseline | absent | replay-required extension | Anthropic continuity codec | closed-world bounded item-local decode/encode; malformed attachments warn individually |
| final assistant prefill | detected | degraded to ordinary history with notice | degradable continuation constraint | supplement plus Pi association | validate exact target continuation semantics; otherwise history fallback with warning |
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
| tool-use caller/cache | dropped | supplement association; infer `direct` only for an unambiguous ordinary Client tool, omit optional cache with warning, and Fail on ambiguous permission provenance |
| client `tool_result` nested content | text/image subset reaches Pi; structured facts flatten/drop | Pi tool relationship plus supplement associations; exact tool ID relationship is hard; nested content follows its own family rule |
| `tool_reference` | becomes Pi `addedToolNames` | Pi-native only for audited targets; otherwise supplement Project or Fail if the reference changes available tools |
| server-tool use | placeholder transcript | placeholder is prohibited; preserve typed block for compatible target or Fail |
| web search/fetch result | placeholder transcript | preserve typed result for compatible target or Fail/fallback only when complete visible result can be retained honestly |
| code/bash/text-editor/tool-search result | placeholder transcript | placeholder is prohibited; typed Project or Fail |
| ordinary client tool name/description/schema | Pi tool | Pi context; final target validation required |
| tool `strict` | Pi constrained sampling | Pi context plus supplement validation | Pi-native where exact; repair/project or Fail when source requires strictness |
| tool cache/callers/defer/eager/examples/type | validated shallowly then dropped | supplement per tool identity; redundant `type: custom`, nullable fields, cache, loading, streaming, and examples may warn/omit when the ordinary tool remains intact; ambiguous caller permissions still Fail |
| typed Anthropic server tools | treated as ordinary tool shapes or narrowed | supplement retains discriminated source contract; only project to a proven equivalent server-hosted tool |

No placeholder string may stand in for a server tool, server result, unresolved client tool result, document, citation, or opaque continuity value.

## Target request matrix

Legend: **P** = Pi-native or exact Project available after payload-shape certification; **M** = model/provider compatibility decision required; **D** = exact mapping when available, otherwise the documented fixed degradation; **O** = optional preference may warn and omit; **F** = no certified critical mapping, so fail.

| Target Pi API | max ceiling | sampling | stop | tool choice | serial tools | JSON schema | reasoning | identity/tier/geo | rich Anthropic blocks |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| CommandCode Private (`commandcode-private` custom payload) | P | M | D | D | D | D | M/D | O/F geo | M |
| unclaimed `anthropic-messages` | P | M | P | P | P | P | M | P | P where exact source wire is retained |
| `openai-completions` | P | M | P | M/D | M/D | M/D | M/D | M/F geo | M |
| `openai-responses` | P | M | D | P | P | P | M/D | M/F geo | M |
| `azure-openai-responses` | P | M | D | P | P | P | M/D | M/F geo | M |
| `openai-codex-responses` | M | M | D | M/D | D | M/D | M/D | M/F geo | M |
| `google-generative-ai` | P | P | P | P | D | P | M | O/F geo | M |
| `google-vertex` | P | P | P | P | D | P | M | O/F geo | M |
| `mistral-conversations` | P | M | P | P | P | P | M | O/F geo | M |
| Bedrock Claude family | P | M | P | P | D | M/D | M/D | O/F geo | M |
| Bedrock non-Claude family | P | M | P | P | D | M/D | M/D | O/F geo | M |
| `pi-messages` | P | O | D | P | D | D | M/D | O/F geo | M |

Every **P**, **M**, or **D** cell requires its own Anthropic Client Wire → Pi → final Provider payload fixture. A Provider/API row is not enabled merely because another API uses a similar JSON key. `samplingParams` is evidence only for builders that actually merge it; it is never the semantic owner.

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

### CommandCode GOAT forced-tool direct wire-probe evidence

Direct upstream probes on 2026-08-23 against `commandcode-goat/deepseek/deepseek-v4-flash` established the current compatibility rule:

- ordinary non-streaming, streaming, and `tool_choice: auto` requests succeeded;
- forced `required` and named tool choices returned HTTP 400 with `Thinking mode does not support this tool_choice` under default, serial, `high`, and `max` reasoning cases;
- `thinking: {type: "disabled"}` and `enable_thinking: false` did not remove that conflict, while `reasoning_effort: "none"` was rejected as an invalid enum;
- the bounded fallback `tool_choice: auto` + only the named tool exposed + `parallel_tool_calls: false` selected the named tool in 9/9 probes across explicit, implicit, and direct-answer prompts.

The 9/9 result is availability evidence, not an exact guarantee or a completed certification-suite result. The fixed contract may use this fallback only with a `degraded` outcome and warning. The matching dated source-code comment is direct wire evidence and must remain until a replacement online run updates the Adapter, this audit, and the architecture specification together.

The independent Anthropic semantic-conversion online suite was rerun on
2026-08-24. GOAT accepted a final Provider body containing
`thinking: {type: "disabled"}`, but the response still contained thinking.
Therefore this target/model does not have a certified exact reasoning-disable
mapping. LuckyToken removes known reasoning controls, emits a `degraded`
warning, accepts the target default, and preserves any thinking actually
returned by the Provider. The corresponding online case asserts the final
Provider body and Client response independently.

### Current failure inventory and availability decision

This inventory reviews the failure families currently present in Anthropic validation, target projectors, supplement disposition, and response interpretation. Direction is stated explicitly so a request-side failure is not confused with a response-side failure.

| Direction/stage | Current failure family | Representative current sites | Required behavior | Configurable? |
|---|---|---|---|---|
| Request: Client parsing | invalid source object, enum, numeric relationship, schema, duplicate identity, or orphan tool result | request/tool/supplement validation | Fail as an invalid request before upstream dispatch | no |
| Request or response, independently | unknown Client content or unknown Pi response content | existing Anthropic conversion policy | Keep the existing independent `error|ignore` policies | already exists |
| Request: Provider projection | unsupported forced `any` or named choice | CommandCode Private and GOAT compatibility guards | Bounded auto fallback plus `degraded` warning | no |
| Request: Provider projection | unsupported serial-tool guarantee | CommandCode Private, Codex Responses, Google, Bedrock, Pi Messages | Allow target parallel behavior plus `degraded` warning | no |
| Request: Client parsing/projection | missing named tool or tool filtering that breaks history | source validation and all tool projectors | Fail; do not invent a tool or corrupt history | no |
| Request: Provider projection | unsupported `tool_choice.none` | target projectors without exact disable | Remove every controllable current-request tool capability and warn | no |
| Request: Provider projection | unsupported `stop_sequences` | any target without an exact stop control | Omit the field and warn; do not inject a prompt instruction or truncate the response | no |
| Request: Provider projection | unsupported structured output | CommandCode Private, Pi Messages, selected Bedrock/model families | JSON-object/schema-prompt fallback plus warning | no |
| Request: Provider projection | absent or malformed final output-token field | all target payload validators | Fail before dispatch; never exceed the Client ceiling | no |
| Request: Provider projection | explicit inference geography without an exact target control | all non-native projectors | Fail before dispatch as a data-residency constraint | no |
| Request: Provider projection | explicit reasoning disable on a non-reasoning model | target reasoning initial checks | Exact success when no reasoning-enabling field remains | no |
| Request: Provider projection | unsupported reasoning disable on a reasoning model | target reasoning initial checks | Remove enabling controls, accept target default, and warn | no |
| Request: Provider projection | unsupported exact thinking budget or adaptive mode | target reasoning initial checks | Use the strongest certified target reasoning mode or ordinary generation and warn | no |
| Request: Provider projection | context-safe final ceiling leaves no room above an otherwise valid thinking budget | Anthropic Messages and Bedrock projectors | Disable reasoning for that request, preserve the final ceiling, and warn | no |
| Request: Pi option mapping / Provider projection | unsupported effort control | Pi Provider Adapter and target compatibility mapping | Use the audited Pi-native mapping; otherwise omit the preference and warn | no |
| Request: Provider projection | sampling, cache, tier, identity, and other preferences without an equivalent | target projectors | Omit only the preference and warn | no |
| Request: Provider projection | final assistant prefill without certified continuation | supplement disposition/model validity | Preserve ordinary visible assistant history and warn | no |
| Request: Provider projection | optional citations/cache annotations, redundant custom type, nullable tool metadata, loading/streaming/examples | supplement disposition | Preserve ordinary visible content/tool, omit only the auxiliary fact, warn | no |
| Request: Provider projection | ambiguous `allowed_callers`, caller permission, `tool_reference`, or any unsupported server-tool capability/relationship | supplement disposition | Fail before dispatch because permissions, execution ownership, or relationships would be guessed | no |
| Request: Provider projection | URL/binary document or media, visible server result, or other model-visible content with no target representation | supplement disposition | Fail before dispatch; do not silently remove model input | no |
| Request: Provider projection | unknown API/model family with only optional supplement facts | projector registry | Leave Pi payload unchanged, omit those facts, and warn | no |
| Request: Provider projection | unknown API/model family with a critical supplement fact | projector registry | Fail before dispatch | no |
| Request: Provider projection | selected projector receives an unaudited Pi payload shape | payload validation | Fail before dispatch; this is an internal compatibility fault | no |
| Response: Client rendering | missing optional citation, usage, container, tier, or refusal auxiliary detail | Anthropic response module | Emit strongest legal Anthropic response and warn | no |
| Response: Client rendering | known stop/refusal terminal with retained visible response but lost optional detail | Anthropic response module | Map legal terminal/fallback and warn | no |
| Response + next-request replay | `pause_turn` or replay/server-tool state lost from Pi | Anthropic response module | Fail when valid continuation cannot be reconstructed | no |
| Next-request replay | malformed, incompatible, or model-switched opaque continuity | continuity codec/reasoning replay | Drop only opaque state, keep visible history, warn | no |

Every row marked `yes` receives its own Anthropic Advanced Setting and defaults to the documented best-effort behavior. These settings do not weaken malformed-source validation, output ceilings, geography, caller permissions, tool relationships, or payload-shape checks.

## Response audit

The Anthropic response module starts at Pi `AssistantMessage`; it does not receive raw Provider responses. Pi IR can retain ordered text, thinking, tool calls, response/provider/API/model provenance, a response ID, `rawStopReason`, `endTurn`, basic usage, reasoning/cache counts, and signatures on thinking/text/tool-call attachment points. It has no general fields for Anthropic citations, server-tool blocks, container, stop details, matched stop sequence, inference geography, service tier, or server-tool usage. The Provider-response column below is dependency evidence explaining where a Pi fact originated, not a runtime input to Anthropic response conversion.

| Provider response fact | Pi 0.84.2 retention | Baseline Anthropic output | Required response disposition | Next-request replay |
|---|---|---|---|---|
| response ID/API/provider/model | retained | ID used; client selector intentionally echoed as model | exact | provenance feeds continuity compatibility |
| text | retained | exact text, citations forced null | exact text; citations handled separately | visible history |
| text citations | generally discarded | `null` | preserve visible text, use the Anthropic-defined nullable representation, and warn when citation provenance was unavailable; fail only if a retained relationship makes citations required | response-only unless client returns citations as history semantics |
| thinking text | retained | Anthropic thinking block | exact visible thinking; when request `display` is `omitted`, emit `thinking: ""` instead | yes |
| Anthropic thinking signature/redacted data | retained on Pi thinking for Anthropic/Claude Bedrock | currently emitted as standard Anthropic fields without real provenance test | standard field only for certified compatible source; when ordinary thinking has no signature emit `signature: ""` plus warning and treat it as absent on replay; never empty redacted data | yes, same block |
| Google/Vertex text/thinking/tool signature | retained at Pi attachment-specific fields | text/tool signatures dropped; thinking may masquerade as Anthropic signature | item-local foreign continuity envelope | yes, same attachment |
| Responses/Azure/Codex reasoning state | retained in Pi signature-like fields/identity | incompletely rendered | item-local foreign continuity envelope; never `thinking.signature` | yes |
| Chat-Completions reasoning details | provider/model-dependent on thinking/tool calls | incompletely rendered | target-aware certified carrier or visible fallback | yes when replay contract requires |
| client tool call | retained | exact id/name/input; caller forced direct | exact tool call; caller disposition separate | yes |
| caller identity | generally discarded | forced `{type:"direct"}` | direct is valid only when proved; otherwise unavailable and critical where caller changes permissions/relationships | yes when required by server-tool relationship |
| server-tool calls/results and container uploads | not representable in Pi content union | unsupported or normalized | unavailable; fail if Pi retained evidence of a critical non-client-tool relationship, otherwise bounded loss per target audit | usually yes for continuation |
| container | discarded | `null` | null only when target response contract proves absence; otherwise unavailable notice | target-bound replay when retained through a certified future Pi field only |
| ordinary end/max/tool stop | retained as normalized `stopReason`; raw value often retained | `end_turn|max_tokens|tool_use` | target-aware exact mapping | response-only except tool relationship |
| `stop_sequence` + matched sequence | raw reason retained; matched sequence discarded | normalized `end_turn`, sequence null | when exact Anthropic `stop_sequence` cannot be constructed, preserve the already-stopped visible content, normalize to the legal `end_turn`/null fallback, and warn rather than fail the response | response-only |
| `pause_turn` | Anthropic parser maps to stop and retains raw reason | normalized `end_turn` | render `pause_turn` only with a valid continuation contract; otherwise critical failure | yes |
| `refusal` + details | Anthropic parser usually turns it into an upstream error; a committed Pi message may retain raw refusal with visible content but lose details | ordinary success renderer does not currently accept it | preserve the upstream error when no committed message exists; otherwise render Anthropic `refusal`, use nullable `stop_details` when details are unavailable, and warn rather than relabel it as ordinary success | no ordinary history |
| input/output usage | retained | exact or atomic fail-open zero fallback | exact retained counts; malformed usage may use documented atomic observability fallback | response-only |
| cache read/write/1h | retained partly | mapped | exact retained split only | response-only |
| thinking usage | retained partly | mapped when valid | exact retained value only | response-only |
| inference geo/service tier/server-tool usage | discarded | forced null | target-defined null only when absence is proved; otherwise unavailable warning | response-only |

## Pi response attachment baseline

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

This table is a test-routing baseline, not a runtime response registry or support claim. Ordinary rendering tests start at Pi `AssistantMessage`; exact replay support additionally requires Provider response fixture → Pi `AssistantMessage` → Anthropic JSON/SSE → next complete-history Client request → final Provider request.

## Required red and final-wire fixtures

The first failing request fixtures cover:

- exact stop sequences plus unsupported-target omission/warning with no prompt injection or response truncation;
- exact any/named/none/auto tool choice, fixed fallbacks, and serial-tool behavior;
- JSON Schema output;
- top-p/top-k on non-OpenAI targets;
- thinking omission, disable, enabled exact budget, adaptive, display omission/null/value, and effort omission/null/value;
- total output ceiling with reasoning;
- final assistant prefill;
- native and foreign full-history provenance;
- every current placeholder/flattening path listed above;
- dependency isolation from OpenAI Responses semantic modules.

The first response fixtures start at Pi `AssistantMessage` and cover `thinking.display: "omitted"`, missing-signature `""` fallback, warning fallbacks for citations and safely representable stop/refusal loss, and failing cases for caller ambiguity, server tools/results, container continuation, `pause_turn`, unknown terminal states, and replay-required loss. They also cover complete usage, all signature attachment points, JSON rendering, SSE deltas, and next-history replay.

## Online certification boundary

Direct online certification uses three independent scripts and fixed selectors:

- `commandcode-private/deepseek/deepseek-v4-flash`;
- `opencode-go/deepseek-v4-flash`;
- `commandcode-goat/deepseek/deepseek-v4-flash`.

Those scripts construct Anthropic Messages requests directly and assert the captured final Provider body, returned Anthropic JSON/SSE, and at least one complete-history replay. They do not use diagnostics as an oracle. Real-agent certification is separate and uses only Claude Code/Claude CLI; Codex CLI cannot issue Anthropic Messages Client requests and is excluded.
