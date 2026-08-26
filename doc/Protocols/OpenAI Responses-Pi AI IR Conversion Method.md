# OpenAI Responses ↔ Pi AI IR Conversion Method

Status: **Frozen normative design**  
Applies to: OpenAI Responses conversion profile.  
Native Responses passthrough is a separate non-conversion profile.

## 1. Boundary

```text
OpenAI Responses wire
  ↕ this adapter
Pi Context / SimpleStreamOptions / AssistantMessage
```

The adapter owns Responses parsing, local session expansion, trusted Responses resource resolvers, Pi conversion, Responses rendering, and local conversion notices. It MUST NOT inspect or name CommandCode or another concrete Provider.

```ts
interface ResponsesRequestConversion {
  selector: string;
  context: Context;
  options: Partial<SimpleStreamOptions>;
  renderState: ResponsesRenderState;
  notices: readonly ConversionNotice[];
}
```

`renderState` keeps only request-local Client wire facts needed to render an honest Response. It never crosses into a Provider.

## 2. Configuration

Suggested shape:

```json
{
  "clientProtocols": {
    "openai-responses": {
      "stateFile": "state/openai-responses.json",
      "conversion": {
        "request": {
          "privilegedMessages": "first",
          "unknownInputItem": "error",
          "orphanToolOutput": "error",
          "unresolvedToolCall": "xrepair",
          "futureReasoningEffort": "max"
        },
        "response": {
          "unknownPiContent": "error",
          "storeFalse": "honor"
        }
      }
    }
  }
}
```

Frozen defaults:

| Key | Values | Default |
|---|---|---|
| `privilegedMessages` | `full | first | user` | `first` |
| `unknownInputItem` | `error | ignore` | `error` |
| `orphanToolOutput` | `error | ignore` | `error` |
| `unresolvedToolCall` | `error | xrepair` | `xrepair` |
| `futureReasoningEffort` | `max | omit | error` | `max` |
| `unknownPiContent` | `error | ignore` | `error` |
| `storeFalse` | `honor | memory | persist` | `honor` |

Every configurable ignore/xrepair/future-value fallback emits a request-local notice. Fixed ordinary auxiliary drops do not.

## 3. Request construction order

1. Parse and validate the Responses request.
2. Authenticate and resolve the opaque model selector through the full Pi model catalog.
3. Resolve/expand local state such as a known `previous_response_id`.
4. Resolve only trusted Client-owned handles explicitly allowed by §10.
5. Convert input items in source order, maintaining tool correlation.
6. Build the unique Pi system prompt according to §5.
7. Convert tools and options.
8. Apply unresolved-call repair at semantic history boundaries.
9. Freeze render state and notices.
10. Execute Pi; render JSON or atomic SSE.

No conversion step may inspect the selected concrete Provider's protocol or capabilities.

## 4. Top-level create fields

### 4.1 Direct and target-backed mappings

| Responses source | Pi/local target | Frozen action |
|---|---|---|
| `model` | selector | Required by Token conversion profile. Preserve opaquely for response echo. |
| `input` | `Context.messages` | Convert using §§5–8. An omitted input becomes an empty message list when top-level instructions alone are accepted by the active profile. |
| `instructions` | `Context.systemPrompt` | Exact text, always privileged, before input-derived system/developer text. `null` means absent. |
| `max_output_tokens` | `options.maxTokens` | Positive integer; zero/negative is Client invalid request, never an internal 500. |
| `temperature` | `options.temperature` | `null`/absence means target default. Validate source range. |
| `top_p` | `options.samplingParams.top_p` | Direct Pi mapping. |
| `prompt_cache_retention` | `options.cacheRetention` | `in-memory→short`, `24h→long`, null/absence→Pi default. |
| `safety_identifier` | `options.metadata.user_id` | Direct string mapping. |
| deprecated `user` | metadata fallback | Use only when safety_identifier is absent. |
| `reasoning.effort` | `options.reasoning` | Use §4.2. |
| `tools` | `Context.tools` | Use §8. |
| `stream` | render state | true selects atomic Responses SSE. null/absence=false. |
| `previous_response_id` | local state | Use §9. Mutually exclusive with conversation. |
| `store` | local response storage policy | Use §9. |
| `metadata` | request-local response echo | Do not place resource metadata into model context. Echo only safely retained values. |

