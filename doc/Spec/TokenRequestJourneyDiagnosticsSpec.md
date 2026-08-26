# Token Request Journey Diagnostics Specification

- **Status:** CURRENT — full-journey capture and unified Request Journey cutover implemented
- **Date:** 2026-08-25
- **Scope:** Data Plane request journey, failure location, investigation artifacts, fail-open observation runtime, and one diagnostics persistence authority
- **Out of scope:** physical SQL/index tuning, final Desktop layout, and legacy data migration/import (not provided)

This document establishes the request-processing map and observation contract implemented by Token's unified Request Journey diagnostics system.

It does not create a shared execution path. Direct Mode, Provider Native Preservation, and Semantic Conversion remain independent. They share only request-edge and lifecycle observation facts allowed by the architecture.

Normative sources:

- [Protocol Conversion Architecture and Policy](../Protocols/Protocol%20Conversion%20Architecture%20and%20Policy.md)
- [OpenAI Responses ↔ Pi AI IR Conversion Method](../Protocols/OpenAI%20Responses-Pi%20AI%20IR%20Conversion%20Method.md)
- [Anthropic Messages ↔ Pi AI IR Conversion Method](../Protocols/Anthropic-Pi%20AI%20IR%20Conversion%20Method.md)
- [Pi AI IR Protocol](../Protocols/Pi%20AI%20IR%20Protocol.md)
- [Token Core Architecture Specification](./TokenCoreSpec.md)

## 1. Model and scope

### 1.1 One request record, one diagnostics authority

Every admitted Data Plane request has one authoritative `RequestJourneyRecord` identified by one Token request ID. A non-successful journey attaches one `RequestIncident` to that record. Timeline events, failure facts, attempts, request/response evidence, and capture-integrity facts are sections of that record rather than independently correlated persistence authorities.

The record is an observation model, not a request execution abstraction and not a second semantic IR.

Application-level Runtime Diagnostics facts that have no Request Journey owner, such as startup failure or diagnostics-storage unavailability, must not be forced into a fabricated request. The single authority uses a discriminated `DiagnosticsRecord` family with `request_journey` and `runtime_event` variants. Sections 2 through 13 define the `request_journey` variant; section 14 defines their shared observation and persistence authority. Any fact owned by a request appears only in that journey; it is not duplicated as a Runtime Event.

### 1.2 Data Plane operations

| Operation | Current route | Lane behavior |
|---|---|---|
| `model_generation` | `POST /v1/messages` | Provider Native or Semantic Conversion |
| `model_generation` | `POST /v1/responses` | Direct Mode, Provider Native, or Semantic Conversion |
| `conversation_compaction` | `POST /v1/responses/compact` | Direct Mode, Provider Native, or Semantic Conversion |
| `model_discovery` | `GET /v1/models` | No execution lane; Backend-owned metadata query |
| `web_search` | `POST /v1/alpha/search` | Direct Mode through the Codex-owned caller-envelope and transport boundary; upstream owns authentication |
| `image_generation` | `POST /v1/images/generations`, `POST /v1/images/edits` | Direct Mode through the Codex-owned Images module |
| `realtime_session` | `POST /v1/live`, `POST /v1/realtime/calls`, supported Realtime WebSocket upgrades | Direct Mode through the Codex-owned Realtime module |
| `unmatched_request` | any unmatched method/path | No execution lane; HTTP routing rejection |
| `unsupported_transport` | unsupported WebSocket upgrade | No execution lane; HTTP transport rejection |

Implementation may proceed in vertical slices beginning with `model_generation`, but completion requires every operation in this table to enter the same Journey authority from HTTP admission.

### 1.3 Three levels of location

An observed event uses three levels rather than one flat stage string:

1. **Journey Phase** — stable across operations and lanes;
2. **Lane Step** — owned by the selected lane or operation;
3. **Detail Location** — direction, semantic subject, source path, and attempt.

A failure message or HTTP status is evidence. It is not a Failure Location.

### 1.4 Origin, detection, and presentation

The record keeps these facts distinct:

| Fact | Meaning |
|---|---|
| Origin | Where the failing condition actually arose, when proven |
| Detection | The Token or Provider seam that first confirmed the failure |
| Presentation | The Client Protocol error status/type/body constructed for the caller |

When only an external boundary is known, the origin precision is `external_boundary`; the record must not claim an exact external implementation location.

## 2. Universal Journey phases

| ID | Journey Phase | Begins when | Produces | Minimum failure evidence |
|---|---|---|---|---|
| P0 | `http_admission` | Node HTTP accepts an inbound request or upgrade | request ID, operation candidate, cancellation/timeout lifecycle | method, path, transport state, abort/timeout reason |
| P1 | `protocol_ingress` | a Fetch `Request` exists | route result, Client Protocol, captured Client Request Wire, parsed wire candidate, Request Identity | route, media type, encoding, size, parse/validation location |
| P2 | `request_resolution` | a model-serving request has a selector candidate | local recognition result, Public Model result, Provider Native eligibility, committed lane | selector, capability decision, provider/model snapshot when resolved |
| P3 | `lane_request_preparation` | one lane or non-lane operation owns the request | credential/profile facts, outbound native request or Pi invocation facts | committed lane, failing Lane Step, safe credential/profile attribution |
| P4 | `upstream_execution` | execution or upstream dispatch begins | attempts, upstream request/response facts, Pi events where applicable | operation, attempt, transport phase, upstream status and safe IDs |
| P5 | `lane_response_processing` | a lane has an upstream/native/Pi result | preserved native response or Client-protocol-ready semantic result | response read/parse/projection step, terminal facts |
| P6 | `client_response_preparation` | Client Protocol construction begins | Client Response Wire candidate, protocol status/type, response ID | render step, fidelity failure, safe error mapping |
| P7 | `outcome_commit` | the truthful terminal outcome is known | terminal outcome, usage, timeline, Incident, artifact completeness | terminal authority, success/failed/aborted distinction |
| P8 | `http_handoff` | Backend gives the prepared `Response` to HTTP transport | status/headers/body handed to `ServerResponse`, handoff outcome | writable state, write/read failure, connection close facts |

`http_handoff` never means client consumption. A response connection may close after semantic success; this changes handoff evidence, not the already committed model-execution outcome.

## 3. Common ingress and lane selection matrix

