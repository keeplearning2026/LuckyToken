# Provider Native Function-Call Namespace Repair

## Problem

Some upstream Providers forward a model's namespaced tool call without the
Responses `namespace` field. A Codex caller resolves the bare child name under
the default namespace `functions` (`codex-rs/protocol/src/tool_name.rs`,
`with_default_namespace`), fails the registry lookup, and answers
`unsupported call: <child>` (`codex-rs/core/src/tools/registry.rs`).

Measured online for `commandcode-goat/xiaomi/mimo-v2.6-flash`: the first
`spawn_agent` call of a conversation carries `namespace`, and roughly half of the
later calls do not. The omission is already present in the raw upstream SSE — of
147 recorded request directories, the `function_call` items in the upstream,
preserved, and client streams are identical on `(call_id, name, namespace,
arguments)`, and upstream differs from preserved only in the `model` field.

## Contract change

Provider Native Responses already commits upstream bytes with the model alias
projected and with SSE lifecycle normalization applied. This module adds one
more bounded exception:

> For a successful Provider Native Responses response, Token may insert the
> `namespace` property of a `function_call` item when the caller's own request
> declared that child under exactly one namespace and the item carries no
> `namespace` property at all. Every other byte of the response is preserved.

Nothing else is authorized. The module never rewrites an existing value, never
renames an item, and never interprets a name that the request did not declare.

## Authority

The namespace map comes from the request body Token already sent upstream
(`request.tools` entries of `type: "namespace"` whose children are
`type: "function"`). Token embeds no Codex tool table, so MCP servers
(`mcp__<server>`), plugin namespaces, multi-agent namespaces (whose name is
configured, e.g. `multi_agent_v1` today and possibly `multi_agent_v2` later) and
host-provided dynamic namespaces (`web`, `image_gen`) all follow the request.

## Decision table

| Request declaration | Response item | Action |
| --- | --- | --- |
| function child belongs to exactly one namespace `N` | no `namespace` property | insert `"namespace":"N"` |
| function child belongs to exactly one namespace `N` | `namespace` present (any value, any type) | leave unchanged |
| child belongs to several namespaces | any | leave unchanged |
| child is also a top-level tool name | any | leave unchanged |
| child is declared as a namespace `custom` child | any | leave unchanged (a repaired `function_call` would dispatch with an incompatible payload, which Codex treats as fatal) |
| the same `(namespace, child)` identity is declared twice, in any kind | any | leave unchanged: Codex keys tools by `(namespace, name)` alone, so the declaration has no unique reading |
| the request text repeats the top-level `tools` key, or repeats any key inside the `tools` subtree | any | refuse the whole declaration: no index, no repair. A repeated key elsewhere in the request (for example `metadata`) is unrelated to this authority and does not switch the repair off. |
| child is not declared | any | leave unchanged |
| request declares no namespace child | any | skip the whole body |

Two qualifiers do the real work: **uniqueness** (a child claimed by several
namespaces, such as `js` under both `mcp__cua_repl` and `mcp__node_repl`, is
never repaired) and **top-level exclusion** (a name that is also declared as a
top-level tool, such as `read_thread`, is never repaired, because a
namespace-less call to it already resolves and inserting a namespace would
silently redirect it).

## Deliberate non-goals

- **No value correction.** An empty, wrong, or non-string `namespace` is left
  alone. Only the omission is evidenced; correcting a value would rewrite the
  model's stated intent on speculation.
- **No flattened-name interpretation.** Names such as
  `mcp__multi_agent_v1__spawn_agent` are left untouched. Zero flattened
  `function_call` items exist in the recorded diagnostics, and guessing a split
  would manufacture identity the caller never declared.
- **No custom-child participation.** Codex dispatches `FunctionCall` and
  `CustomToolCall` with different payload kinds; a `function_call` repaired
  against a `custom` declaration would dispatch with an incompatible payload,
  which Codex treats as fatal.