### 4.2 Reasoning effort

| Source | Pi reasoning | Notice |
|---|---|---|
| absent/null | omitted | no |
| `none` | omitted | documented explicit-off degradation |
| `minimal` | `minimal` | no |
| `low` | `low` | no |
| `medium` | `medium` | no |
| `high` | `high` | no |
| `xhigh` | `xhigh` | no |
| Lucky alias `ultra` | `max` | compatibility notice |
| Lucky extension `max` | `max` | no |
| future unknown | policy | max/omit emits notice; error rejects |

Omission is not claimed to be an explicit Provider off. The Pi/Provider model may apply its own default or clamp.

### 4.3 Local controls with partial implementation

| Source | Frozen action |
|---|---|
| `tool_choice:"none"` | Supply no tools to Pi for this request. |
| `tool_choice:"auto"`/null | Normal complete executable catalog. |
| `allowed_tools` in auto mode | Filter the Client/BYOT catalog deterministically. |
| forced/required tool choice with no generic Pi control | Drop and document. If it requires a tool removed as non-executable, conversion error rather than false compliance. |
| `parallel_tool_calls` | Drop; no generic Pi control. Do not echo caller value as effective. |
| `text.format`, `text.verbosity` | Drop; no top-level Pi format contract. Do not create a synthetic Tool. |
| `truncation` | Drop unless a future Client-owned truncator is explicitly installed; do not claim truncation occurred. |
| `context_management` | Drop unless a Client-owned semantic resolver implements it. |
| `include` | Client response enrichment only. Honor only supported adapter-owned fields such as recoverable reasoning continuity; drop others. |

### 4.4 Provider/service/resource controls with no Pi semantic target

Drop and document: `prompt_cache_key`, `service_tier`, `parallel_tool_calls`, ordinary Responses resource metadata as model input, `stream_options.include_obfuscation` in atomic mode, and unsupported persistence/query controls.

`background=true` is different: it requests an asynchronous response lifecycle. Core v1 does not implement submit/poll/cancel, so it is a conversion error. `false`/null/absence executes synchronously.

## 5. Privileged messages and prefix stability

Top-level `instructions` always enters `Context.systemPrompt` first.

Input message roles `system` and `developer` use `privilegedMessages`:

### 5.1 `full`

All system/developer text is removed from ordinary history and appended to Pi systemPrompt in input order.

### 5.2 `first` (default)

- Scan input in source order until the first `role="user"` message.
- System/developer messages before that first user are appended to Pi systemPrompt.
- System/developer messages at or after that point are converted as Pi user messages in their original position.

This keeps the stable initial prefix privileged while preventing later changing instructions from invalidating the whole system-prefix cache.

### 5.3 `user`

All input system/developer messages are converted as Pi user messages in source order. Only top-level instructions remain privileged.

### 5.4 Joining

Each promoted prompt segment is joined with one newline (`\n`) to denote another prompt segment. Exact segment text is not rewritten. Empty segments are skipped.

Role degradation is a configured semantic choice. It does not inject labels such as “system said” unless that text existed in the source.

## 6. Message content

### 6.1 Textual content

| Responses content | Pi | Action |
|---|---|---|
| `input_text` | TextContent | Exact text. |
| `output_text` in historical assistant | TextContent | Exact text. |
| `refusal` | TextContent | Preserve refusal text as deterministic textual degradation. |
| message string | TextContent | Exact text. |

Message `phase` is preserved in Pi `textSignature` using a versioned adapter-owned envelope; it is not inserted into text.

### 6.2 Images

| Source | Action |
|---|---|
| valid base64 data URL | Decode to Pi ImageContent `{data,mimeType}`. |
| `input_image.file_id` | Resolve only through a trusted Responses-owned image resolver; otherwise conversion error. |
| remote `input_image.image_url` | Resolve only through an explicitly trusted URL/image resolver with authority, redirect, timeout, size and MIME limits; otherwise error. |
| `detail` | Drop; no Pi field. |
| malformed data URL/base64/MIME | Conversion error. |

Never turn an unresolved image into an empty message or an invented textual placeholder.