| Order | Phase | Step | Applies to | Required artifact/fact | Representative failures |
|---:|---|---|---|---|---|
| 1 | P0 | `admit_http_request` | all HTTP requests | method, path, accepted time, request ID | server draining, malformed transport state |
| 2 | P0 | `establish_cancellation` | all HTTP requests | caller signal, shutdown signal, timeout policy | caller disconnect, timeout, shutdown |
| 3 | P1 | `resolve_route` | all HTTP requests | matched operation and protocol when any | unmatched route/method |
| 4 | P1 | `capture_client_request_wire` | matched requests | safe headers and bounded body stream | body read/capture failure |
| 5 | P1 | `validate_media_and_encoding` | body-bearing operations | content type and content encoding | unsupported content type/encoding |
| 6 | P1 | `read_and_decode_body` | body-bearing operations | bytes read, limit, decoded JSON/wire shape | body too large, invalid JSON, aborted read |
| 7 | P1 | `establish_request_identity` | serving/compaction operations | effective session ID and optional client session ID | invalid identity carrier handled per protocol contract |
| 8 | P1 | `validate_client_wire` | serving/compaction operations | protocol validation result | missing required fields, invalid known shapes |
| 9 | P2 | `extract_model_selector` | model-bound operations | opaque client selector | missing/invalid selector |
| 10 | P2 | `recognize_direct` | operations supporting Direct Mode | explicit local capability result | local recognition authority unavailable |
| 11 | P2 | `resolve_public_model` | requests not claimed locally | alias/provider/real-model snapshot | unknown or unavailable alias/model |
| 12 | P2 | `recognize_provider_native` | resolved compatible operations | explicit provider/API/operation capability result | invalid or absent capability contract |
| 13 | P2 | `commit_lane` | model-bound operations | exactly one lane or explicit failure | no valid execution contract |

Direct Mode recognition occurs before Public Model resolution where the protocol exposes that lane. Provider Native recognition occurs only after a Pi model has been resolved. Once `commit_lane` succeeds, failure cannot fall through to another lane.

Request Identity is correlation/session information. It is not Client authorization. Direct Mode preserves caller credentials as unobserved Client Wire; Provider Native resolves its independent Provider credential only after that lane owns the request.

## 4. Direct Mode steps

| Order | Phase | Lane Step | Input | Output/artifact | Failure source examples |
|---:|---|---|---|---|---|
| 1 | P3 | `recognize_local_model` | opaque selector | local model/capability fact | model registry/capability authority |
| 2 | P3 | `preserve_caller_envelope` | authoritative Client Wire | bounded transport-ready caller envelope; credentials remain unobserved | request read/cancellation failure |
| 3 | P3 | `project_local_request` | authoritative Client Wire | boundary-required model/header projection | invalid boundary projection |
| 4 | P3 | `construct_direct_envelope` | preserved request | fixed endpoint, method, headers, encoding | endpoint/header construction failure |
| 5 | P4 | `dispatch_direct_transport` | local upstream envelope | upstream response handle | DNS/connect/TLS/write/timeout/cancellation |
| 6 | P4 | `read_direct_response` | upstream response handle | bounded upstream response artifact | body read, stream, unexpected EOF |
| 7 | P5 | `preserve_direct_response` | compatible upstream wire | Client Wire response candidate | incompatible or malformed preserved response |
| 8 | P5 | `observe_local_usage` | preserved response | optional normalized usage | malformed optional usage; never change response outcome |

Images uses `commit_direct_images_lane`; Realtime HTTP and WebSocket use `commit_direct_realtime_lane`. A Realtime WebSocket Journey records admission with `transport=websocket`, enters `relay_realtime_frames` only after the upstream handshake succeeds, and remains active until both socket directions settle. Its P5 terminal step is `preserve_realtime_close`; normal close commits `success`, caller-abnormal or shutdown close commits `aborted`, and upstream connection/frame failure commits `failed`. P8 records the WebSocket close handoff. Observations never include credentials, account IDs, SDP, audio, or complete frame payloads.

The Direct Mode lane does not depend on Public Model alias resolution, Provider Profiles, Pi AI IR, or Pi Provider execution.

Direct Mode is an opaque passthrough: the upstream response body, status, and
end-to-end headers are preserved for the caller unchanged while a new HTTP or
WebSocket connection may rebuild transport/framing headers. Once a request has
committed to Direct Mode, Token-owned response headers (such as
`x-token-request-id`) are never added to either a preserved upstream response
or a Token-synthesized Direct Mode error. Request correlation remains in the
fail-open diagnostics path rather than the Client Wire.

## 5. Provider Native Preservation steps

| Order | Phase | Lane Step | Input | Output/artifact | Failure source examples |
|---:|---|---|---|---|---|
| 1 | P3 | `capture_provider_profile` | resolved provider and request binding | exact request-bound Profile facts | no usable Profile/binding failure |
| 2 | P3 | `resolve_provider_auth` | resolved Pi model and Profile binding | Pi `AuthResult`, safe auth type attribution | missing auth, refresh/setup failure |
| 3 | P3 | `project_native_body` | authoritative Client Wire body | model-only projection or explicit Anthropic OAuth projection | malformed JSON, unsafe OAuth projection |
| 4 | P3 | `reconstruct_provider_envelope` | model, auth, operation, projected body | method, endpoint, headers, encoding/compression | missing endpoint/session/header facts |
| 5 | P4 | `dispatch_provider_native` | reconstructed envelope | upstream response handle | connect/write/timeout/cancellation |
| 6 | P4 | `classify_native_retry` | response/error and Provider contract | retry decision and delay | invalid retry delay, retry policy failure |
| 7 | P4 | `advance_provider_profile` | validated final HTTP 429 and binding | next request-bound Profile or terminal decision | no eligible Profile, transition failure |
| 8 | P4 | `read_provider_native_response` | upstream response handle | bounded response bytes/stream artifact | body read, stream parse, unexpected EOF |
| 9 | P5 | `project_native_alias` | response wire and client alias | alias-safe response wire | missing/ambiguous model position |
| 10 | P5 | `preserve_provider_response` | compatible provider wire | Client Wire response candidate | protocol incompatibility |
| 11 | P5 | `observe_provider_native_usage` | preserved response | optional normalized usage | malformed optional usage; never change response outcome |

This lane never enters Pi AI IR or Pi Provider semantic execution. Its credential, request construction, retry, transport, and response processing remain independent from Direct Mode and Semantic Conversion.

## 6. Semantic Conversion request direction: Client Wire to Pi IR

The current `pi-composition` label is too coarse. A request-side failure uses `direction=client_to_pi` and one of the following Lane Steps.

