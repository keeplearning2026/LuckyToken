# 02 — Responses wire → Pi IR request conversion

**What to build:** A Responses request body (after expansion) converts into a
faithful Pi `Context` — messages, tools, system prompt, and options — with no
source semantic silently dropped, guessed, or coerced. Malformed input yields
`InvalidRequest`; unsupported-but-valid input yields explicit rejection.

**Blocked by:** 01 — Durable session state (expansion must exist first).

**Status:** ready-for-agent

- [ ] Request validation: body object; `model` non-empty string; `input`
  string/array; `previous_response_id`/`store`/`stream`/`max_output_tokens`/
  `temperature`/`top_p`/`reasoning`/`tools` shape checks; unknown item type →
  `InvalidRequest`.
- [ ] `instructions` → `systemPrompt`; `message` items map by role
  (system/developer → systemPrompt, user → Pi user, assistant → Pi assistant
  with synthetic history identity and empty usage).
- [ ] `reasoning` items become pending thinking blocks attached to the **next**
  assistant message (surviving intervening function_call items); unreferenced
  trailing reasoning is dropped.
- [ ] `function_call`/`custom_tool_call` → Pi `toolCall` (`id: call_id`,
  arguments JSON-parsed, non-JSON → `{}`); an assistant container is created
  when none exists yet.
- [ ] `function_call_output`/`custom_tool_call_output` → Pi `toolResult`
  correlated to the preceding toolCall; orphan output → `InvalidRequest`.
- [ ] `compaction`/`compaction_summary`/`context_compaction` → user text
  degradation (encrypted non-string → dropped marker); `agent_message` → Pi
  user; `web_search_call`/`tool_search_call`/`compaction_trigger` dropped;
  `additional_tools` merged into tool definitions.
- [ ] Top-level `tools` → Pi `Tool[]` with `strict:true` →
  `constrainedSampling {type:"json_schema", strict:"require"}`.
- [ ] Options: `max_output_tokens → maxTokens`, `temperature`, `reasoning.effort`
  (`ultra → max`) → `reasoning`.
- [ ] Unit tests cover every mapping rule above including absence, malformed,
  orphan, and degradation branches.

**Out of scope:** session state (ticket 01), response rendering (ticket 03).