### 6.3 Generic files

Pi has no generic FileContent. `input_file` is therefore dropped and recorded as a fixed known degradation. If a trusted resolver proves it is an image and the active Client policy permits image materialization, it may become Pi ImageContent. Non-image extraction is a separate Client capability, not a Provider responsibility.

### 6.4 Malformed and unknown parts

A known content type missing required fields or failing conversion is an error. A future unknown content/item discriminator follows `unknownInputItem`; default error. It is not silently skipped as malformed empty content.

## 7. Reasoning continuity

Readable Responses reasoning summary/content becomes Pi ThinkingContent.thinking.

Responses-native continuation state is serialized into a Token-owned versioned `thinkingSignature` envelope containing provenance sufficient to prove:

- the signature was created by the Responses adapter;
- its schema version;
- its originating authority/scope where applicable;
- the exact opaque fields required for Responses replay.

Only a verified envelope from the current Responses adapter/authority may restore `encrypted_content`. An arbitrary Pi thinkingSignature from another Provider is never emitted as Responses encrypted content.

A reasoning item without a following assistant text message is preserved as a reasoning-only Pi AssistantMessage. Pi supports reasoning-only assistant content; it must not disappear.

Status:

- absent/completed → normal conversion;
- in_progress → conversion error;
- incomplete → preserve representable content; preserve incomplete status only in a non-model-visible request-local diagnostic; do not inject notice text and do not map it to `length` without a Response-level incomplete reason.

Foreign opaque reasoning/compaction follows §10, not this visible-content degradation.

## 8. Tools and tool history

### 8.0 Complete input-item family matrix

This matrix covers the installed OpenAI SDK input-item union. `status` and lifecycle validation in §8.6 still apply after classification.

| SDK item family / discriminator | Frozen conversion |
|---|---|
| EasyInputMessage / input `message` | Convert role/content under §§5–6. |
| ResponseOutputMessage / historical output `message` | Convert output_text/refusal/reasoning-visible content to Pi AssistantMessage. Preserve phase in versioned signature. |
| `file_search_call` | Provider/server-hosted by default: ordered deterministic transcript of representable queries/results; lifecycle-only fields drop. If a registered Client-owned executor proves ownership, structural tool mapping is allowed. |
| `computer_call` | Classify by execution ownership. Client/BYOT→generic ToolCall; provider-hosted→content/transcript. |
| `computer_call_output` | Match the classified call. Client/BYOT→ToolResult; provider-hosted→ordered result content/transcript. Screenshot images map to Pi images on the Client side. |
| `web_search_call` | Provider/server-hosted result content/transcript; do not advertise a Pi executable tool. |
| `function_call` | Structured Pi ToolCall. |
| `function_call_output` | Structured Pi ToolResult. |
| `tool_search_call` | Core v1 conversion error; dynamic discovery lifecycle is unsupported. |
| `tool_search_output` | Core v1 conversion error; it cannot appear without the unsupported lifecycle. |
| `reasoning` | §7 visible thinking + verified continuity envelope. |
| `compaction` | Lucky-owned verified envelope→decode/convert; foreign encrypted-only→error. Never fabricate byte-count text. |
| `image_generation_call` | Provider-hosted result content/transcript; decode a valid returned image only when directly materialized and within Client image limits. |
| `code_interpreter_call` | Provider-hosted code/output transcript unless an explicit Client-owned executor proves ownership. |
| `local_shell_call` | Client/BYOT structured ToolCall. |
| `local_shell_call_output` | Client/BYOT structured ToolResult. |
| `shell_call` | Client/BYOT structured ToolCall. |
| `shell_call_output` | Client/BYOT structured ToolResult. |
| `apply_patch_call` | Client/BYOT structured ToolCall. |
| `apply_patch_call_output` | Client/BYOT structured ToolResult. |
| `mcp_list_tools` | Client-owned MCP→non-model-visible catalog update plus representable transcript if source includes model-visible content; provider-hosted MCP→transcript/lifecycle drop. |
| `mcp_approval_request` / `mcp_approval_response` | Pi has no approval lifecycle. Preserve model-visible decision text as deterministic transcript; drop pure lifecycle metadata. Never fabricate executable approval tools. |
| `mcp_call` | Client-owned MCP→structured ToolCall/result semantics; provider-hosted MCP→ordered transcript. |
| `custom_tool_call` | Structured Pi ToolCall with `{input:string}` compatibility representation. |
| `custom_tool_call_output` | Structured Pi ToolResult, reversed to custom family using request-local metadata. |
| `item_reference` | Lucky-owned provable reference→resolve/convert; external/unknown→error. |

