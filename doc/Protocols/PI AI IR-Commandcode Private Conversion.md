# Pi AI IR ↔ CommandCode Private Conversion Method

# PART I: PI AI IR Request -> Commandcode Private Request

Governing revision marker retained for serving certification. This frozen document contains both request and response directions under the historical Part I/II authority.

Status: **Frozen normative design**

Owner: `commandcode-private` Provider adapter.
Boundary: Pi public Provider contracts ↔ CommandCode private wire.

## 1. Independence and authority

```text
Pi Context / SimpleStreamOptions
  ↕ CommandCode Provider adapter
CommandCode GenerateRequest / JSONL response
```

This adapter MUST NOT import, inspect, or name Anthropic Messages, OpenAI Responses, or any Client Protocol configuration. It receives already valid Pi data and applies only CommandCode conversion and compatibility rules.

The Provider owns:

- CommandCode request construction;
- headers and target authority validation;
- Pi history repair needed for CommandCode adjacency;
- HTTP attempts/retries/cancellation;
- JSONL decoding and event reconstruction;
- CommandCode→Pi semantic conversion;
- protocol-neutral upstream failure diagnostics.

It does not own Client error envelopes, Client session state, or Client conversion notices.

## 2. Configuration

Suggested configuration:

```json
{
  "providerAdapters": {
    "commandcode-private": {
      "conversion": {
        "request": {
          "syntheticMissingToolResultOutputType": "text"
        },
        "response": {
          "pauseTurn": "stop",
          "unknownEvent": "error"
        }
      },
      "request": {
        "transport": {
          "timeoutMs": 30000,
          "maxRetries": 0,
          "maxRetryDelayMs": 10000
        }
      },
      "response": {
        "errorCapture": {
          "bodyReadTimeoutMs": 5000,
          "maxBodyBytes": 65536,
          "maxClientMessageChars": 4096
        }
      }
    }
  }
}
```

The numbers above illustrate ownership, not universal frozen defaults. Implementation defaults MUST be derived from the existing Provider/runtime contract, documented, range-validated at startup, snapshotted, and immutable per process.

Frozen semantic defaults:

| Key | Values | Default |
|---|---|---|
| `syntheticMissingToolResultOutputType` | `text | error-text` | `text` |
| `pauseTurn` | `stop | error` | `stop` |
| `unknownEvent` | `error | ignore` | `error` |

Transport timing/retry limits are not semantic conversion policies. Reserved security headers, authority checks, malformed known events, and target closed-world validation are invariants, not switches.

## 3. Request pipeline

```text
Pi model + Context + SimpleStreamOptions
→ snapshot logical request facts
→ convert messages and tools
→ convert scalar options
→ build closed-world GenerateRequest
→ optional onPayload mutation/replacement
→ JSON serialize/parse
→ repeat closed-world authority and schema validation
→ prepare retry-stable logical request
→ per-attempt headers/trace/span
→ fetch CommandCode endpoint
```

No request is sent until semantic conversion and post-hook certification succeed.

## 4. Endpoint and headers

### 4.1 Endpoint

The selected Pi Model provides `baseUrl`; the CommandCode Provider supplies the fixed absolute endpoint path `/alpha/generate`. Construction is equivalent to `new URL("/alpha/generate", baseUrl)`: it retains the selected URL's scheme and authority, while replacing any base path and discarding any base query or fragment. The path is never appended to a base prefix.

Examples:

- `https://host` → `https://host/alpha/generate`;
- `https://host/prefix` → `https://host/alpha/generate`;
- production → `POST https://api.commandcode.ai/alpha/generate`.

Built-in catalog defaults and conversion contract are separate. A caller-provided certified model may use another base URL without changing message conversion.

### 4.2 Provider-authoritative headers

Provider-owned headers include authorization, content type, session/project authority, OSS/permission compatibility, and trace headers. Caller `options.headers` cannot override them.

The adapter:

- normalizes names case-insensitively;
- ignores attempts to override reserved headers;
- preserves valid non-reserved string extension headers;
- allows `null` to remove a prior generic extension value;
- rejects invalid value types;
- constructs a new trace span ID for each retry while retaining the logical trace ID where available.