- **No repair for undeclared names.** A model that invents a call must keep
  receiving `unsupported call`; hiding it would mask a protocol violation.
- **No Direct Mode support — decided, not deferred.** Direct Mode owns its model
  recognition, its preserved caller envelope, and its own response handling, and
  it deliberately shares nothing with Provider Native. Normalizing a Direct Mode
  response would put Provider Native policy inside an independent lane. Known
  consequence of this decision: a flattened-name error string
  (`unsupported call: mcp__multi_agent_v1__spawn_agent`) does appear in the
  history of one Direct Mode request, but the response that produced it was never
  captured, so Direct Mode is unmeasured rather than proven unaffected. That
  failure stays unfixed there, and this module will not be the place that changes
  it. Adding a lane later means a new setting key, a new integration point, and
  a second control on the Response repair page; today the page carries exactly
  one switch, and no lane is enabled by implication.

## Byte discipline and failure behaviour

A repaired line differs only by the inserted `,"namespace":"…"` property, placed
directly after the item's `name` property. Untouched lines are preserved
verbatim; `body.split("\n").join("\n")` is lossless for both LF and CRLF. The
handler decodes with `ignoreBOM`, so a leading byte-order mark survives the
decode/encode round trip.

Every failure path leaves the repair-stage input bytes in place and emits no
repair notice (the journey step is still entered and completed, and diagnostics
still observe it):
unparsable JSON, an invalid buffered JSON body (strictly parsed before any byte
is touched), a duplicated key inside the item, a missing or duplicated `name`
property, a missing property span, a throwing settings supplier, and any
unexpected error (contained by an explicit `try`/`catch` around the whole
repair). The result reports `kind` ∈ `repaired` / `unchanged` / `skipped` plus
`patchedItemCount`.

Three carve-outs keep the rule practical. A `data: [DONE]` sentinel (with an
optional CRLF) and an empty keep-alive payload are skipped rather than treated as
malformed frames. Only the three certified carriers are rewritten, so any other
Responses event stays byte-identical. A body whose bytes are not valid UTF-8 is
never repaired at all: the handler decodes with `fatal: true`, so a successful
decode proves the decode/encode round trip is byte-exact, and a failed decode
leaves the original bytes in place. Scope of that byte claim: the byte-order mark
survives this step, but the later alias projection decodes with a default
`TextDecoder`, which strips a leading BOM, so end-to-end byte identity is not
claimed when an alias is projected.

Two levels of strictness apply to frames. A frame that parses and declares one of
the three certified types is held to that event's own carrier, and no other
location in that payload is ever considered:

| Event | Carrier | Carrier missing | Carrier present but malformed |
| --- | --- | --- | --- |
| `response.output_item.added` / `.done` | top-level `item` | abandon the whole repair | abandon the whole repair |
| `response.completed` | `response.output[]` | skip this frame | abandon the whole repair |
| buffered JSON body | top-level `output[]` | skip the body | abandon the whole repair |

`response.completed` without an `output` array is normal for several providers and
is not a location whose contents this module could have edited, so skipping it
cannot hide a partial edit; a present-but-malformed carrier is different evidence
and abandons the repair. A frame that does not parse is abandoned only when it
looks like a carrier (it mentions `function_call`); any other unparsable payload —
keep-alive text, a progress note — is skipped for the same reason.

The same event is asymmetric on purpose: a `response` that is missing, null, or not
an object abandons the whole repair, because then the frame itself is malformed
rather than merely short of an optional snapshot. Only an object `response` whose
`output` key is absent takes the skip path.

## Switch

Setting `protocols.openai-responses.responseRepair.functionCallNamespace.providerNative`
(boolean, default `true`, `hot-apply`) gates the repair. The handler reads it
lazily per response through a supplier, so toggling it in Settings → Response
repair takes effect without a restart. When the setting is absent the repair
runs. Because the module does nothing unless the response is already degraded,
leaving it on is safe; the switch exists so the exception can be withdrawn once
the upstream stops omitting the field.