| ID | Phase | Lane Step | Semantic subjects | Important location detail |
|---|---|---|---|---|
| SREQ-01 | P3 | `validate_client_semantics` | envelope, messages, content, tools, reasoning, metadata | Client JSON path and violated target invariant |
| SREQ-02 | P3 | `resolve_client_local_state` | previous response, conversation state, compaction | state authority, handle, commit/lookup phase |
| SREQ-03 | P3 | `resolve_trusted_client_resource` | item reference, image, file | owning resolver, limits, source path, abort state |
| SREQ-04 | P3 | `convert_request_envelope` | selector, generation controls, metadata, cache | source field and Pi target slot or omission rule |
| SREQ-05 | P3 | `convert_system_instructions` | system, developer, instructions | privilege policy and source order |
| SREQ-06 | P3 | `convert_message_content` | text, image, file, document, hosted transcript | role, item/content family, source order, source path |
| SREQ-07 | P3 | `convert_tool_definitions` | function, custom/grammar, namespace, hosted tools | execution owner, schema, name/namespace projection |
| SREQ-08 | P3 | `correlate_tool_lifecycle` | tool call, tool result/output, tool reference | call/result ID, duplicate/orphan/unresolved state |
| SREQ-09 | P3 | `convert_reasoning_continuity` | thinking, reasoning, signatures, compaction | provenance authority, status, envelope version |
| SREQ-10 | P3 | `apply_semantic_repairs` | unresolved calls, missing results, unknown values | repair/ignore/degrade policy and notice code |
| SREQ-11 | P3 | `finalize_pi_invocation` | Pi Context, tools, SimpleStreamOptions, render state | frozen invocation snapshot and request-local notices |

Protocol-specific detail remains owned by its Client Protocol adapter. Anthropic and OpenAI Responses may use the same Lane Step names, but they do not share converter implementations, configuration, mutable correlation state, or protocol DTOs.

### 6.1 Request semantic subjects

| Subject | Representative subdomains |
|---|---|
| `envelope` | model selector, stream, store, metadata, generation controls, cache controls |
| `system` | Anthropic system blocks, Responses instructions, privileged message policy |
| `message` | role, source order, status, assistant prefill/history |
| `content` | text, image, file, document, refusal, hosted transcript |
| `tool` | function/custom definition, grammar, namespace, execution ownership |
| `tool_call` | ID/name/namespace/arguments, unresolved lifecycle |
| `tool_result` | correlation, duplicate/orphan state, error/content semantics, added tool names |
| `reasoning` | thinking budgets, effort, visible reasoning, continuity signatures, compaction |
| `metadata` | user/safety identity and request-local response echo |

## 7. Semantic Conversion execution and Provider directions

Pi is the only shared semantic boundary. The execution phase contains two Provider-owned conversion directions around the transport.

| ID | Direction | Phase | Lane Step | Owner | Minimum failure evidence |
|---|---|---|---|---|---|
| SEXEC-01 | none | P3 | `capture_semantic_profile` | Semantic Conversion binding | safe Profile ID/type and selection reason |
| SEXEC-02 | none | P3 | `bind_provider_auth` | Semantic Conversion binding / Pi Models | provider, auth/setup phase, safe failure class |
| SEXEC-03 | none | P4 | `create_pi_stream` | Core execution / Pi Models | sync/async construction phase, exception chain |
| SEXEC-04 | `pi_to_provider` | P4 | `convert_pi_request` | selected Pi Provider | Pi semantic subject, Provider conversion step |
| SEXEC-05 | `pi_to_provider` | P4 | `construct_provider_envelope` | selected Pi Provider | endpoint/method/header/encoding phase without credentials |
| SEXEC-06 | none | P4 | `dispatch_provider_transport` | selected Pi Provider | connect/write/timeout/cancellation phase |
| SEXEC-07 | none | P4 | `read_provider_response` | selected Pi Provider | response headers/body/stream phase, status, safe IDs |
| SEXEC-08 | `provider_to_pi` | P4 | `decode_provider_events` | selected Pi Provider | upstream event kind, parser state, semantic subject |
| SEXEC-09 | `provider_to_pi` | P4 | `construct_pi_terminal` | selected Pi Provider | terminal type/reason, partial state, trusted failure fact |
| SEXEC-10 | none | P4 | `validate_pi_terminal` | Core execution | missing, inconsistent, deferred, or unknown terminal |
| SEXEC-11 | none | P4 | `arbitrate_cancellation` | Core execution + HTTP signal | caller signal versus late Provider/Pi event |
| SEXEC-12 | none | P4 | `normalize_terminal_usage` | execution usage observer | API declaration, terminal class, completeness reason |
| SEXEC-13 | none | P4 | `advance_semantic_profile` | Semantic Conversion binding | validated final 429, attempt, transition result |

The Client Protocol adapter must not inject a custom transport to observe SEXEC-04 through SEXEC-09. Under pinned Pi 0.84.2, each owning OpenAI Responses or Anthropic semantic executor records the complete provider-native payload returned by its exclusive `onPayload`, safe response status/headers from `onResponse`, and the complete decoded Pi `AssistantMessage`. The protocols do not share a semantic invocation or serializer. Adapter/SDK-internal HTTP wire and raw Provider response events are not required artifacts. A required public callback or Pi terminal that was not reached is recorded explicitly as unavailable; it is never replaced by a summary labelled complete.

### 7.1 Provider semantic subjects

`convert_pi_request` and `decode_provider_events` may locate failures within `system`, `message`, `content`, `tool`, `tool_call`, `tool_result`, `reasoning`, `usage`, `stop_reason`, or Provider-specific envelope framing. Provider-specific fields do not enter the common Pi IR merely for diagnostics.

## 8. Semantic Conversion response direction: Pi IR to Client Wire

A response-side failure uses `direction=pi_to_client` and one of the following Lane Steps.

| ID | Phase | Lane Step | Semantic subjects | Important location detail |
|---|---|---|---|---|
| SRES-01 | P5 | `validate_assistant_message` | envelope, content, usage, stop reason | Pi field and target representability invariant |
| SRES-02 | P5 | `project_response_content` | text, thinking, redacted thinking, image, refusal | content index/type and target block/item family |
| SRES-03 | P5 | `project_response_tool_calls` | tool call, namespace, arguments | ID/name/namespace and lossless JSON requirement |
| SRES-04 | P5 | `project_response_reasoning` | thinking, reasoning continuity, signatures | provenance and target continuity support |
| SRES-05 | P5 | `project_response_stop_reason` | stop reason, status, incomplete reason | Pi terminal fact versus target lifecycle |
| SRES-06 | P5 | `project_response_usage` | input/cache/output/reasoning usage | component source, completeness, target required/default fields |
| SRES-07 | P5 | `update_client_response_state` | response ID/history/store policy | commit point, persistence outcome, caller policy |
| SRES-08 | P6 | `construct_client_envelope` | response/message identity, model echo, metadata | required and nullable target fields |
| SRES-09 | P6 | `encode_client_json` | complete Client response | JSON serialization and size bounds |
| SRES-10 | P6 | `encode_atomic_sse` | ordered Client events | sequence/order, start/delta/terminal uniqueness |
| SRES-11 | P6 | `validate_response_fidelity` | complete Client Wire | unsupported Pi content, namespace, non-JSON value, missing terminal |
| SRES-12 | P6 | `render_client_error` | failure presentation | safe status/type/code/message/header mapping |