Authorization, cookies, proxy credentials, hop-by-hop headers, and Provider authority fields are never opened by a generic configuration switch.

## 5. Top-level CommandCode request

The request is a closed-world object. Only certified fields are emitted.

### 5.1 Identity and model

- Pi selected model ID maps to the CommandCode model field defined by the Provider model contract.
- Pi session identity maps consistently to all CommandCode representations that require the same logical UUID, such as body thread ID and `x-session-id`.
- Model selector strings belong to the Client side and never enter this Provider conversion.

### 5.2 projectDir/project slug

`options.metadata.projectDir` is deployment context, not model-visible content.

- absent, empty, or non-string metadata → no project slug/header;
- a non-empty string is normalized by the Provider's project capability;
- if normalization of a non-empty value yields no slug, the documented root fallback may apply;
- project files, git output, and directory metadata never enter Pi history.

The implementation MUST match this exact contract; old claims that all missing/invalid values become root are incorrect.

### 5.3 max tokens and temperature

- `max_tokens = options.maxTokens ?? model.maxTokens`;
- the installed Pi `Model` contract requires `model.maxTokens`, so the CommandCode wire field is always present;
- each built-in CommandCode model derives `model.maxTokens` from its documented `maxOutputTokens` when available, otherwise from the official CommandCode CLI request default of 64000;
- request conversion does not add another fallback or guess a value outside the certified model contract;
- temperature maps when present and valid; absence uses target default.

### 5.4 Reasoning effort

Resolve `options.reasoning` through Pi model capability normalization:

1. If the model has an explicit `thinkingLevelMap`, use it; explicit null means unsupported.
2. Missing keys follow Pi's supported-level/clamping contract.
3. Without a map, Pi supported-level resolution clamps unsupported xhigh/max to the nearest supported value, normally high.
4. `off`/absence omits the CommandCode field.
5. Emit only target enum values accepted by CommandCode.

Do not describe clamp as a CommandCode default. It is Pi/model compatibility normalization.

### 5.5 Other options

Map target-backed options such as timeout/retry, signal, callbacks, session/project context, telemetry, fetch, and safe headers according to their runtime ownership.

Drop Pi options with no CommandCode wire counterpart, including generic samplingParams, cacheRetention, metadata, transport hints, websocket settings, environment overrides, and thinkingBudgets. They are auxiliary facts already presented to a target with no field.

`options.deferred` has no CommandCode wire field. `true` or a window object is ignored and the request executes synchronously. `false`/absence has the same wire result. This is the Provider-side defensive rule; the Client Core v1 deferred policy remains independent.

## 6. Pi messages → CommandCode messages

### 6.1 Source order

Process `Context.messages` in order. Preserve text, reasoning, tool calls, and results as far as the CommandCode schema permits. Before an event that would violate CommandCode's immediate call/result adjacency, flush synthetic missing results using §6.5.

### 6.2 UserMessage

Convert Pi text to CommandCode user text in order. The current CommandCode target accepts a data-URL image block, so Pi images map losslessly when the selected model declares image input. A text-only selected model cannot accept the image and conversion fails rather than silently removing core user content.

Pi text signatures/provenance and diagnostics have no CommandCode user-message field and are dropped.

### 6.3 AssistantMessage

Historical `AssistantMessage.stopReason` is not a CommandCode request field. Ignore it for every Pi value, including stop, length, toolUse, pending, error, aborted, deferred, and future runtime strings. Convert the message content only.

This decision does not trust malformed content:

- text and ordinary thinking convert normally;
- ToolCall ID/name/arguments must remain valid;
- lossless JSON object validation still applies;
- unsupported signatures/provenance are dropped or rejected according to their actual content rule;
- redacted thinking has no CommandCode representation and is dropped while preserving other content;
- stopReason never causes the entire content-bearing message to be skipped or rejected.

Same-target opaque signatures are not sent because the target has no signature field. They do not authorize fabricated plaintext.

### 6.4 ToolResultMessage

Map required identity and error semantics:

| Pi | CommandCode |
|---|---|
| `toolCallId` | ToolResult `toolCallId` |
| `toolName` | ToolResult `toolName` |
| `isError=false` | `output.type="text"` |
| `isError=true` | `output.type="error-text"` |
| ordered text content | target text value |