## Observation

When the repair changes bytes, the response emits one bounded notice
`provider_native_function_call_namespace_repaired` at the dedicated
`repair_function_call_namespace` step location. The step means "entered the
repair stage and decided": it is entered for every buffered Provider Native
response that reaches this stage (SSE and buffered JSON alike) and completed in a
`finally`, so it is balanced even when the repair fails open. It is not entered
for an aliased upstream HTTP >= 400, which returns earlier; a non-aliased >= 400
does reach the stage with the repair disabled. The stage runs after lifecycle
normalization and before the alias projection, so "unchanged" means "the bytes
that entered this stage are preserved", not "the raw upstream bytes are
preserved". The step is registered in
`doc/Spec/TokenRequestJourneyDiagnosticsSpec.md`.

## Certification

- `test/unit/provider-native-function-call-namespace-repair.test.ts` — 33 cases:
  unique-child insertion, byte preservation of untouched lines, already
  namespaced, present value of every type, ambiguous child, top-level collision,
  custom child, flattened names, undeclared name, completed-snapshot output
  array, buffered JSON body, invalid JSON body, duplicate item key, unparsable
  data line, `[DONE]` sentinel, a CRLF sentinel with a keep-alive frame, an
  uncertified event type, a same-named `custom` conflict, repeated request keys,
  a real catalog whose arrays hold scalars (`enum: [true]`, `["a", 1, null]`,
  `enum: []`, `required`, `additionalProperties`), carrier/event mismatches in
  all three directions, a malformed certified carrier, an unparsable frame with
  and without carrier evidence, a byte-order mark on both the buffered-JSON and
  first-SSE-frame paths, a repeated unrelated request key (ignored) versus a
  repeated top-level `tools` key (refused), whole-body abandonment on a mixed
  body, and the no-unique-child skip.
- `test/unit/provider-native-responses-contract.test.ts` — handler-level cases:
  namespace inserted when the switch is on, upstream bytes returned untouched
  when it is off, buffered JSON body repaired, and a non-UTF-8 body returned
  byte-for-byte.
- Replay of the recorded failing request (`request-02cc14a1…`, raw upstream
  SSE): the three namespace-less items are repaired; removing the inserted
  properties reproduces the original bytes exactly.
- Online lane regression (temporary instance, real upstream, 2 conversations ×
  3 turns): the upstream still omits `namespace` from turn 2 onward while the
  client-facing stream carries it on every turn.

`test/online/run-responses-namespace-probe.ts` is a one-off diagnostic, not part
of any regular online suite: it reproduces a live upstream defect and will stop
triggering once the Provider serializes `namespace` correctly.

## Open items

1. **Lane isolation is asserted structurally, not behaviourally.** The handler-level
   suite covers switch on/off, SSE and buffered JSON, repair-before-alias
   ordering and the non-UTF-8 path, but it does not yet construct a request that
   is declined by the Provider Native lane to prove Direct / Semantic / compact
   responses stay byte-identical. Direct Mode is excluded by decision, and
   Semantic Conversion is unmeasured.
   Why this is not a small test: lane selection is keyed on the model and
   operation, not on the request
   (`providerNativeLane.claims(model, "responses")` delegates to
   `supportsProviderNativeResponses`). A declined-lane fixture therefore needs a
   second model with a non-Responses provider API plus a working Semantic
   Conversion stub, which the current pass-through contract fixture does not
   have.
2. **No PRD change is required, and that was verified rather than assumed.**
   `doc/Spec/TokenProviderCredentialProfilesPRD.md` states literal body
   preservation for the *request* body and names its two request-side exceptions
   (Anthropic OAuth projection, Responses tool-call adjacency deferral); it makes
   no claim about response bytes. The response-side contract is stated in this
   spec and in `AGENTS.md`.