JSON and atomic SSE are encodings of the same fully converted Client response. Encoding must not reinterpret Pi semantics independently.

## 9. Non-generation operation steps

### 9.1 Conversation compaction

Compaction uses the common P0-P2 flow and may select all three lanes. Its additional subjects are compaction request validation, native compact capability, local state expansion, summarization invocation, compaction envelope provenance, and compact response projection. It requires the same Request Journey Record and failure-location precision as model generation.

Current implementation gap: `POST /v1/responses/compact` does not begin the Request Ledger, Invocation Diagnostics, or Deep Capture lifecycle used by the generation handlers.

### 9.2 Model discovery

Model discovery uses P0, P1, P6, P7, and P8. Its operation steps are `read_publication_snapshot`, `project_model_list`, and `encode_model_list`. It does not select a Data Plane Lane.

Current implementation gap: `GET /v1/models` has no Request Journey record or request ID.

### 9.3 Routing and transport rejection

Unmatched routes, drain rejection, and unsupported WebSocket upgrades terminate before lane selection. Supported Codex Realtime upgrades instead commit the Direct Mode lane and remain in one Journey through session close. All admitted upgrades use `transport=websocket`; a rejected upgrade may still write an HTTP 426 or pre-101 error envelope at P8. A malformed connection that never becomes an HTTP request is a runtime transport incident rather than a Request Journey.

## 10. Request Artifact matrix

Every artifact slot has a state: `captured`, `partial`, `unavailable`, or `not_applicable`. Captured artifacts also declare redaction, truncation, original byte count when known, captured byte count, media type, and integrity hash when safe.

| Artifact | Owner | Direct Mode | Provider Native | Semantic Conversion | Required on failure |
|---|---|---:|---:|---:|---:|
| Client Request Wire | Client Protocol edge | yes | yes | yes | yes, bounded and redacted |
| Parsed Client Request summary | Client Protocol adapter | yes | yes | yes | yes when parsing succeeded |
| Lane decision | request resolution | yes | yes | yes | yes |
| Local outbound request wire | Direct Mode | yes | n/a | n/a | yes when constructed |
| Provider Native outbound request wire | Provider Native | n/a | yes | n/a | yes when constructed |
| Complete protocol-owned invocation/Pi IR | Client Protocol adapter | n/a | n/a | yes | yes when finalized |
| Pi Provider request payload at the public `onPayload` seam | owning Client Protocol semantic executor | n/a | n/a | yes | yes when assembled |
| Upstream response wire | owning native lane transport | yes | yes | n/a | yes when observed |
| Pi response metadata and decoded response IR | owning Client Protocol semantic executor | n/a | n/a | yes | yes when observed/decoded |
| Complete Pi terminal IR | owning Client Protocol semantic module | n/a | n/a | yes | yes when any event was observed |
| Client Response Wire | Client Protocol edge / HTTP transport | yes | yes | yes | yes when constructed |
| Timeline and attempts | Journey observation | yes | yes | yes | yes |
| Failure and exception chain | failing owner + redaction choke point | yes | yes | yes | yes |
| Safe request context | Journey observation | yes | yes | yes | yes |

Credential values, cookies, authorization capabilities, raw local credential state, Control Plane capability, and unrelated environment values are never Request Artifacts. A safe Profile identifier, display name, auth type, and selection reason are attribution facts rather than credential material.

## 11. Failure source matrix

| Failure source authority | Typical phases | Required classification facts |
|---|---|---|
| Client | P0-P3 | protocol, source path, invalid value class, Client status |
| Token request edge | P0-P2, P6-P8 | module/step, invariant, exception fingerprint, handoff state |
| Direct integration | P3-P5 Direct Mode | owning module and transport phase; never caller credential values |
| Provider credential/profile authority | P3-P4 Provider Native/Semantic | provider, safe Profile attribution, auth/setup phase, attempt |
| Pi Client conversion | P3/P5 Semantic | direction, adapter, Lane Step, semantic subject, source path, notice/repair policy |
| Pi Provider conversion | P4 Semantic | direction, provider/API, Lane Step, semantic subject, trusted failure fact |
| Remote Provider | P4-P5 | status, provider type/code, safe message, safe request IDs, retryability |
| Network/OS environment | P4/P8 | connect/read/write/timeout/close phase and safe error class |
| Diagnostics observation subsystem | any phase; operational when no request record can commit | affected artifact/record section, observation phase, completeness degradation; never a replacement request failure |

## 12. Failure Location shape

This is a semantic contract candidate, not yet a persistence schema:

```ts
interface RequestJourneyLocation {
  readonly phase:
    | "http_admission"
    | "protocol_ingress"
    | "request_resolution"
    | "lane_request_preparation"
    | "upstream_execution"
    | "lane_response_processing"
    | "client_response_preparation"
    | "outcome_commit"
    | "http_handoff";
  readonly lane?:
    | "direct"
    | "provider_native"
    | "semantic_conversion";
  readonly direction?:
    | "client_to_pi"
    | "pi_to_provider"
    | "provider_to_pi"
    | "pi_to_client";
  readonly step: string;
  readonly subject?:
    | "envelope"
    | "system"
    | "message"
    | "content"
    | "tool"
    | "tool_call"
    | "tool_result"
    | "reasoning"
    | "metadata"
    | "usage"
    | "stop_reason";
  readonly sourcePath?: string;
  readonly attempt?: number;
}
```

Examples:

```text
P3 / semantic_conversion / client_to_pi
correlate_tool_lifecycle / tool_result / $.messages[4].content[2]

P4 / semantic_conversion / provider_to_pi
decode_provider_events / tool_call / event[37]

P3 / provider_native
project_native_body / envelope / $.model / attempt 2

P8
write_http_response / response_body
```

## 13. Record invariants

1. One admitted request has one request ID and one Request Journey Record.
2. Every observer and artifact section uses that same request ID; no subsystem mints a second correlation ID.
3. A request has at most one committed Data Plane Lane. No failure after lane commitment changes the lane or falls through.
4. A non-successful journey has one primary Failure Location. Retry/attempt failures remain ordered supporting events.
5. Artifact absence is explicit and reasoned; missing data is never silently presented as complete capture.
6. Redaction and truncation are permanent artifact facts and cannot be hidden by the UI.
7. Semantic Conversion Provider request payload, response metadata, and decoded response IR come only from the selected Pi Provider's public `onPayload`/`onResponse` lifecycle and the owning protocol executor; raw Provider response events are not a required artifact.
8. Native artifacts do not enter Pi AI IR, and Semantic Conversion artifacts do not reuse either native lane's transport or credential implementation.
9. Observation and persistence failure cannot become the primary Request Incident or replace or modify the model-serving response. Record the completeness degradation when possible; if the single authority is unavailable, expose operational health/attention without creating a secondary request store.
10. Semantic outcome commit, Client response preparation, HTTP handoff, and client consumption are distinct lifecycle facts.

