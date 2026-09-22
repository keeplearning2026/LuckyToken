# OpenAI Responses Semantic Conversion Architecture

Status: **CURRENT — projector-free clean upstream Pi AI 0.87.0 boundary**

## 1. Contract

```text
Responses Wire
  → Responses request converter
  → ResponsesSemanticInvocation { Pi Context, Pi options, reasoning/continuity }
  → Pi Models / Pi Provider
  → Pi AssistantMessage
  → Responses response renderer
  → Responses Wire
```

The module has no target Provider registry, payload projector, projection supplement,
payload outcome union, or semantic `onPayload` lifecycle. It never imports a Provider
request type or CommandCode Private implementation type.

## 2. Positive request consumers

The main converter consumes only:

```text
model, input, instructions, stream, previous_response_id, store,
reasoning, tools, tool_choice, parallel_tool_calls, max_output_tokens, temperature,
prompt_cache_retention
```

`previous_response_id` and `store` are consumed for Client session semantics only. They
are not Provider controls. `metadata` and every other unclaimed top-level field remain
unparsed and produce a bounded request-local warning.

## 3. Invocation ownership

The invocation contains:

- Pi `Context` with top-level `instructions` as `systemPrompt`, input-level
  `system`/`developer` messages preserved in transcript order as Pi `SystemMessage`,
  executable tools, tool calls, and results;
- upstream Pi 0.87 common options such as `maxTokens`, `temperature`,
  `cacheRetention`, selectable reasoning levels, and `toolChoice` `auto` / `none`;
  consumed non-structural controls without a Pi representation are omitted with warning;
- Responses-owned reasoning intent and attachment-local continuity candidates;
- Responses-owned Client-private state: stream mode, reversible namespace names, and
  freeform tool family;
- bounded conversion notices.

Client-private state never enters Pi Context/options. After execution, the adapter builds
an immediate response projection from the effective invocation plus that private state;
the projection is consumed once and is never persisted as request state.

## 4. Field disposition ledger

| Source fact | Destination | Behavior |
| --- | --- | --- |
| input messages, instructions, images | `pi-context` | preserve model-visible content; unresolved opaque references fail or warn only under the declared resolver policy |
| tools, call IDs, results | `pi-context` | identity/relationship loss fails |
| reasoning effort `none` | `client-warning-omit` | omit explicit disable, warn, request no Pi reasoning level, and let the selected Pi adapter determine resulting thinking behavior |
| enabled reasoning effort | `pi-common-option` | resolved model map + public Pi selection helpers |
| reasoning summary preference | `provider-private-omit-warning` | Pi common contract has no summary selector |
| historical reasoning and signatures | `client-render-or-continuity-state` + Pi content fields | restore only for compatible provenance; otherwise visible fallback/omit warning |
| `max_output_tokens` | `pi-common-option` | map to Pi `maxTokens`; Pi owns downstream output/reasoning budgeting |
| `temperature` | `pi-common-option` | direct Pi semantic; response projection reads the effective Pi option |
| `prompt_cache_retention` | `pi-common-option` | coarse Pi retention semantic |
| tool choice `auto`/`none` | `pi-common-option` | preserve through upstream Pi |
| tool choice `required`/named | `client-warning-omit` | retain the tool catalog, omit unsupported selection constraint, warn, and use Pi/Provider default |
| `allowed_tools` mode `auto` | `pi-context` + Pi `auto` | filter executable catalog before dispatch |
| `allowed_tools` mode `required` | `pi-context` + Client warning | filter executable catalog, omit unsupported required mode, warn |
| `parallel_tool_calls` | `client-warning-omit` | omit unsupported parallelism constraint with a bounded warning |
| hosted-tool choice | `provider-private-omit-warning` | no neutral Pi contract; exact wire retention requires Native Preservation |
| namespace declarations | `pi-context` + Client reverse map | reversible flattening; collision fails |
| unmatched historical namespace | `critical-failure` before Provider dispatch | prevents tool identity drift |
| `metadata` | `client-warning-ignore` | no accepted Pi or Client-state consumer; do not read its value |
| `previous_response_id`, `store` | `client-render-or-continuity-state` | Responses session lifecycle only |
| `top_p`, stop, response format, cache key, service tier, verbosity, truncation, include, safety identity | `provider-private-omit-warning` | not consumed until Pi has a neutral contract; use Native Preservation for exact wire retention |

No ledger destination is a supplement, `samplingParams`, generic metadata, diagnostics,
or `onPayload`.

## 5. Reasoning and continuity

Responses reasoning preparation may edit only cloned Pi Context/options. It may select a
Pi reasoning level, attach Pi `thinkingSignature`, `textSignature`, or
`thoughtSignature`, rebind compatible historical provenance, or convert visible thinking
to assistant text when the resolved target cannot accept historical thinking.

The reasoning adapter registry is a continuity codec over Pi fields. It has no
`projectPayload()` operation and cannot see Provider request objects.

## 6. Execution

The protocol execution coordinator prepares Responses-owned reasoning and then invokes
one shared Semantic Conversion execution operation. Outside the protocol tree, the
Pi Context compatibility wrapper runs exactly once before Profile credential binding and
retry, then freezes the final Pi invocation and delegates to raw execution.

The compatibility seam reads only Pi public Model/Context facts. For a
mid-conversation `SystemMessage`, `supportsMidConvoSystemMessages === true` returns the
Context by identity, including `sections`, `toolsAdded`, and `toolsRemoved`, so Pi keeps
ownership of finer Provider capability handling. For false/undefined support, pure-text
messages degrade to `UserMessage` and emit `pi_mid_system_degraded_to_user`. If a
mid-system lies between Pi ToolCall and the minimum matching ToolResult set needed to
close that exchange, the degraded user message is deferred until those results arrive.
This relocation is a bounded, explicitly warned availability degradation; compatibility
checks only the minimum conditions needed for that relocation and does not validate the
whole tool history. A user/assistant boundary or end-of-input before the required closure
fails. Mid-system prompt-section or tool-state patches also fail because role conversion
cannot preserve them. Leading system messages are not degraded.

Responses source conversion deliberately keeps a `system`/`developer` item between a
`function_call` and `function_call_output` as Pi `SystemMessage`; target compatibility is
not a Client grammar rule.

The neutral `src/execution.ts` module remains policy-free and only invokes
`Models.streamSimple()`. Protocol execution options contain no Provider callbacks.
Provider request observation is an optional infrastructure capability passed separately;
it copies a payload and never returns a replacement.

Removing observation must leave request bytes, Provider selection, response, and
terminal outcome unchanged.

## 7. Response conversion

The renderer accepts a Pi `AssistantMessage` and an immediate Responses response
projection. It restores text, thinking, function/custom calls, usage, and opaque
continuity only through defined Responses fields.

The projection reads `model` from the resolved selector, `temperature`, `tool_choice`,
and `tools` from the effective Pi invocation, and Responses-only tool identity from
Client-private state. Required fields without a Pi semantic use explicit adapter values:
`parallel_tool_calls=true`, `metadata={}`, `top_p=null`, and `instructions=null` in the
current profile. These are protocol envelope values, not echoes of raw caller intent and
not claims about Provider-native fields.

## 8. Certification

- request tests stop at Pi Context/options and Client state;
- response tests start with Pi `AssistantMessage`;
- continuity tests execute the next complete-history request through the real pinned Pi
  adapter and capture its unmodified payload;
- CommandCode final-wire tests live with CommandCode Private;
- online Responses tests use complete Client Wire and resolved models;
- architecture tests prove projection/supplement directories and semantic `onPayload`
  are absent.