Token/Codex extension discriminators that are not in the installed SDK MUST have an explicit extension-profile entry. They do not become supported merely by setting `unknownInputItem=ignore`.

### 8.1 Function calls

Function tool definitions map name, description, parameters and strict JSON-schema constraint into Pi Tool. Duplicate names are an error unless a separately frozen namespace transform makes them unique.

Function call arguments:

| Source arguments | Result |
|---|---|
| missing/blank | `{}` |
| valid JSON object | lossless object |
| invalid JSON | conversion error |
| valid non-object JSON | conversion error |

### 8.2 Custom tools and grammar

A Responses custom tool accepts freeform text while Pi ToolCall arguments are objects. The approved adapter-owned representation is `{input: <string>}` and emits a compatibility notice.

Custom grammar maps directly to Pi Tool.constrainedSampling grammar:

- Lark → `openai_lark` variant;
- regex → `openai_regex` variant.

Do not drop grammar when Pi can carry it.

### 8.3 Namespace

Pi 0.84.2 distinguishes the declaration and call contracts: Pi `Tool` still has no namespace field, while Pi `ToolCall` has optional `namespace`. Namespace tool declarations therefore continue to use the reversible adapter-owned `<namespace>.<child>` flattening scheme with collision detection and request-local reverse metadata.

For historical call items, if a wire `namespace + name` pair matches a flattened declaration owned by this request, the Pi ToolCall uses that flattened name and omits `namespace` so `Context.tools`, ToolCall, and ToolResult share one canonical identity. If no matching flattened declaration exists, the Client Wire → Pi IR conversion preserves the wire namespace in Pi `ToolCall.namespace` rather than erasing a representable Pi 0.84.2 fact, but Core v1 then rejects that surviving namespace before Pi Provider execution. Token has no certified Provider replay identity for such unmatched namespaced history, and allowing a Provider adapter to omit it could change tool identity.

On Pi → Responses rendering, request-local reverse metadata restores a flattened declaration identity. A direct Pi `ToolCall.namespace` returned by a Pi Provider is emitted when no reverse entry exists. If both are present they must agree on namespace; disagreement is an outbound fidelity failure rather than an arbitrary precedence rule.

### 8.4 Execution ownership

Classification is by who executes the tool, not by a concrete Provider/tool name.

- Client/BYOT execution, including ordinary function, client MCP, local shell, shell and apply_patch, maps to structured Pi ToolCall+ToolResult where the source lifecycle is complete.
- Provider/server-hosted execution is not advertised as a Pi client tool. Representable results become ordered Pi content or a deterministic transcript; pure lifecycle metadata is dropped.
- A hosted declaration with no Pi execution owner is dropped from Context.tools. A forced tool choice that depends on it is an error rather than false compliance.
- `tool_search` and any request requiring deferred tool discovery are unsupported in Core v1 and produce a conversion error.

### 8.4.1 Complete tool-definition family matrix

| SDK Tool family | Frozen conversion |
|---|---|
| function | Pi Tool: name/description/parameters/strict mapping. |
| custom | Pi Tool with freeform compatibility schema; Lark/regex grammar maps to constrainedSampling. |
| namespace | Pi `Tool` declarations use reversible adapter-local flattening with collision detection. A matching historical call uses the same flattened identity; an unmatched namespace is preserved at the Client Wire → Pi IR boundary but is rejected before Provider execution in Core v1. Pi Provider responses may still return `ToolCall.namespace`, which the Responses renderer preserves. |
| local_shell | Client/BYOT Pi Tool with documented action schema. |
| shell | Client/BYOT Pi Tool with documented action schema. |
| apply_patch | Client/BYOT Pi Tool with documented operation schema. |
| computer / computer_use | Ownership-based: Client/BYOT generic Pi Tool; provider-hosted declaration drop. Viewport/environment fields without Pi slots drop. |
| MCP | Client-owned MCP may become Pi tools after adapter-owned authority/schema resolution; provider-hosted/remote execution declaration drops. Never expose MCP credentials/headers in Pi. |
| file_search | Provider-hosted declaration drop. |
| web_search / web_search_preview | Provider-hosted declaration drop. |
| image_generation | Provider-hosted declaration drop. |
| code_interpreter | Provider-hosted declaration drop. |
| tool_search | Core v1 conversion error. |