Images have no target representation:

- drop image blocks;
- concatenate/preserve text according to the target's single-value rule;
- if only images remain, send `value:""` to preserve call/result correlation;
- do not synthesize a textual image description.

`addedToolNames` and other Pi-only result metadata are dropped.

### 6.5 Provider-local missing-result repair

CommandCode requires immediate tool-result adjacency. When valid Pi history contains a ToolCall with no following matching result at the point a new non-result message begins or history ends, insert a Provider-owned synthetic ToolResult:

```text
toolCallId = pending call ID
toolName = pending call name
output.type = configured text|error-text (default text)
output.value = "No result — the tool call did not complete (interrupted or lost)."
```

This repair is independent of Client adapters. It never modifies a real result and never repairs an orphan result, duplicate result, ID mismatch, or invalid JSON arguments.

## 7. Pi tools → CommandCode tools

Map:

- name → name;
- description → description;
- JSON schema parameters → input_schema, preserving lossless JSON;
- missing target-required description/default → target default.

CommandCode has no constrained-sampling field. Drop every Pi `constrainedSampling` variant, including JSON schema strict `require`, `prefer`, grammar, and false/absence. Continue converting the tool.

Dropping `require` is a frozen availability-oriented exception to Pi's hard capability meaning. Emit a Provider request conversion notice for `require`; ordinary prefer/grammar drops may be documented without per-request noise unless configuration explicitly requests notice.

Never inject constraint instructions into the system prompt or tool description.

## 8. onPayload and final certification

`onPayload` is an optional request hook. It may mutate or replace the candidate exactly once before retry.

After the hook:

1. serialize to JSON;
2. parse back to plain JSON;
3. require a closed-world GenerateRequest;
4. revalidate target types, required fields, message lifecycle, model authority, reserved configuration, project/session identity, and tool schemas;
5. reject any unapproved key or invalid replacement before fetch.

Retries reuse certified logical body facts. They may refresh attempt-owned headers, span IDs, timeout state, and callbacks but do not rerun semantic conversion or silently re-read project state.

## 9. Response transport and reconstruction

### 9.1 HTTP

Non-2xx HTTP failures are captured by the request-local attempt/Provider error path, not a process-global observer. Capture is bounded by Provider response configuration and becomes a protocol-neutral failure diagnostic.

The immutable Provider policy is the outer acquisition limit. The shared neutral diagnostic is deliberately narrower: effective retained capture is `min(maxBodyBytes, 65_536)` and effective safe message length is `min(maxClientMessageChars, 1_024)`. A broader configured value never enlarges the public Pi diagnostic. Reader failure, body-read timeout, malformed length, attempt-timeout race, or cleanup failure during best-effort capture preserves the already-known HTTP failure and marks capture truncated; instrumentation never replaces the primary failure. The caller lifecycle signal remains authoritative and may cancel capture.

HTTP 200 establishes a JSONL transport, not semantic success. A later stream `error`/`abort` is still a failure.

### 9.2 JSONL decoding

- Decode complete lines with bounded buffers.
- Malformed JSON/known event schema is a protocol failure.
- Physical EOF is success only after a valid final finish and all modeled blocks are closed.
- Cancellation discards incomplete state and stops fetch/reader/retry work.

### 9.3 Event catalog

Known semantic events include text/reasoning/tool lifecycle, finish, error, and abort. Known non-semantic events may be dropped only after validating the fields that influence a later mapped result.

`finish-step` is not a blanket no-op: its response identity maps under §10.2. `tool-result` echo/provider-metadata/start markers with no Pi AssistantMessage target are dropped.

A future unknown event follows Provider `unknownEvent`:

- `error` (default): fail reconstruction;
- `ignore`: validate it as a bounded object, record a non-model-visible diagnostic/notice, and continue.

Ignoring unknown events never supplies a terminal finish. A known final finish remains required.

Complete known-event matrix:

| CommandCode event | Reconstruction action |
|---|---|
| `text-start` | Open one text slot; reject illegal overlap/duplicate lifecycle. |
| `text-delta` | Append to the open text slot. |
| `text-end` | Close the text slot. |
| `reasoning-start` | Open one reasoning slot. |
| `reasoning-delta` | Append to the open reasoning slot. |
| `reasoning-end` | Close the reasoning slot. |
| `tool-input-start` | Open tool-input lifecycle and retain validated ID/name preview only. |
| `tool-input-delta` | Append preview bytes/text; never commit as final arguments. |
| `tool-input-end` | Close preview lifecycle; still await authoritative final tool-call. |
| `tool-call` | Validate and commit authoritative ID/name/lossless object arguments. |
| `finish-step` | Validate response object; retain last valid response id/model identity and any fields needed for final cross-check. Do not make step usage override final finish usage. |
| `finish` | Validate finish reason/raw reason/total usage; mark semantic terminal candidate. |
| `error` | Construct neutral upstream-stream failure with all safe structured fields. |
| `abort` | Construct provider-abort failure; never caller cancellation. |
| `start`, `start-step` | Validate known required shape, then drop if no Pi semantic field. |
| `provider-metadata` | Validate bounded known shape; drop model-invisible metadata unless an approved neutral diagnostic consumes a safe field. |
| `tool-result` | Response-side echo has no Pi AssistantMessage target; validate known shape then drop. |
| future unknown event | `unknownEvent`, default error; ignore cannot replace finish. |

### 9.4 Content reconstruction

Maintain ordered, typed staged slots for text, reasoning, and ToolCall. Start/delta/end lifecycle must be complete. Partial tool arguments are never committed as a ToolCall. Final tool-call event data is authoritative and must be a lossless JSON object.

## 10. CommandCode success → Pi AssistantMessage

### 10.1 Commit boundary

No Pi success event is emitted until:

- physical response transport ends correctly;
- a valid final finish exists;
- all modeled slots are closed;
- pause policy is resolved;
- content and usage validation succeed.

After commit, replay a normal Pi event stream from the immutable result.

### 10.2 Identity

Use the last valid `finish-step.response.id/modelId` as Pi `responseId/responseModel`. If none exists, omit these optional fields; do not invent upstream identity.

Final finish usage remains authoritative. Multiple finish-step identities are last-wins after schema validation; mismatches may create diagnostics.

Pi required `timestamp` remains the request/response-lifetime timestamp chosen by the Provider adapter unless the CommandCode contract explicitly makes a server timestamp authoritative. Do not silently substitute an ambiguous finish-step timestamp.

### 10.3 Content

- CommandCode text → Pi TextContent;
- CommandCode reasoning → Pi ThinkingContent, even if the model catalog says `reasoning:false`; already received representable content is not rejected by request capability metadata;
- CommandCode final tool call → Pi ToolCall with preserved ID/name and lossless JSON object arguments;
- provider signatures/provenance with no installed Pi 0.84.1 slot are omitted or retained only in Pi fields that actually exist;
- the installed Pi type, not a newer vendored source field such as ToolCall.namespace, is authoritative.

### 10.4 Stop reason normalization

1. A normalized `length` finish → Pi `length`.
2. Otherwise, if converted content contains any ToolCall → Pi `toolUse`.
3. Otherwise → Pi `stop`.
4. Preserve original raw finish reason in `rawStopReason`.
5. If wire finish category disagrees with content-derived result, add a non-model-visible mismatch diagnostic.

### 10.5 Usage

Preserve and validate all target-backed token facts:

- input tokens;
- output tokens;
- cached input/read tokens;
- cache-write tokens where present;
- reasoning tokens;
- one-hour cache tokens only where the CommandCode wire provides an authoritative retention split;
- total tokens and known aliases.

The final finish total usage is authoritative. Direct total/alias fields are consumed and cross-checked rather than ignored; derived totals are used only where source fields are absent. Require non-negative finite integers and enforce target invariants such as reasoning≤output and consistent totals.

The currently evidenced CommandCode schema exposes `cacheWriteTokens` but no one-hour retention split. Therefore Pi `cacheWrite1h` is omitted. Treating all cache writes as one-hour writes would invent a provider fact.

Pi cost is computed only where a trusted model cost contract applies; it is not taken from arbitrary wire metadata.

System prompt token facts may enter Pi diagnostics where the public type permits, but never become model-visible content.

