# Anthropic Messages Semantic Conversion Architecture

Status: **CURRENT — projector-free Pi AI 0.86.1 boundary**

## 1. Contract

```text
Anthropic Messages Wire
  → Anthropic request converter
  → AnthropicSemanticInvocation { Pi Context, Pi options, reasoning/continuity }
  → Pi Models / Pi Provider
  → Pi AssistantMessage
  → Anthropic response renderer
  → Anthropic Messages Wire
```

The module has no target Provider registry, payload projector, projection supplement,
payload outcome union, or semantic `onPayload` lifecycle.

## 2. Positive request consumers

The converter consumes only:

```text
model, max_tokens, messages, system, stream, temperature, tools,
tool_choice, thinking, output_config
```

Within `output_config`, only `effort` is consumed. `format` remains unread and warns.
Unclaimed top-level fields are not shape-validated and produce bounded fail-open
warnings.

## 3. Invocation ownership

The invocation contains:

- Pi `Context` with the initial system prompt, messages, initial executable tool catalog,
  tool calls/results, images, and supported visible content;
- Pi common options: `maxTokens`, `temperature`, the neutral `toolChoice` union
  (`auto`, `none`, `required`, `{ type: "tool", name }`), and `parallelToolCalls`;
- Anthropic-owned thinking activation/effort/history and attachment-local continuity;
- Anthropic response state: selector, stream mode, direct tool names, and display policy;
- bounded notices.

The Client converter produces public `Context`, not `TranscriptContext`. Top-level
`system` remains `Context.systemPrompt`. Token-compatible message-level `system` text is
preserved at its original transcript position as Pi `SystemMessage`; content such as
images that Pi `SystemMessage` cannot represent remains a Client→Pi representability
failure. Model-dependent support is not inspected by the converter.

## 4. Field disposition ledger

| Source fact | Destination | Behavior |
| --- | --- | --- |
| top-level system text | `pi-context` | initial system prompt |
| Token-compatible message-level system text | `pi-context` | same-position Pi `SystemMessage`; target compatibility handled after model resolution |
| ordinary messages and supported images | `pi-context` | preserve model-visible content |
| tools, tool-use IDs, tool results | `pi-context` | invalid identity/relationship fails |
| `max_tokens` | `pi-common-option` | hard total output ceiling |
| `temperature` | `pi-common-option` | direct neutral Pi semantic |
| thinking disabled | `pi-common-option` | `reasoning: "off"` |
| enabled/adaptive thinking and effort | `pi-common-option` | select from resolved model metadata; optional Pi budget map |
| thinking signatures/redacted state | `client-render-or-continuity-state` + Pi content fields | provenance-compatible replay only |
| tool choice `auto`/`none`/`any`/named | `pi-common-option` | exact neutral control; the Provider adapter applies, safely ignores/omits, optionally reports a Provider-owned notice, or rejects if validity requires it |
| `disable_parallel_tool_use` | `pi-common-option` | neutral Pi `parallelToolCalls`; the Provider adapter applies or safely ignores/omits it, with a Provider-owned notice only when that adapter exposes one |
| ordinary tool definitions | `pi-context` | source-only extensions omitted with warning |
| typed server tools | `provider-private-omit-warning` | never misrepresented as Client-executable tools |
| URL image or unresolved binary document | `provider-private-omit-warning` when optional, otherwise `critical-failure` | never fabricate fetched content |
| document/search visible text | `named-degradation` | preserve visible text; omit metadata/citations with warning |
| final assistant prefill | `pi-context` visible history | retain as history; warn when prefill constraint is unavailable |
| `tool_reference` / mid-conversation tool update | `critical-failure` | Pi public Context cannot express it safely at this boundary |
| `top_p`, `top_k`, stop sequences, metadata, cache controls, service tier, container | `provider-private-omit-warning` | use Native Preservation for exact retention |
| `output_config.format` | `provider-private-omit-warning` | no neutral structured-output contract yet |
| `inference_geo` | `provider-private-omit-warning` unless configured as a mandatory residency constraint, then `critical-failure` | never guess a target field |

No fact is carried in a projection supplement, `samplingParams`, generic metadata,
diagnostics, or a raw extension bag.

## 5. Reasoning and continuity

Reasoning preparation operates only on cloned Pi Context/options. Omitted reasoning
preserves Provider default, disabled maps to `"off"`, and enabled levels are chosen from
the resolved model through Pi public helpers and `thinkingLevelMap`.

Opaque continuity is restored only when Provider/API/model provenance matches. On model
switch, opaque state is discarded while visible reasoning is retained through thinking
or assistant text. Attachments remain local to the original thinking/text/tool-call
block.

## 6. Execution and response

After Anthropic reasoning preparation, the semantic coordinator applies the shared
`preparePiContextForModel(model, context)` compatibility seam before freeze. Supported
mid-system text passes through unchanged. Unsupported pure-text mid-system entries
become same-position Pi `UserMessage` entries and emit
`pi_mid_system_degraded_to_user`; mid-system prompt/tool-state patch fields fail before
dispatch. Leading system messages are left intact.

The Anthropic semantic coordinator then invokes the neutral execution operation without
Provider callbacks in its options. Optional Provider request/response observation is
infrastructure-only, immutable, fail-open, and non-mutating.

The response renderer consumes only Pi `AssistantMessage` plus Anthropic-owned render
and continuity state. It emits legal Anthropic content blocks, stop reason, and usage;
it cannot recover Provider facts absent from Pi.

## 7. Certification

- request tests assert Anthropic Wire → Pi Context/options + Client state;
- response tests assert Pi `AssistantMessage` → Anthropic Wire;
- parser certification uses pinned Pi adapters;
- continuity tests replay the next complete-history request through the real pinned Pi
  Provider adapter and capture its unmodified request;
- CommandCode exact-wire assertions live with CommandCode Private;
- architecture tests prove projection/supplement directories, Provider-native imports,
  Client-created `TranscriptContext`, and semantic `onPayload` are absent.