## 14. Observation Runtime Contract

The diagnostics Module is a deep observation Module behind one small Interface. Data Plane callers publish bounded facts and do not know about its queue, child process, redaction, SQLite schema, file tree, retention, retries, projections, or operational-health implementation. Deleting this Module would redistribute those responsibilities to every request path; therefore they belong behind this seam rather than in handlers or lane implementations.

### 14.1 Data Plane observation Interface

The production Interface has one request lifecycle, one requestless-event entry point, and one artifact lifecycle attached to the request observer:

```ts
interface RequestJourneyObservationAuthority {
  begin(input: RequestJourneyBeginInput): RequestJourneyObserver;
  observeRuntime(input: RuntimeEventObservationInput): void;
}

interface RequestJourneyObserver {
  readonly requestId: string;
  observe(input: RequestJourneyObservationInput): void;
  openArtifact(input: ArtifactOpenInput): ArtifactRecorder;
  close(input: RequestJourneyCloseInput): void;
}

interface ArtifactRecorder {
  captureJson(value: unknown): void;
  append(bytes: Uint8Array): void;
  finish(input: ArtifactFinishInput): void;
  abandon(reason: string): void;
}
```

`begin`, `observe`, `openArtifact`, `captureJson`, `append`, `finish`, `abandon`, `close`, and `observeRuntime` are synchronous, no-throw operations and never return a `Promise`. `openArtifact` returns only a recorder/no-op recorder, never a serving decision. None of these methods return routing, lane, retry, Profile, cancellation, response, or any other execution decision. They perform only bounded validation/copying, sequencing, and in-memory admission; redaction and persistence run in the independent child process. No caller waits for child-process IPC, directory or file I/O, SQLite, subscription delivery, or persistence acknowledgement. If policy lookup, allocation, validation, redaction, queue admission, child-process, filesystem, or internal observation fails, the Adapter contains that failure, updates operational health when possible, and otherwise behaves as a no-op.

`RequestJourneyBeginInput` contains the request-edge `requestId`, operation candidate, transport kind, method/path facts, accepted time, and initial cancellation context. It contains no runtime-generated diagnostics ID. The Node HTTP edge creates the request ID at P0 before routing and passes the same Observer through the Runtime. A direct in-process `TokenRuntime.handle()` call creates its request ID at its own P0 seam and records `transport=in_process`. No handler, lane, capture Adapter, or persistence implementation may mint a second request correlation ID.

The diagnostics Module injects `runtimeId`, monotonic per-Journey `sequence`, and observation time. Callers cannot supply or override them. Each Backend start has one new `runtimeId`. At `begin`, the Module obtains and freezes both Settings-owned policies through one narrow synchronous capability: `diagnostics.fullJourneyCapture.enabled` (default `false`) and `diagnostics.failedJourneyCapture.enabled` (default `true`). Policy failure is caught and uses those catalog defaults. The Data Plane never receives the policy and cannot branch on it.

### 14.2 Closed observation vocabulary

`RequestJourneyObservationInput` is a closed discriminated union, not an open `event: string` plus `unknown` payload:

```ts
type RequestJourneyObservationInput =
  | StepEnteredObservation
  | StepCompletedObservation
  | LaneCommittedObservation
  | AttemptObservedObservation
  | ConversionNoticeObservedObservation
  | ArtifactObservedObservation
  | FailureDetectedObservation
  | WorkOutcomeCommittedObservation
  | ClientResponsePreparedObservation
  | HandoffObservedObservation;
```

| Kind | Required owned facts | Prohibited interpretation |
|---|---|---|
| `step_entered` | request-local `stepInstanceId` and `RequestJourneyLocation` | does not assert completion or failure |
| `step_completed` | matching `stepInstanceId`, completion class, safe summary | does not change the work outcome |
| `lane_committed` | exactly one selected lane and selection facts | cannot request fallback or select another lane |
| `attempt_observed` | attempt number, safe Profile attribution, transition/response facts | cannot decide retry or Profile advancement |
| `conversion_notice_observed` | direction, step, subject, notice code and severity | cannot repair or reinterpret semantics |
| `artifact_observed` | declared artifact kind, media type, bounded bytes/chunk, byte counts and capture status | cannot read a stream or fetch missing evidence |
| `failure_detected` | origin precision, detection location, safe failure classification and exception fingerprint | cannot replace the request error or terminal outcome |
| `work_outcome_committed` | semantic/native work outcome and terminal authority | distinct from Client rendering and HTTP handoff |
| `client_response_prepared` | status, safe headers/body artifact reference and presentation facts | does not assert that HTTP wrote or the client consumed it |
| `handoff_observed` | P8 write/finish/close facts | does not revise the committed model work outcome |

`RequestJourneyCloseInput` seals the Journey outcome, primary Incident when any, last-known active step, artifact completeness, and close reason. `close` is idempotent; the first valid close wins. Later observations are discarded and may raise diagnostics-health attention, but never affect the request.

Each `step_entered` is emitted immediately before the owned work begins. Each successful or truthfully terminated step emits its matching `step_completed`. A `step_entered` without completion is meaningful evidence of a hang, interruption, timeout, process termination, or unavailable observation. A request owner supplies a request-local opaque `stepInstanceId`; at most one unmatched instance with that ID may exist. The diagnostics reducer pairs the two events and never infers completion from entry into a later step.

Ordinary `observe` inputs contain typed immutable facts only. They must not contain `Request`, `Response`, streams, mutable Pi Context or messages, Provider SDK objects, Profile/AuthResult objects, functions, errors with unbounded object graphs, or a broad `Record<string, unknown>`. When bytes are observed, the Adapter copies the accepted prefix before returning and never retains the caller's buffer reference. `ArtifactRecorder.captureJson` is the one mechanism-only exception for a finalized request-local JSON-like value available only as an object at a public Pi ownership seam. It synchronously reads only bounded own data fields, never invokes getters, `toJSON`, or conversion hooks, never retains the input, and either emits a bounded byte snapshot or finishes that artifact as explicitly unavailable.

### 14.3 Request-local Flight Recorder

Artifacts are copied only where their owning module already has the bytes:

- the Client Protocol edge copies from the body bytes it already reads;
- a Native lane copies from the outbound envelope or response bytes it already constructs or consumes;
- the Semantic Conversion path asks the Flight Recorder for a strictly bounded own-data JSON snapshot of its finalized invocation and terminal message at their ownership seams;
- the Semantic Provider request payload is observed only from the value returned by the owning protocol's `onPayload`; response metadata comes only from Pi `onResponse`, and response IR only from the completed Pi `AssistantMessage`; the Flight Recorder does not retain any of those objects;
- P6/P8 copies from the already prepared or materialized Client response bytes.