## 11. pause_turn

At EOF, after valid finish and closed modeled slots, exact `rawFinishReason="pause_turn"` uses Provider response policy:

### 11.1 `stop` (default)

- do not rollback staged content or usage merely because of pause_turn;
- run all normal content/usage semantic validation;
- commit response identity, content, usage, rawStopReason, and a pause diagnostic;
- normalize stop reason with §10.4: length remains length; otherwise ToolCall content→toolUse, else stop.

Clients will see their ordinary completed/end-turn representation. `rawStopReason` remains Pi-internal. This is a deliberate availability degradation and does not claim CommandCode pause content is logically final.

### 11.2 `error`

Rollback staged semantic state and return a non-retryable Provider protocol failure with a neutral pause classification. Do not expose a Client-specific pause/deferred term.

### 11.3 Evidence status

The repository lacks a real CommandCode pause fixture proving whether every pause requires Anthropic-style content resubmission. The configurable policy and default are frozen; exact upstream semantics remain evidence-insufficient until online certification captures a sample.

## 12. Error, abort, and cancellation

### 12.1 Stream error

A CommandCode HTTP-200 stream error may contain message, statusCode, retryability, type, code, and bounded body facts. Preserve these in a protocol-neutral Pi diagnostic; do not reduce them to `error.message` before execution.

Validate status as an integer legal for HTTP rendering before any Client may use it. Retryability is independent of client status.

### 12.2 Wire abort

CommandCode `{type:"abort"}` is an upstream/provider abort failure. It is not caller cancellation and MUST NOT become Pi `aborted` solely because of the event name. Preserve it as a neutral upstream-stream failure.

### 12.3 Caller cancellation

Only the request lifecycle signal marks Pi `aborted`/cancellation. It cancels fetch, reader, retry sleep, and request-local capture; discards partial content/tool calls; and does not write to a closed client response.

### 12.4 HTTP, transport, timeout, protocol, callback

Produce a neutral failure diagnostic with the actual class and available safe facts. Do not guess status from text. Configuration/internal callback errors normally remain 500-class; transport/upstream protocol normally 502-class; timeout may map to 504; a validated upstream HTTP/stream status may be preserved by the Client renderer.

Cause/stack remains log-private. A safe human message remains in `errorMessage` as fallback.

## 13. Pi event replay

For a successful immutable result:

```text
start
content block start/delta/end in order
done(stop|length|toolUse)
```

For deferred Core output, the runtime's dedicated deferred contract is required; this Provider does not invent a handle.

For error/aborted:

- emit one Pi error terminal with the neutral diagnostic;
- do not emit staged partial ToolCalls;
- caller-aborted result has empty content/zero usage unless the Pi public contract explicitly supports committed partial cancellation, which current LuckyToken does not.

Every started physical attempt produces one immutable trusted attempt diagnostic. Failed attempts record neutral classification, stage, optional validated status/retryability, and fixed allowlisted IDs. A final successful attempt is also recorded, so later Client rendering failures do not erase upstream retry history. Execution submits these diagnostics in order to the invocation facts sink; only the Client handler owns the exactly-once journal lifecycle.

## 14. Transport limits and retries

Provider-owned configuration covers request timeout, max retries, max retry delay, response body-read timeout, bounded error bytes, and safe client-message length. Values are validated at startup.

Retry rules:

- same logical request body across attempts;
- new attempt-owned trace/span facts;
- honor caller cancellation;
- retry only classified retryable failures;
- never reuse another request's observation;
- one final failure journal contains summaries of all attempts.

The CommandCode bound fetch is never wrapped by a Client HTTP observer.
Conversion handlers do not inject custom fetch into any Pi adapter; every
Provider must publish trusted failure facts through neutral Pi diagnostics.
Response cloning or unbounded observer reads are forbidden.

## 15. Completion state

Tickets 20–26 implement this Provider method, including structured stream/HTTP failures,
retry attempt diagnostics, execution fact promotion, bounded capture, and request-local
isolation. The current contraction removes the remaining Client observer side channel;
Ticket 28 owns full-route certification. Online CommandCode evidence was not run for this
completion and remains evidence-insufficient.