Any `defer_loading=true` that requires tool-search discovery is a Core v1 conversion error. The Responses adapter determines its Client/BYOT catalog solely from Responses request semantics and Responses-local configuration; it does not import another Client Protocol's dynamic-tool rules.

### 8.5 Tool outputs

Preserve call ID, correlated tool name, error state, ordering, and textual content. Tool output images are representable in Pi ToolResult and MUST be converted on the Client side. The separately frozen CommandCode Provider degradation may later drop them; the Client adapter does not anticipate that Provider.

### 8.6 Lifecycle validation

- status absent/completed → eligible for normal validation;
- in_progress/incomplete/unknown status → conversion error for structured call/output;
- duplicate result → fixed error;
- orphan output → `orphanToolOutput`, default error; ignore emits notice;
- unresolved call → `unresolvedToolCall`, default xrepair;
- call/result correlation and source order remain mandatory after local previous-response expansion.

The Responses adapter defines its own synthetic missing-result literal, correlation logic, notice code, and tests. Its frozen text is `No result — the tool call did not complete (interrupted or lost).`; it preserves ID/name/isError=true and never replaces a real result. No Anthropic conversion helper or policy object is reused.

## 9. Local Responses state

### 9.1 previous_response_id

A known local response ID follows immutable `parentResponseId` links and
concatenates each node's current-turn input/output delta before the new input,
preserving order. Requests without `previous_response_id` bypass state
expansion and enter the existing converter unchanged. An unknown, expired,
evicted, or unresolvable target ID is a conversion error; there is no fail-open
assumption that the client resent complete history. An expired ancestor may
remain as an internal dependency of an unexpired descendant without regaining
direct-reference eligibility.

`conversation` and `previous_response_id` are mutually exclusive.

### 9.2 Authority model

Stored entries are not bound to an authentication principal or project scope. Therefore the response ID is a bearer capability and MUST be:

- generated with high entropy;
- non-enumerable;
- bounded by TTL and capacity;
- excluded from unsafe logs except where needed as a redacted/hash correlation fact.

This design deliberately accepts that anyone possessing the ID may use it through an authorized Token connection.

### 9.3 Commit timing

The handler awaits checkpoint memory admission before returning, providing
in-process read-after-write for admitted IDs. Capacity, missing-parent, or
history-limit admission can be skipped best-effort after a Response has formed;
the Response remains successful and the existing diagnostics notice seam records
the degradation. Snapshot persistence remains asynchronous/debounced and is not
a crash-before-flush durability guarantee.

### 9.4 store:false

| Policy | Behavior |
|---|---|
| `honor` (default) | Do not place the response in the reusable memory session store and do not persist it. |
| `memory` | Keep only in process memory; never write to disk. |
| `persist` | Store despite caller false; emit a notice. |

For store true/null/absence, use the configured normal storage profile and report only values that actually took effect.

### 9.5 State file integrity

Snapshot v4 stores `createdAt`, `parentResponseId`, the current-turn wire-item
delta, and excludes memory-only nodes. It validates IDs and the complete parent
graph before publishing the in-memory Map; duplicate IDs, missing parents,
self-parenting, or cycles quarantine the whole v4 snapshot. Snapshot v3 is not
migrated and its response IDs become unavailable. Writes remain same-directory
temporary-file plus atomic rename and graceful flush; the 64 MiB snapshot cap
is a best-effort persistence guard, not an in-memory admission limit.

## 10. Opaque handles and external authority

Core v1 conversion rule:

| Source | Action |
|---|---|
| `conversation` | error |
| reusable `prompt` | error |
| external `item_reference` | error |
| compaction with foreign encrypted_content only | error |
| Token-owned, provable item_reference | resolve then convert |
| Token-owned, verifiable opaque envelope | decode then convert |