Diagnostics must not clone or re-read a consumed body, add a second stream consumer, retain a live stream, wrap or replace `fetch`, inject a transport, or reconstruct evidence from a different representation. Capture failure changes only the artifact descriptor.

The request-local Flight Recorder retains only bounded, unacknowledged copied chunks in the Backend process. Object-only Semantic artifacts have a fixed 1 MiB synchronous snapshot budget and become `unavailable:synchronous_json_snapshot_limit_exceeded` when they exceed it; this prevents an unbounded stringify, getter, or `toJSON` call on the serving thread. A dedicated Diagnostics child process owns at most 64 MiB for one complete naturally streamed wire artifact and 512 MiB across active artifacts, performs complete-document fail-closed redaction after `finish`, and writes only sanitized bytes into an unsealed Journey directory. The outcome is not known until close because work that succeeds at P7 may still fail HTTP handoff at P8. On close:

- a Journey whose P0 all-request snapshot was enabled seals every complete, redacted, in-budget stage artifact for every outcome;
- otherwise a Journey whose P0 failed-request snapshot was enabled seals bodies only when the outcome is failed, aborted, or interrupted;
- policy-rejected successful bodies record `unavailable:full_journey_capture_disabled`; policy-rejected abnormal bodies record `unavailable:failed_journey_capture_disabled`;
- a mid-Journey Settings change does not alter this decision;
- summaries, timeline, outcome, Incident, and completeness never depend on retaining artifact bodies.

### 14.4 Fixed capacity and degradation rules

The full-capture revision uses the following independent defaults. Configuration may lower storage/retention budgets but cannot raise the single JSON-family artifact maximum beyond 64 MiB without a later contract revision.

| Bound | Default |
|---|---:|
| lifecycle observations per Journey | 512 |
| serialized non-artifact observation | 64 KiB |
| one artifact chunk accepted by `ArtifactRecorder.append` | 64 KiB |
| one synchronous JSON-like object snapshot | 1 MiB (1,048,576 bytes) |
| one JSON/JSONL/SSE artifact | 64 MiB (67,108,864 bytes) |
| artifact bytes accepted per Journey | 512 MiB |
| aggregate main-process unacknowledged artifact bytes | 16 MiB |
| ordinary pending/unacknowledged child-process queue | 16 MiB |
| failure/terminal/seal metadata reserve | 4 MiB |
| retained artifact files | explicit configured byte, age, and Journey-count ceilings |

The 4 MiB reserve accepts only compact `failure_detected`, work outcome, response/handoff terminal facts, completeness changes, and the final close seal. Artifact bodies never consume the reserve. The seal repeats the primary/last-active location and final completeness, so queue loss cannot be mistaken for a complete timeline.

When capacity is exhausted, shedding order is deterministic:

1. full-scene artifact bodies from newly admitted chunks;
2. successful-Journey non-terminal step detail;
3. nonessential notices and repeated attempt detail;
4. failure artifact bodies, recorded as `unavailable:queue_capacity_exhausted`;
5. ordinary failure timeline events, with the reserved close seal retaining the primary location and explicit completeness degradation.

No capacity condition blocks, throws into, cancels, delays for persistence, or modifies the observed work. If even the reserved seal cannot be admitted, the request still proceeds unchanged and diagnostics exposes only process-level degraded health when possible. The system does not open a secondary request log or persistence fallback.

The 64 MiB artifact limit applies when the owning path already receives or constructs bytes in naturally yielding chunks. Diagnostics never inserts an `await` or yield to wait for acknowledgements. A one-shot artifact larger than the remaining 16 MiB admission window is therefore recorded as `unavailable:queue_capacity_exhausted`; it is not falsely reported as a complete 64 MiB capture.

### 14.5 Diagnostics child process, acknowledgement, replay, and shutdown

A dedicated Node child process is the only actor allowed to open or query the diagnostics SQLite database or create/read/move/delete files in the managed full-journey tree. A Worker Thread, `setImmediate`, Promise microtask, handler-owned writer, lane-owned file writer, or direct Control Plane database/filesystem connection is not an equivalent Adapter. The child receives no serving socket, credential authority, Provider object, cancellation handle, or Backend lifecycle authority.

The Backend assigns sequence before queue admission and retains each ordinary message until the child acknowledges acceptance/commit. An artifact-chunk acknowledgement means the isolated process owns that bounded in-memory copy; it is not a durability promise. A child crash may therefore make the active artifact unavailable, but cannot affect the request. SQLite observations are idempotent under `(runtimeId, requestId, sequence)` and Runtime Events under `(runtimeId, recordId, sequence)`. IPC is never awaited. Node's `child.send(false)` means IPC backpressure while the message remains accepted; throw, callback error, or disconnect degrades diagnostics and never reaches serving code. The Diagnostics Authority's own 16 MiB admission queue remains the authoritative Backend bound.

Unexpected child-process `error`, malformed message, disconnect, or exit is contained by the diagnostics supervisor and triggers automatic restart with fixed bounded backoff:

```text
100 ms -> 500 ms -> 2 s -> 10 s -> 30 s -> 30 s ...
```

The backoff resets only after the child reports ready and successfully commits at least one batch. Pending unacknowledged messages are replayed in sequence after restart, subject to the same memory bounds and truthful completeness degradation.

Child-process restart within the same `runtimeId` must not mark active requests interrupted. At Backend startup, the new runtime marks only unclosed Journeys belonging to an older `runtimeId` as `interrupted`; it does not fabricate completion events. A previous runtime's last entered step remains the failure/interruption location.

Normal Backend shutdown drains Data Plane work first, then gives diagnostics at most 2 seconds to acknowledge queued records. The timeout terminates a hung child and allows shutdown; it cannot revise already completed requests. No individual request awaits this flush. A diagnostics-process exception, fatal exit, or diagnostics-process memory exhaustion cannot terminate the Backend. Backend forced termination, OS failure, or power loss may leave an explicitly incomplete Journey; guaranteeing persistence under those failures would require request-path durability and is intentionally not promised.

### 14.6 One diagnostics persistence authority

The full-capture revision uses one Diagnostics Authority and one child process owning an index plus a managed artifact tree:

```text
state/request-diagnostics/diagnostics-v3.sqlite3
state/request-diagnostics/full-journeys/
logical schema: TOKEN_diagnostics v3
```

Former diagnostics database and capture files are not read, migrated, rewritten, or deleted. Version selection is expressed by the file name and schema together; there is no dual reader or compatibility projection.

The current configuration contract is intentionally new and has no legacy aliases:

```json
{
  "schemaVersion": "token-config-v2",
  "diagnostics": {
    "directory": "state/request-diagnostics",
    "maxJsonArtifactBytes": 67108864,
    "maxJourneyArtifactBytes": 536870912,
    "maxArtifactDiskBytes": 5368709120,
    "artifactRetentionAgeMs": 604800000,
    "maxArtifactJourneys": 1000
  }
}
```

The directory is resolved under Token's application-state authority, never the current working directory or a user-owned Codex state directory.

The user-facing body-retention policies are registered Settings values, not root-configuration switches:

```text
diagnostics.fullJourneyCapture.enabled = false
diagnostics.failedJourneyCapture.enabled = true
```

They are hot-applied and persisted by the Settings Authority. The resolved artifact folder is `<diagnostics.directory>/full-journeys`, is exposed read-only by the Control Plane, and is displayed beside the switches in Settings.

Its logical tables are:

| Table | Responsibility |
|---|---|
| `records` | common ID, record kind, runtime ID, created/closed time, completeness |
| `request_journeys` | operation, protocol, lane, outcomes, primary Incident and summary |
| `request_journey_events` | ordered typed observations keyed by Journey and sequence |
| `request_journey_artifacts` | descriptor, retention state, safe relative file reference, counts and hash |
| `artifact_evictions` | immutable reason/time audit for removed artifact bodies |
| `runtime_events` | requestless startup, store-health, catalog and application diagnostics |
| `meta` | logical schema version and persistence metadata |

Events and artifacts are child sections of a Journey, not independent persistence authorities. SQLite WAL/SHM and the managed file tree are implementation storage owned by the same child process, not additional authorities. Sanitized bodies are written below `full-journeys/.inflight/<runtimeId>/<requestId>` using hashed opaque path segments. The child commits the closed index row/provisional references, then atomically writes the manifest and renames the directory into `full-journeys/YYYY-MM-DD/<requestId>` outside the SQLite transaction. On restart, a closed row still pointing into `.inflight` is finalized idempotently before unreferenced `.inflight` orphans are removed. Request/artifact IDs are never unchecked path fragments and every path is verified below the managed root. Queries use the SQLite relationship and never scan caller-selected paths. Deletion removes index references transactionally and then garbage-collects unreferenced directories. History count, deletion, and retention exclude active Journeys whose close seal has not committed, so a concurrent management operation cannot turn later observations into orphan facts.

Request Journey structure and Runtime Events remain until explicit user deletion. Artifact bodies expire when any configured byte, age, or Journey-count ceiling requires eviction. Eviction preserves the descriptor, safe counts/hash, redaction/truncation facts, and changes its state to `unavailable:expired`; it never makes a previously partial artifact appear complete.

### 14.7 Artifact policy and redaction

All-request full-scene bodies are disabled by default; failed/aborted/interrupted full-scene bodies are enabled by default. The Diagnostics Module snapshots both Settings values once at P0, and neither can change during the Journey. The Data Plane does not read either setting. Journey timeline, Incident, safe failure facts, outcome, and artifact descriptors remain always-on even when body retention is disabled.

Credential-bearing HTTP header values, URL userinfo, Control Plane capabilities, Profile/AuthResult objects, local credential state, and unrelated environment values are excluded by their owning module before observation. Safe Profile ID/display name/auth type and selection reason may enter as attribution facts. A body can contain arbitrary secret-named fields, so its bounded raw chunks cross only the private Backend-to-diagnostics-process IPC seam transiently; they never enter SQLite, files, exports, subscriptions, or renderer results.

The independent diagnostics process applies centralized bounded complete-document redaction after `finish` proves byte completeness and before any body reaches the filesystem. JSON/`+json` parses and redacts secret-named fields and credential patterns. JSONL/NDJSON frames and redacts every record. SSE frames complete events, redacts JSON `data:` payloads, preserves `[DONE]`, and fails closed for unclassified data. If syntax, known-sensitive scrubbing, or artifact serialization fails, it drops the body and persists `unavailable:redaction_failed` or the more precise typed reason. Binary bodies persist only media type, original/captured length when known, a policy-approved integrity hash, and an explicit body-unavailable reason. Redaction and truncation facts are permanent and survive projection and retention eviction.

### 14.8 Control Plane and compatibility contract

The Application Control Plane is the only management seam into the running diagnostics authority. Its current wire contract is version 4 and provides typed operations equivalent to:

- `queryRequestJourneys(query)`;
- `getRequestJourney({ requestId })`;
- `getRequestArtifact({ requestId, artifactId, offset, limit })`;
- `getDiagnosticsStorageStatus()`, returning only the resolved full-journey directory and fixed artifact limit;
- `subscribeRequestJourneys(listener)`;
- `queryRuntimeEvents(query)` and `subscribeRuntimeEvents(listener)`;
- `getAnalytics(query)`, preserving current product analytics semantics while sourcing them from Journeys.

Each `queryRequestJourneys` result and closed-Journey subscription may include
one bounded row-level usage projection. The authoritative Semantic Conversion
source is the terminal Pi `AssistantMessage.usage`; native preservation lanes
may publish the same product fact from their lane-owned response boundary. The
product fact contains exactly non-negative safe-integer `input`, `output`, and
`cacheRead` values plus `done`, `failed`, `aborted`, or `unsupported` terminal
class. All three numbers are present together and zero is a real value. A
runtime observation that violates this contract is dropped without changing
the model response.

The row projection exposes those three values and, when calculable, cache-hit
rate and Provider-execution token speed. A request without a terminal usage
fact has no usage projection. No completeness declaration, Provider semantics,
raw Provider usage field, cost, cache-write, reasoning-token, or normalized
total value crosses this management seam.

Analytics contract v3 counts every request in `totalRequests`. Every request
with a usage fact, including failed and aborted requests, contributes to
`usageRequests` and to the three token sums; the remainder is
`missingUsageRequests`. `speedRequests` counts usage-bearing requests with a
positive execution duration. Derived values are:

```text
cache hit   = sum(cacheRead) / sum(input + cacheRead), when denominator > 0
token speed = sum(output) / sum(execution duration seconds), for speedRequests
```

An undefined derived value is omitted from the wire contract and rendered as
`—`. Coverage is shown only when the relevant request count is below the total.

Artifact reads return at most 256 KiB of base64 per call. Subscriber, query, file-read, and renderer failure is contained in its owning observation/management module and cannot affect the diagnostics child process or Data Plane. When the child/database/file is unavailable, reads return a typed `unavailable` result with diagnostics-health facts; they do not return a fabricated empty-complete result and do not open SQLite or scan the capture directory directly.

The production cutover replaces the v2 artifact BLOB/configuration shape atomically. It does not dual-write. The new config contract, Control Plane contract, and `TOKEN_diagnostics v3` schema do not read deprecated fields, command aliases, journals, databases, or capture directories. Legacy data is not migrated, imported, modified, or deleted. A new run creates only the new diagnostics database and managed folder; incompatible or corrupt new-schema storage raises operational attention while Data Plane serving remains fail-open.

### 14.9 Runtime certification requirements

Non-interference is proved by comparing each fault-injected run with the same request under diagnostics disabled. Tests use latches/barriers rather than elapsed-time thresholds to prove that the request completes without a diagnostics acknowledgement.

For a throwing Observer/recorder/policy source, saturated ordinary and reserved queues, failed child spawn/IPC, stalled/crashed/malformed/disconnected/out-of-memory diagnostics child process, slow/locked/unavailable SQLite, directory creation/file append/manifest rename/retention failure, redaction failure, oversized/cyclic/proxy artifact input, subscriber/query/renderer exception, and cancellation/Provider-terminal race, the following must be byte- or fact-identical to the disabled baseline:

- committed lane;
- outbound method, URL, headers, body, and encoding;
- attempt sequence and Profile transitions;
- cancellation arbitration and work-outcome commit;
- HTTP status, headers, body, and streaming event order;
- terminal/model work outcome.

Diagnostic quality certification must also prove:

1. one request ID spans P0 header/correlation, Journey, Incident, events, and artifacts;
2. a `step_entered` without completion identifies the last active step after hang or interruption;
3. origin, detection, and Client presentation remain separate facts;
4. Pi success followed by Client render failure or P8 handoff failure remains three distinct outcomes;
5. every artifact slot is `captured`, `partial`, `unavailable`, or `not_applicable` with a truthful reason;
6. no record claims Client consumption;
7. credential header/URL canaries are absent before Observer publication, and body credential canaries are absent from SQLite/WAL/SHM, artifact files, Control Plane results, exports, and subscriber projections after isolated redaction;
8. architecture checks forbid Data Plane imports of the child-process supervisor, store, filesystem, or SQLite, `await` on observations, handler-generated request IDs, and observation transports injected into Pi execution;
9. architecture checks preserve the three lane dependency prohibitions while allowing only the shared observation vocabulary.

## 15. Pre-refactor implementation baseline

The design audit confirmed the following differences in the implementation that preceded this refactor:

1. `/v1/messages` and `/v1/responses` create Invocation Diagnostics and Request Ledger entries separately; their IDs are independently minted.
2. Deep Capture uses the Ledger request ID, while Invocation Diagnostics uses its own request ID.
3. Request IDs are created after HTTP routing inside the generation handlers, so unmatched routes and early HTTP rejection have no common identity.
4. `/v1/responses/compact` and `/v1/models` do not participate in the generation handlers' Ledger/Diagnostics/Capture lifecycle.
5. Ledger phases are only `accepted`, `execution`, `rendering`, and `terminal-preparation`.
6. Semantic checkpoints are currently coarse (`client-validation`, `model-resolution`, `pi-composition`, `client-render`, and `native-passthrough`).
7. Deep Capture records Client Request Wire and the prepared Client response, but not a complete lane-specific series of outbound, upstream, Pi invocation, Pi terminal, and handoff artifacts.
8. Deep Capture is globally optional, so a failure does not guarantee preserved request/response evidence.
9. Runtime Diagnostics, Invocation Diagnostics, Ledger, and Capture are separate persistence/query surfaces rather than sections of one Request Journey Record.
10. The Node HTTP server buffers the prepared `Response` before writing it, so it has a truthful response-handoff artifact seam but still cannot claim client consumption.

These findings defined the replacement surface. The completed cutover removed the old writers rather than preserving them behind the new observation Interface.

## 16. Required journey-quality scenarios

The eventual unified record must be certified against at least these scenarios:

| Scenario | Expected primary location |
|---|---|
| unsupported media type or encoding | P1 `validate_media_and_encoding` |
| oversized or invalid JSON body | P1 `read_and_decode_body` |
| unknown/unavailable model | P2 `resolve_public_model` |
| Direct Mode upstream rejects caller credential | P4/P5 Local upstream response preservation |
| Direct Mode transport/body-read failure | P4 Local dispatch/read step |
| Provider Native auth failure | P3 Provider Native `resolve_provider_auth` |
| Anthropic OAuth body projection failure | P3 Provider Native `project_native_body` |
| Provider Native final 429/Profile switch | P4 retry/profile steps with ordered attempts |
| Provider Native alias projection failure | P5 `project_native_alias` |
| Client→Pi orphan/duplicate tool result | P3 Semantic `correlate_tool_lifecycle` plus source path |
| Client→Pi untrusted resource handle | P3 Semantic `resolve_trusted_client_resource` |
| Pi→Provider request conversion failure | P4 Semantic `convert_pi_request` |
| Provider transport timeout | P4 Semantic `dispatch_provider_transport` |
| Provider stream ends without semantic terminal | P4 Semantic `construct_pi_terminal` or `validate_pi_terminal` |
| Provider→Pi malformed tool call | P4 Semantic `decode_provider_events` with subject `tool_call` |
| Pi→Client unrepresentable namespace/content | P5 Semantic response projection step |
| Pi→Client stop reason/usage mismatch | P5 Semantic stop-reason/usage step |
| JSON/SSE fidelity failure | P6 encoder/fidelity step |
| cancellation before lane commitment | P0-P2 exact observed step, no lane |
| cancellation during upstream execution | P4 selected lane, exact transport/execution step |
| response connection closes after success commit | P8 handoff failure; semantic outcome remains success |
| Journey observation/persistence fails | request outcome unchanged; completeness degradation when the record can commit, otherwise operational store-health/attention only |
| compact request failure | common phase plus compaction-specific step |
| model discovery projection failure | P6 `project_model_list` |
| unmatched route or WebSocket request | P1 routing/transport rejection, no lane |

## 17. Cutover certification gate

The production cutover remains valid only while review confirms:

1. every current Data Plane route maps into this Journey;
2. every failure-producing seam maps to one primary Phase and Lane Step;
3. Semantic Conversion covers all four directions without leaking protocol-specific types into common observation contracts;
4. every required Request Artifact has an owning module and a truthful unavailable state;
5. no step creates a shared native executor, credential authority, transport, or semantic model.
6. request-owned evidence and requestless Runtime Events follow the explicit ownership rule under one persistence authority;
7. every Data Plane observation call is synchronous no-throw/no-Promise and imports only the observation Interface;
8. diagnostics fault-injection equivalence and diagnostic-quality certification in sections 14.9 and 16 pass against the real HTTP and Control Plane seams;
9. no legacy writer, reader, compatibility alias, dual-write path, or secondary request store remains in production composition.

Cutover is complete only when the process matrix, runtime contract, implementation, Control Plane projection, and certification tests express the same Journey facts and non-interference guarantees.