Any capability that resolves a handle is owned by the Responses Client adapter. It receives a narrow authorization context, abort signal, and explicit size/MIME/redirect limits. It must not borrow the selected Provider's credential or leak a Responses handle into Pi/Provider.

Native same-authority passthrough may preserve these fields because it is not conversion; see §15.

## 11. Pi AssistantMessage → Response object

### 11.1 Identity and envelope

The converted path always generates one Token-owned high-entropy Responses
ID and never reuses Pi `responseId`; native passthrough preserves upstream
identity unchanged. `model` always echoes the client selector; Pi
`responseModel` is not exposed as the client model.

The Response wire object includes all required fields of the selected target profile, including target defaults/nulls. At minimum:

- id, object, created_at, model;
- status;
- error;
- incomplete_details;
- instructions;
- metadata;
- output;
- parallel_tool_calls;
- temperature;
- tool_choice;
- tools;
- top_p;
- usage when available.

SDK convenience `output_text` is not emitted as a wire field merely because a parser computes it locally.

Echo **effective normalized state**, not raw caller intent:

- only tools actually offered to Pi;
- effective/default tool_choice;
- effective temperature/top_p when known;
- no claim that a dropped hosted tool, forced choice, parallel flag, format, tier, or truncation took effect.

### 11.2 Output items

- Pi text → assistant message/output_text content.
- Pi reasoning → reasoning item summary/content; verified Responses signature may restore encrypted_content.
- Pi ToolCall → function/custom call using request-local reversible family metadata and, where no flattened declaration owns the identity, the Pi 0.84.2 `ToolCall.namespace` field.
- Pi `AssistantMessage.endTurn` is diagnostic-only and has no standard Responses wire field in this profile; it does not change status or stop-reason rendering.
- Unknown Pi content follows `unknownPiContent`, default error. Ignore emits notice.
- Redacted/opaque content is never guessed into a Responses family without verified provenance.

### 11.3 Status and stop reason

| Pi result | Response status |
|---|---|
| stop/toolUse | completed |
| length | incomplete with `incomplete_details.reason="max_output_tokens"` |
| error | failed with non-null Response error, when a Response object has been formed |
| pending/aborted/deferred | not a committed success; execution boundary handles it |

A future unknown Pi stop reason is an error. Ignoring unknown content does not authorize a fabricated completed status.

### 11.4 Usage

- Pi input + cache write/read accounting maps to input_tokens and input details according to target schema;
- Pi output → output_tokens;
- Pi reasoning → output_tokens_details.reasoning_tokens;
- total is derived/validated according to target contract;
- output_tokens_details is emitted even when reasoning is zero;
- Pi cost has no Responses wire field and is dropped.

## 12. Atomic SSE

The current profile is atomic: Pi execution completes before the first SSE byte.

Minimum event sequence:

```text
response.created
response.output_item.done ...
response.completed | response.incomplete | response.failed
[DONE]
```

Rules:

1. Every schema event has a monotonically increasing `sequence_number`, starting from the target-defined initial value.
2. Terminal event matches Response status.
3. completed has `error:null` and `incomplete_details:null`.
4. incomplete has non-null incomplete_details and `error:null`.
5. failed has non-null error and is not conflated with incomplete.
6. A failure before SSE commit returns the normal non-2xx Responses error JSON; it need not fabricate response.failed.
7. If a failed Response has already been formed, or a future live-stream profile commits early, emit response.failed.
8. `[DONE]` is retained as the selected client-compatibility terminator and documented separately from semantic terminal events.

Atomic mode does not fabricate token deltas or item-added events it does not possess. A future live streaming profile requires a separate lifecycle design.

## 13. Error response

The non-streaming Responses error envelope preserves distinct target fields:

```json
{
  "error": {
    "message": "...",
    "type": "...",
    "code": null,
    "param": null
  }
}
```

Client input conversion errors use a legal invalid-request classification.
Provider/runtime errors may arrive only as validated protocol-neutral Pi
diagnostics preserved in `ExecutionFailure.failure`; the conversion handler does
not inject a custom `fetch`, read observer state, or parse a Provider error
string. The renderer:

- preserves a validated HTTP status when available;
- does not move an upstream `code` into target `type`;
- emits safe x-request-id/retry/rate-limit headers when available;
- bounds/redacts body-derived messages;
- never forwards credentials/cookies/hop-by-hop headers;
- writes one per-request failure journal.

If `ExecutionFailure.failure` is absent, no Provider-derived status, message,
type, code, identifier, or header is trusted. The renderer returns the fixed
generic Responses upstream error: HTTP 502, `api_error`, message
`Upstream provider failed`, and null `code`/`param`.

## 14. Fixed known drops and degradations

The following do not block the primary conversation when no Pi target exists:

- response-format and verbosity controls;
- unsupported service tier and parallel-tool preference;
- hosted execution declarations with no Client/Pi owner;
- generic non-image files;
- source presentation annotations/citations with no Pi slot;
- resource metadata not needed for local response echo;
- remote persistence/query controls not implemented by the Client adapter.

They MUST NOT be represented as having taken effect in the Response object.

## 15. Native Responses preservation

OpenAI Responses currently has **two distinct preservation lanes**: Direct Mode and Provider Native Preservation. Both preserve Responses-wire semantics without forcing the request through Pi AI IR, but their model/credential authority is intentionally different.

### 15.1 Direct Mode Responses

The handler checks the raw model selector against the explicit Direct Mode Responses lane **before** Public Model/Pi Model resolution or `previous_response_id` expansion:

```text
raw Responses body + selector
→ DirectResponsesLane.claims(selector)
→ Direct Mode model/capability source
→ preserve caller envelope
→ direct Responses transport
```

Current production implementation is the Codex Direct Mode integration. It forwards caller Authorization/account/query facts to the fixed Codex upstream without reading `auth.json` or producing a local authentication decision. No Pi Model, Pi CredentialStore, Provider Native sender, or semantic conversion state participates.

### 15.2 Provider Native Responses

If Direct Mode does not claim the selector, the handler resolves the published alias to a Pi `Model`. An explicit Provider Responses transport contract may then claim that model/operation:

```text
raw Responses body
→ Public Model / Pi Model resolution
→ ProviderResponsesLane.claims(model, operation)
→ Pi Models auth resolution
→ provider-native Responses sender
```

This lane preserves the raw Responses body as the model-visible authority while applying only boundary-required model identity projection, Provider auth/header rules, endpoint construction, response alias projection, and safe response handling. It does not execute Pi Client↔Provider semantic conversion.

### 15.3 Shared preservation requirements

Both preservation lanes preserve handles, hosted tools, conversation/prompt state, background jobs, and future wire fields without inventing Pi representations. They require:

- explicit lane-specific compatibility/capability selection;
- independent credential authority and transport ownership;
- safe path/header construction and no unrelated credential propagation;
- status/body/SSE lifecycle fidelity;
- cancellation and body-read failure handling;
- independent tests from Semantic Conversion;
- one failure journal on final failure;
- no reuse of native transport outcomes as Semantic Conversion failure facts.

If serving the request requires semantic reinterpretation or cross-protocol repair, native selection must fail **before execution** and the request may use Semantic Conversion only through its normal eligibility path.

## 16. Certification status

The earlier implementation-gap list was closed by frozen Tickets 12–18 and is
no longer a statement of current behavior. Ticket 28 binds this document by
content hash and certifies the Responses Semantic Conversion profile separately from
native preservation. Owning tests cover privileged prompt delivery, option
mapping, all closed-world item/tool families, argument errors, images/files,
reasoning-only history, previous-response hit/miss/store policies, response
identity/usage, and completed/incomplete/failed SSE contracts.

The 27 sanitized Codex CLI request fixtures additionally prove, one fixture at
a time, developer prompt delivery, effective tools/options, Lark grammar
handling, `store:false=honor`, and message/tool correlation through the public
route. The 2026-08-14 distribution record is `online-passed`: the Responses
route completed 60/60 real CommandCode cases and Codex CLI completed 60/60
(20 scenarios × 3) through the installed Provider Package. Direct Mode and
Provider Native Responses preservation remain independently owned/certified paths.
