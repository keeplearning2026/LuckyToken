# Token Request Journey Diagnostics Specification

- **Status:** IMPLEMENTED — v5 unredacted artifact bodies and current-only Control Plane v8
- **Date:** 2026-09-30
- **Scope:** Data Plane request journey, failure location, investigation artifacts, fail-open observation runtime, and one diagnostics persistence authority
- **Out of scope:** physical SQL/index tuning and legacy data migration/import (not provided)

This document establishes the current request-processing map and observation contract for Token's unified Request Journey diagnostics system. The v5 body policy, storage selection, descriptor changes, and certification gates below are normative current-contract requirements. Implementation evidence and the scope of live verification are recorded in [Diagnostics v5 verification](../Research/TokenDiagnosticsV5Verification.md).

The revision removes artifact-body redaction, retains safe non-body diagnostic facts and HTTP envelopes, and preserves the existing capture settings and observation boundaries. Production must implement one v5 contract only. No old-version reader, writer, migration, field alias, compatibility projection, fallback, or dormant body-redaction path may remain. Existing older files are outside the v5 authority and are not automatically deleted.

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

While the Diagnostics Authority is healthy, every normally closed `failed`, `aborted`, or `interrupted` Journey has one directly displayable `RequestJourneyDiagnosis`. An observed diagnosis contains the first primary failure's stable classification, bounded safe message, origin and precision, and detection location. If no valid primary failure reached the Authority, it records `request_failed_without_specific_cause` with `evidence=fallback`, `origin=unknown`, `originPrecision=boundary`, the last confirmed request boundary, and `completeness=degraded`. The fallback is a coverage alarm, not an inferred root cause.

This health-period guarantee is observation-only. When the Authority cannot admit a request, its process is unavailable, or the Backend/OS loses power before an asynchronous commit, per-request diagnostic coverage may be absent. That gap is exposed as diagnostics health/attention and never changes request routing, timing, wire bytes, status, cancellation, or terminal outcome.

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
| `token_counting` | unsupported optional `POST /v1/messages/count_tokens` probe | No execution lane; preserves the current 404 while remaining queryable outside the Overview projection |
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
| P2 | `request_resolution` | a model-serving request has a selector candidate | Direct Mode recognition result, Public Model result, Provider Native eligibility, committed lane | selector, capability decision, provider/model snapshot when resolved |
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
| 10 | P2 | `recognize_direct` | operations supporting Direct Mode | explicit Direct Mode capability result | Direct Mode recognition authority unavailable |
| 11 | P2 | `resolve_public_model` | requests not claimed locally | alias/provider/real-model snapshot | unknown or unavailable alias/model |
| 12 | P2 | `recognize_provider_native` | resolved compatible operations | explicit provider/API/operation capability result | invalid or absent capability contract |
| 13 | P2 | `commit_lane` | model-bound operations | exactly one lane or explicit failure | no valid execution contract |

Direct Mode recognition occurs before Public Model resolution where the protocol exposes that lane. Provider Native recognition occurs only after a Pi model has been resolved. Once `commit_lane` succeeds, failure cannot fall through to another lane.

Request Identity is correlation/session information. It is not Client authorization. Direct Mode preserves caller credentials as unobserved Client Wire; Provider Native resolves its independent Provider credential only after that lane owns the request.

## 4. Direct Mode steps

| Order | Phase | Lane Step | Input | Output/artifact | Failure source examples |
|---:|---|---|---|---|---|
| 1 | P3 | `recognize_direct_model` | opaque selector | Direct Mode model/capability fact | model registry/capability authority |
| 2 | P3 | `preserve_caller_envelope` | authoritative Client Wire | bounded transport-ready caller envelope; credentials remain unobserved | request read/cancellation failure |
| 3 | P3 | `project_direct_request` | authoritative Client Wire | boundary-required model/header projection | invalid boundary projection |
| 4 | P3 | `construct_direct_envelope` | preserved request | fixed endpoint, method, headers, encoding | endpoint/header construction failure |
| 5 | P4 | `dispatch_direct_transport` | Direct Mode upstream envelope | upstream response handle | DNS/connect/TLS/write/timeout/cancellation |
| 6 | P4 | `read_direct_response` | upstream response handle | bounded upstream response artifact | body read, stream, unexpected EOF |
| 7 | P5 | `preserve_direct_response` | compatible upstream wire | Client Wire response candidate | incompatible or malformed preserved response |
| 8 | P5 | `observe_direct_usage` | preserved response | optional normalized usage | malformed optional usage; never change response outcome |

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
| 3 | P3 | `project_native_body` | authoritative Client Wire body | model-only projection, the bounded Responses tool-call adjacency deferral (`provider_native_tool_call_adjacency_deferred` / `provider_native_tool_call_group_abandoned` / `provider_native_tool_call_group_unsupported_item`), or explicit Anthropic OAuth projection | malformed JSON, unsafe OAuth projection, failed adjacency qualification (fail-open to model-only) |
| 4 | P3 | `reconstruct_provider_envelope` | model, auth, operation, projected body | method, endpoint, headers, encoding/compression | missing endpoint/session/header facts |
| 5 | P4 | `dispatch_provider_native` | reconstructed envelope | upstream response handle | connect/write/timeout/cancellation |
| 6 | P4 | `classify_native_retry` | response/error and Provider contract | retry decision and delay | invalid retry delay, retry policy failure |
| 7 | P4 | `advance_provider_profile` | validated final HTTP 429 and binding | next request-bound Profile or terminal decision | no eligible Profile, transition failure |
| 8 | P4 | `read_provider_native_response` | upstream response handle | bounded response bytes/stream artifact | body read, stream parse, unexpected EOF |
| 9 | P5 | `observe_provider_native_usage` | buffered upstream response | optional normalized usage | malformed optional usage; never change response outcome |
| 10 | P5 | `repair_function_call_namespace` | buffered Provider Native response and the caller's declared tools | inserted `namespace` on a `function_call` the caller declared uniquely, plus the bounded `provider_native_function_call_namespace_repaired` notice | malformed body, certified event with a malformed carrier, duplicate keys, non-UTF-8 bytes, a refused request-side authority (repeated key inside `tools`), ambiguous or undeclared child (all fail-open to the stage input bytes) |
| 11 | P5 | `project_native_alias` | response wire and client alias | alias-safe response wire | missing/ambiguous model position |
| 12 | P5 | `preserve_provider_response` | compatible provider wire | Client Wire response candidate | protocol incompatibility |

This lane never enters Pi AI IR or Pi Provider semantic execution. Its credential, request construction, retry, transport, and response processing remain independent from Direct Mode and Semantic Conversion.

The `Order` column lists the steps that own a documented contract outcome, in
execution order. Steps that only move bytes between those boundaries — response
buffering, SSE lifecycle normalization — are described in their own plans rather
than repeated here, so an absent row is not an absent step. Usage observation runs
immediately after buffering, before lifecycle normalization.

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
| SREQ-11 | P3 | `finalize_pi_invocation` | Pi Context, tools, SimpleStreamOptions, Client-private state | frozen invocation snapshot and request-local notices |

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
| `metadata` | user/safety identity when a protocol has an accepted consumer; otherwise an unread unconsumed-field notice |

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

The Client Protocol adapter must not inject a custom transport to observe SEXEC-04 through SEXEC-09. Under clean upstream Pi 0.87.0, neutral Core execution observation may record an immutable copy of the complete Provider-native payload exposed through Pi `onPayload`, safe response status/headers from `onResponse`, and the complete decoded Pi `AssistantMessage`. The observation callback returns the original payload unchanged, contains its own failures, and is semantically removable. Client Protocol modules neither create that callback nor inspect or modify the Provider payload. Adapter/SDK-internal HTTP wire and raw Provider response events are not required artifacts. A required public callback or Pi terminal that was not reached is recorded explicitly as unavailable; it is never replaced by a summary labelled complete.

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

`POST /v1/responses/compact` participates in the common Request Journey lifecycle. It does not reopen the former Request Ledger, Invocation Diagnostics, or Deep Capture authorities.

### 9.2 Model discovery

Model discovery uses P0, P1, P6, P7, and P8. Its operation steps are `read_publication_snapshot`, `project_model_list`, and `encode_model_list`. It does not select a Data Plane Lane.

`GET /v1/models` enters HTTP admission with a request ID and a `model_discovery` Journey; its projection failure remains queryable under that same ID.

### 9.3 Routing and transport rejection

Unmatched routes, drain rejection, and unsupported WebSocket upgrades terminate before lane selection. Supported Codex Realtime upgrades instead commit the Direct Mode lane and remain in one Journey through session close. All admitted upgrades use `transport=websocket`; a rejected upgrade may still write an HTTP 426 or pre-101 error envelope at P8. A malformed connection that never becomes an HTTP request is a runtime transport incident rather than a Request Journey.

## 10. Request Artifact matrix

Every artifact slot has a state: `captured`, `unavailable`, or `not_applicable`. Descriptors declare media type, original byte count when known, captured byte count, truncation, a bounded reason when unavailable, and an integrity hash when safely available. A captured body is complete at its declared observation boundary. Incomplete capture has no persisted prefix body and is `unavailable`, not a `partial` artifact. The descriptor and persisted artifact observation have no `redaction` field.

| Artifact | Owner | Direct Mode | Provider Native | Semantic Conversion | Required on failure |
|---|---|---:|---:|---:|---:|
| Client Request Wire | Client Protocol edge | yes | yes | yes | yes when complete, supported, and within capture/retention policy |
| Parsed Client Request summary | Client Protocol adapter | yes | yes | yes | yes when parsing succeeded |
| Lane decision | request resolution | yes | yes | yes | yes |
| Direct Mode outbound request wire | Direct Mode | yes | n/a | n/a | yes when constructed |
| Provider Native outbound request wire | Provider Native | n/a | yes | n/a | yes when constructed |
| Complete protocol-owned invocation/Pi IR | Client Protocol adapter | n/a | n/a | yes | yes when finalized |
| Pi Provider request payload at the public `onPayload` seam | Neutral Core execution observation | n/a | n/a | yes | yes when assembled |
| Upstream response wire | owning preservation-lane transport | yes | yes | n/a | yes when observed |
| Pi response metadata and decoded response IR | Neutral Core execution observation | n/a | n/a | yes | yes when observed/decoded |
| Complete Pi terminal IR | Neutral Core execution | n/a | n/a | yes | yes when any event was observed |
| Client Response Wire | Client Protocol edge / HTTP transport | yes | yes | yes | yes when constructed |
| Timeline and attempts | Journey observation | yes | yes | yes | yes |
| Failure and exception chain | failing owner + non-body fact scrubbing | yes | yes | yes | yes |
| Safe request context | Journey observation | yes | yes | yes | yes |

Diagnostics must not independently inspect credential authorities, Profile/AuthResult objects, Control Plane capabilities, or unrelated environment values to build artifacts. Safe Profile identifiers, display names, auth types, and selection reasons remain attribution facts. Existing body observation boundaries may already contain credentials, cookies, tool output, or user code: those bytes and allowed snapshot fields are retained without body scrubbing. Credential-bearing header values and sensitive URL fields remain excluded by the safe-envelope serializer. Raw body content never becomes an ordinary event, failure fact, or SQLite payload.

### 10.1 Evidence representation and protocol/lane coverage

The byte-equality promise applies to complete retained bytes submitted at an existing observation boundary, not to a TCP/TLS trace or an entire replayable HTTP exchange. Safe envelopes omit sensitive fields, Provider Native may have already projected or repaired its wire, and a selected Pi adapter owns HTTP serialization. Replaying a body can require separately supplied credentials, endpoint, model, and protocol context.

| Representation | Existing artifact IDs | Evidence promise |
|---|---|---|
| Client wire bytes | `client_request_wire`, `client_response_wire` | Persisted bytes equal the boundary input bytes |
| Direct wire bytes | `direct_outbound_request_wire`, `direct_upstream_response_wire` | Persisted bytes equal the corresponding Direct transport boundary bytes |
| Provider Native wire bytes | `provider_native_outbound_request_wire.N`, `provider_native_upstream_response_wire.N`, `provider_native_preserved_response_wire`; existing `provider_native_lifecycle_normalized_wire` where emitted | Persisted bytes equal that attempt/stage boundary input, after any lane-owned work already performed |
| Pi object snapshot | `pi_invocation_snapshot`, `pi_provider_request_payload`, `pi_provider_response_ir`, existing `pi_terminal_summary` where emitted | Persisted bytes equal the bounded own-data snapshot produced at that ownership boundary; not SDK HTTP wire bytes |
| Safe HTTP envelope snapshot | `client_request_envelope`, `client_response_envelope`, `direct_outbound_request_envelope`, `direct_upstream_response_envelope`, `provider_native_outbound_request_envelope.N`, `provider_native_upstream_response_envelope.N`, `pi_provider_response_metadata` | Persisted bytes equal the existing safe-envelope serialization; not raw HTTP headers or URL |

`N` identifies the owning path's existing attempt number. No wildcard such as `direct_*` may classify both an envelope snapshot and wire bytes as network-original evidence. Optional existing stages do not become new mandatory observation points.

| Client Protocol / lane | Client wire and safe envelopes | Pi snapshots | Provider request evidence | Provider response evidence |
|---|---|---|---|---|
| Responses / Direct | Existing request and response boundaries | Not applicable | Direct outbound wire and safe envelope | Direct upstream wire and safe envelope |
| Responses / Provider Native | Existing request and response boundaries | Not applicable | Per-attempt native wire and safe envelope | Observed per-attempt upstream wire, safe envelope, and existing preserved/normalized stages |
| Responses / Semantic | Existing request and response boundaries | Existing invocation and decoded response snapshots | Pi payload object snapshot | Safe metadata and decoded Pi IR; no upstream wire |
| Anthropic / Provider Native | Existing request and response boundaries | Not applicable | Per-attempt native wire and safe envelope | Observed per-attempt upstream wire, safe envelope, and preserved response |
| Anthropic / Semantic | Existing request and response boundaries | Existing invocation and decoded response snapshots | Pi payload object snapshot | Safe metadata and decoded Pi IR; no upstream wire |

This revision changes retention representation at existing seams only. It adds no capture points for these five combinations or other operations. In particular, neither Semantic Client Protocol collects raw upstream response events. A retry response not read by its owning lane remains unavailable; diagnostics cannot read it to fill the table.

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
4. A normally closed non-successful journey has one primary diagnosis. The first valid primary failure wins; retry/attempt failures remain ordered supporting events. If no primary was observed, the Authority and Worker seal the bounded degraded fallback rather than claiming a complete record without an Incident.
5. Artifact absence is explicit and reasoned; missing data is never silently presented as complete capture.
6. Artifact byte counts, truncation, boundary ownership, and unavailable reasons remain truthful through projection and eviction. Body redaction is absent; non-body safe-fact scrubbing remains mandatory.
7. Semantic Conversion Provider request payload and response metadata come only from the selected Pi Provider's public `onPayload`/`onResponse` lifecycle as observed by Neutral Core execution; decoded response IR comes from the same Core execution boundary. Raw Provider response events are not a required artifact.
8. Preservation-lane artifacts do not enter Pi AI IR, and Semantic Conversion artifacts do not reuse either Direct Mode or Provider Native transport or credential implementation.
9. Observation and persistence failure cannot become the primary Request Incident or replace or modify the model-serving response. Record the completeness degradation when possible; if the single authority is unavailable, expose operational health/attention without creating a secondary request store.
10. Semantic outcome commit, Client response preparation, HTTP handoff, and client consumption are distinct lifecycle facts.

## 14. Observation Runtime Contract

The diagnostics Module is a deep observation Module behind one small Interface. Data Plane callers publish bounded facts and do not know about its queue, child process, SQLite schema, file tree, retention, retries, projections, or operational-health implementation. Deleting this Module would redistribute those responsibilities to every request path; therefore they belong behind this seam rather than in handlers or lane implementations.

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

`begin`, `observe`, `openArtifact`, `captureJson`, `append`, `finish`, `abandon`, `close`, and `observeRuntime` are synchronous, no-throw operations and never return a `Promise`. `openArtifact` returns only a recorder/no-op recorder, never a serving decision. None of these methods return routing, lane, retry, Profile, cancellation, response, or any other execution decision. They perform only bounded validation/copying, sequencing, and in-memory admission; body completeness checks and persistence run in the independent child process. No caller waits for child-process IPC, directory or file I/O, SQLite, subscription delivery, or persistence acknowledgement. If policy lookup, allocation, validation, safe-fact scrubbing, queue admission, child-process, filesystem, or internal observation fails, the Adapter contains that failure, updates operational health when possible, and otherwise behaves as a no-op.

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
| `conversion_notice_observed` | direction, step, subject, stable notice code and severity; optional bounded user-readable message | message is observation-only and cannot repair, reinterpret, select, retry, or otherwise influence semantics |
| `artifact_observed` | declared artifact kind, media type, bounded bytes/chunk, byte counts and capture status | cannot read a stream or fetch missing evidence |
| `failure_detected` | stable classification, bounded redacted `safeMessage`, origin and precision, detection location, and optional exception fingerprint | cannot expose raw exceptions, credentials, request bodies, or unredacted Provider text; cannot replace the request error or terminal outcome |
| `work_outcome_committed` | semantic/native work outcome and terminal authority | distinct from Client rendering and HTTP handoff |
| `client_response_prepared` | status, safe headers/body artifact reference and presentation facts | does not assert that HTTP wrote or the client consumed it |
| `handoff_observed` | P8 write/finish/close facts | does not revise the committed model work outcome |

`RequestJourneyCloseInput` seals the Journey outcome, primary Incident, last-known active step, artifact completeness, and close reason. `close` is idempotent; the first valid close wins. For an abnormal outcome without a valid primary failure, the Authority synchronously enqueues the bounded fallback from dedicated close capacity before the seal. Later observations are discarded and may raise diagnostics-health attention, but never affect the request.

Each `step_entered` is emitted immediately before the owned work begins. Each successful or truthfully terminated step emits its matching `step_completed`. A `step_entered` without completion is meaningful evidence of a hang, interruption, timeout, process termination, or unavailable observation. A request owner supplies a request-local opaque `stepInstanceId`; at most one unmatched instance with that ID may exist. The diagnostics reducer pairs the two events and never infers completion from entry into a later step.

Ordinary `observe` inputs contain typed immutable facts only. They must not contain `Request`, `Response`, streams, mutable Pi Context or messages, Provider SDK objects, Profile/AuthResult objects, functions, errors with unbounded object graphs, or a broad `Record<string, unknown>`. When bytes are observed, the Adapter copies the accepted prefix before returning and never retains the caller's buffer reference. `ArtifactRecorder.captureJson` is the one mechanism-only exception for a finalized request-local JSON-like value available only as an object at a public Pi ownership seam. It synchronously reads only bounded own data fields, never invokes getters, `toJSON`, or conversion hooks, never retains the input, and either emits a bounded byte snapshot or finishes that artifact as explicitly unavailable.

### 14.3 Request-local Flight Recorder

Artifacts are copied only where their owning module already has the bytes:

- the Client Protocol edge copies from the body bytes it already reads;
- a Direct Mode or Provider Native lane copies from the outbound envelope or response bytes it already constructs or consumes;
- the Semantic Conversion path asks the Flight Recorder for a strictly bounded own-data JSON snapshot of its finalized invocation and terminal message at their ownership seams;
- the Semantic Provider request payload is observed only from the value supplied to the diagnostics-owned `onPayload` callback installed by Neutral Core execution; response metadata comes only from Pi `onResponse`, and response IR only from the completed Pi `AssistantMessage`; the Flight Recorder does not retain any of those objects;
- P6/P8 copies from the already prepared or materialized Client response bytes.

Diagnostics must not clone or re-read a consumed body, add a second stream consumer, retain a live stream, wrap or replace `fetch`, inject a transport, or reconstruct evidence from a different representation. Capture failure changes only the artifact descriptor.

The request-local Flight Recorder retains only bounded, unacknowledged copied chunks in the Backend process. Object-only Semantic artifacts have a fixed 1 MiB synchronous snapshot budget and become `unavailable:synchronous_json_snapshot_limit_exceeded` when they exceed it; this prevents an unbounded stringify, getter, or `toJSON` call on the serving thread. A dedicated Diagnostics child process owns at most 64 MiB for one complete naturally streamed wire artifact and 512 MiB across active artifacts. At `finish`, it verifies completeness and media eligibility and writes the submitted bytes unchanged into an unsealed Journey directory. The outcome is not known until close because work that succeeds at P7 may still fail HTTP handoff at P8. On close:

- a Journey whose P0 all-request snapshot was enabled seals every complete, supported, in-budget stage artifact for every outcome;
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

The 4 MiB reserve accepts only compact `failure_detected`, work outcome, response/handoff terminal facts, completeness changes, and terminal sealing. Each admitted Journey separately reserves a fixed 8 KiB close budget shared only by one fallback primary failure and the final close seal. Artifact bodies never consume either reserve. The seal repeats the primary/last-active location and final completeness, so queue loss cannot be mistaken for a complete timeline.

When capacity is exhausted, shedding order is deterministic:

1. full-scene artifact bodies from newly admitted chunks;
2. successful-Journey non-terminal step detail;
3. nonessential notices and repeated attempt detail;
4. failure artifact bodies, recorded as `unavailable:queue_capacity_exhausted`;
5. ordinary failure timeline events, with the dedicated fallback-and-close reservation retaining a minimal primary diagnosis, its location, and explicit completeness degradation.

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

The v5 revision uses one Diagnostics Authority and one child process owning an index plus a managed artifact tree:

```text
state/request-diagnostics/diagnostics-v5.sqlite3
state/request-diagnostics/full-journeys-v5/
logical schema: TOKEN_diagnostics v5
manifest schema: Token.full-journey.v5
```

Only this file name, managed tree, and schema version are accepted. Former diagnostics databases and capture files are not opened, queried, imported, migrated, rewritten, included in backups/exports, or garbage-collected. Version selection is expressed by the file name and schema together; there is no old-version reader, dual writer, compatibility projection, fallback discovery, or old-record UI. Existing older files are left outside the authority, without automatic deletion.

Application composition, backup source registration, storage-status projection, desktop settings, manifests, file references, retention, restart cleanup, and test fixtures must all use the v5 identity. The manifest declares `schema: "Token.full-journey.v5"` and the same current artifact descriptor contract. Replacing only the worker paths is insufficient. A v5 database with a mismatched schema fails diagnostics startup with operational attention; it must not select another database or affect Data Plane serving.

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

They are hot-applied and persisted by the Settings Authority. The resolved artifact folder is `<diagnostics.directory>/full-journeys-v5`, is exposed read-only by the Control Plane, and is displayed beside the switches in Settings.

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

Events and artifacts are child sections of a Journey, not independent persistence authorities. SQLite WAL/SHM and the managed file tree are implementation storage owned by the same child process, not additional authorities. Unredacted bodies are written below `full-journeys-v5/.inflight/<runtime-segment>/<request-segment>` using opaque hashed runtime/request segments for provisional files. Artifact file names use a bounded allowlisted artifact-ID slug plus a short collision-resistant hash and the declared media type's `.json`, `.jsonl`, or `.sse` extension. The extension does not certify valid syntax. The child commits the closed index row/provisional references, then atomically writes the manifest and renames the directory into `full-journeys-v5/YYYY-MM-DD/<requestId>` outside the SQLite transaction. The finalized directory name is the exact request ID, without a prefix, hash, encoding, or slug replacement, so an operator can find a retained Journey directly by request ID. The date is the UTC date of admission. Request IDs must match `[A-Za-z0-9][A-Za-z0-9_-]{0,254}` and must not be a Windows device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`, case-insensitive). An invalid directory ID makes bodies `unavailable:invalid_request_id_directory`; it never changes the serving request ID or creates a substituted folder. Every resolved path remains verified below the managed root. On restart, a closed row still pointing into the v5 `.inflight` tree is finalized idempotently before unreferenced v5 `.inflight` orphans are removed. Queries use the SQLite relationship and never scan caller-selected paths. Deletion removes index references transactionally and then garbage-collects unreferenced v5 directories. History count, deletion, and retention exclude active Journeys whose close seal has not committed, so a concurrent management operation cannot turn later observations into orphan facts.

Within the same transaction that closes an abnormal Journey, the Worker verifies that the chosen primary ID references a stored `failure_detected` event whose role is `primary` and whose safe diagnosis fields are valid. A missing, incorrect, supporting-only, or malformed reference is replaced transactionally by the same bounded fallback and the record is marked `degraded`; the Worker never commits an abnormal record as complete without an Incident.

Request Journey structure and Runtime Events remain until explicit user deletion. Artifact bodies expire when any configured byte, age, or Journey-count ceiling requires eviction. Eviction preserves original/captured counts, any existing integrity hash, and truncation facts, changes state/reason to `unavailable:expired`, clears the indexed body reference, records the eviction, and garbage-collects the body file. It does not rewrite body contents or zero the historical captured count. Acquisition failure and retention eviction are separate facts: an incomplete capture has no persisted body; an expired capture records that a complete body was previously saved.

Backups and exports transfer only the v5 SQLite snapshot and safe facts. They never package artifact files, including `.part` files, and never add body content to the index to make a backup self-contained.

Backup/restore contract registration must identify the v5 schema. Existing restore operations may accept matching new-version snapshots only; old-schema snapshots are rejected before replacing active storage, even when their generic snapshot ID matches. No restore operation translates old records or activates an old reader.

### 14.7 Unredacted body policy

All-request full-scene bodies are disabled by default; failed/aborted/interrupted full-scene bodies are enabled by default. The Diagnostics Module snapshots both Settings values once at P0, and neither can change during the Journey. The Data Plane does not read either setting. Journey timeline, Incident, safe failure facts, outcome, and artifact descriptors remain always-on even when body retention is disabled.

#### 14.7.1 Retention settings

The two existing setting keys and defaults remain unchanged. Their four combinations resolve to three retention states:

| All-request setting | Failed-request setting | UI state | Retain success | Retain failed/aborted/interrupted |
|---|---|---|---|---|
| `true` | `true` | All requests | Yes | Yes |
| `true` | `false` | All requests | Yes | Yes |
| `false` | `true` | Failures only (default) | No | Yes |
| `false` | `false` | Off | No | No |

Each Yes is subject to actual boundary availability, media eligibility, completeness, admission, write success, and retention limits. Neither setting promises evidence for a boundary never reached or durability after Backend/OS failure. Retention uses the sealed Journey outcome, including handoff failure; it does not infer success from HTTP status or Pi terminal success alone.

```text
captureEnabled = allRequests || (abnormalOutcome && failedRequests)
abnormalOutcome = closedJourney.outcome != success
```

No third setting, redaction switch, root-configuration alias, or protocol/lane-specific policy is added. Turning all-request capture off does not necessarily select Failures only; the second setting still determines the result.

#### 14.7.2 Complete bytes and media classification

At `artifact_finish`, the worker verifies a successful finish, ordered contiguous accepted chunks, byte-count equality, and the existing artifact/active-memory ceilings. For a supported complete artifact it writes the assembled bytes directly. It must not decode, parse, scrub, pretty-print, reserialize, normalize newlines, frame SSE, or repair the body. Object-only evidence is already serialized by the bounded snapshot boundary; the worker preserves those snapshot bytes identically.

Media classification uses the declared media type's lowercased essence before `;`, without inspecting body content:

| Media type | Body policy |
|---|---|
| `application/json` or a media type ending in `+json` | Preserve complete bytes, with `.json` extension |
| `application/jsonl`, `application/x-jsonlines`, `application/ndjson`, `application/x-ndjson` | Preserve complete bytes, with `.jsonl` extension |
| `text/event-stream` | Preserve complete bytes, with `.sse` extension |
| `application/octet-stream`, `image/*`, `audio/*`, `video/*`, `application/pdf`, `application/zip` | No body file; `unavailable:binary_body_not_persisted` |
| Missing or other media type | No body file; `unavailable:unsupported_media_type` |

Invalid JSON/JSONL/SSE syntax, malformed UTF-8, duplicate keys, an SSE event without a terminal marker, or sensitive-looking field names do not invalidate complete byte evidence. Byte completeness is a recorder fact, not a document-validity judgment. Embedded image/base64 data inside supported JSON stays unchanged; it is not independently classified as a binary artifact. Protocol validation and lane-owned SSE repair remain serving concerns and cannot be influenced by this policy.

For a supported body whose write succeeds, the completed descriptor is `captured`, has `capturedBytes === originalBytes`, and has `truncated:false`. Zero-length complete bodies are valid captured evidence and must remain distinguishable from missing evidence. A queue rejection, acquisition size limit, abandonment, missing finish, chunk/order/count mismatch, process loss, or file-write failure yields `unavailable` with a bounded acquisition reason and zero persisted body bytes. No prefix body is finalized; truncation and known original counts remain truthful. Discarded bytes are never called a `partial` retained artifact. Media-policy rejection records `truncated:false` when acquisition was complete.

The body-redaction module, isolate-source injection, declarations, calls, failure reasons, Authority defaults/writes, descriptor/event fields, wire validation/projection, UI labels, and obsolete tests must be removed, not retained as constants or disabled branches. `partial` artifact state is removed from the complete-only artifact contract; semantic message partiality remains a separate Pi/protocol fact. Non-body fact scrubbing, error alias safety, and safe-envelope serialization remain active.

#### 14.7.3 Write timing, cleanup, and capacity

Complete eligible bodies are written to `.part` at `artifact_finish`, before Journey close knows retention eligibility. Close either indexes/finalizes the body under the retained v5 Journey or removes the provisional body. This ordering is unchanged. Failures only is a final-retention policy: a successful request can transiently leave an unredacted `.part`. Off also means no final body retention, not a guarantee of no transient write: existing byte recorder paths can finish before close, while object snapshot paths may skip capture when both settings are off. This revision does not add a policy gate to serving paths or alter their observation seams.

An incomplete capture never writes a prefix file. If writing or finalization fails after a provisional file is created, cleanup is contained and attempted within the diagnostics process; a cleanup failure becomes diagnostics-health degradation and never a serving failure. Startup finalizes recoverable indexed v5 Journeys before deleting unreferenced v5 `.inflight` orphans. Abrupt termination can leave raw files until that cleanup succeeds; no retention switch promises immediate secure erasure.

Existing bounds remain: 64 MiB per naturally yielding artifact, 512 MiB per Journey and across active worker artifacts, 16 MiB Backend admission/unacknowledged artifact windows, and a 1 MiB synchronous object snapshot. Existing retention defaults remain 5 GiB, 1000 artifact Journeys, and seven days. Acquisition limits reject capture without changing serving; retention limits evict saved bodies as specified in section 14.6. No failure permits a backup writer, handler writer, or second diagnostic store.

File creation retains `0o600` permissions where supported, managed-root path validation, and atomic body/directory rename. Deployment must restrict the diagnostics directory using the platform's actual permissions/ACLs; a mode argument alone does not certify Windows access restrictions. Permissions and retention do not make the files sanitized.

#### 14.7.4 Safe facts, envelopes, and product disclosure

Raw bodies and allowed object snapshots may contain credentials and user content. They cross the private artifact IPC path and enter only the managed body files. They never enter SQLite/WAL/SHM body storage, admission/event payloads, failure messages, manifests, ordinary Control Plane projections, subscribers, exports, or the desktop Renderer. File manifests and descriptors contain only bounded safe metadata.

Header handling remains the existing safe-envelope policy: Authorization, Cookie, x-api-key, and other non-allowlisted values are omitted; only bounded header names record the omission. URL userinfo is stripped; non-allowlisted query values are replaced; safe header/query allowlists and envelope limits remain unchanged. This revision does not create full-header capture or independently read credential objects. Safe failure facts, `safeMessage`, classification, Runtime Events, and exception summaries continue their existing scrubbing and alias-safety rules.

Settings must keep the existing All requests / Failures only / Off states and show a persistent, visible disclosure beside Request capture. Required meaning: capture files are unredacted and can contain credentials, tool output, and user code; default failure capture also writes this content; turning off all-request capture does not turn off failed-request retention; retention Off does not promise absence of transient files; Open artifact opens the unredacted file. Help text alone or a warning visible only after enabling all-request capture is insufficient. The warning is product disclosure, not a new confirmation flow.

### 14.8 Control Plane and single-version contract

The Application Control Plane is the only management seam into the running diagnostics authority. This revision requires wire contract version 8, replacing the implemented version 7 because artifact DTOs lose fields/states. Matching Backend, Control Plane client, preload, Main, and Renderer contracts cut over together. Unsupported versions are rejected through existing version negotiation, never translated or silently accepted. Operations remain equivalent to:

- `queryRequestJourneys(query)`;
- `getRequestJourney({ requestId })`;
- `getRequestArtifact({ requestId, artifactId, offset, limit })`;
- `getDiagnosticsStorageStatus()`, returning only the resolved full-journey directory and fixed artifact limit;
- `subscribeRequestJourneys(listener)`;
- `queryRuntimeEvents(query)` and `subscribeRuntimeEvents(listener)`;
- `getAnalytics(query)`, preserving current product analytics semantics while sourcing them from Journeys.

Every closed abnormal `RequestJourneySummary` carries `diagnosis: RequestJourneyDiagnosis`; `primaryFailureLocation` no longer exists. The diagnosis contains `evidence`, `classification`, `safeMessage`, `origin` (including `unknown`), `originPrecision`, and the full location. `observed` identifies a captured primary failure. `fallback` identifies only the last confirmed boundary and must be rendered without implying a more precise cause. The Overview row displays HTTP/terminal status, safe message, and human-readable phase/lane/step without requiring expansion; stable classification remains in technical detail.

Each `queryRequestJourneys` result and closed-Journey subscription may include
one bounded row-level usage projection. The authoritative Semantic Conversion
source is the terminal Pi `AssistantMessage.usage`; Direct Mode and Provider Native
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

Analytics contract v3 counts every Overview request in `totalRequests`.
`unsupported_transport` and the optional `token_counting` probe remain stored
diagnostic Journeys but do not enter Overview lists, filter options, totals, or
series. Every included request with a usage fact, including failed and aborted requests, contributes to
`usageRequests` and to the three token sums; the remainder is
`missingUsageRequests`. `speedRequests` counts usage-bearing requests with a
positive execution duration. Derived values are:

```text
cache hit   = sum(cacheRead) / sum(input + cacheRead), when denominator > 0
token speed = sum(output) / sum(execution duration seconds), for speedRequests
```

An undefined derived value is omitted from the wire contract and rendered as
`—`. Coverage is shown only when the relevant request count is below the total.

Explicit `getRequestArtifact` calls return at most 256 KiB of decoded file bytes per call, encoded as base64. This authenticated local-management operation is a trusted unredacted-content channel, not a safe fact projection. Decoding and concatenating its chunks must reproduce the file bytes, including credential canaries. It must not apply response-time redaction. Ordinary queries, status, subscriptions, exports, and errors never embed those chunks or body previews.

The desktop Renderer requests one named open action and receives neither artifact bytes nor a filesystem path. The diagnostics authority resolves `requestId + artifactId`, verifies that the indexed existing file is a regular file below the v5 managed root, and returns that one absolute path through the authenticated local Control Plane to trusted Electron Main. Main opens the unredacted file directly with the system default viewer and falls back to the platform application chooser when no association exists; it does not read or copy the body. Subscriber, query, file-reference, file-read, desktop-open, and renderer failure is contained in its owning observation/management module and cannot affect the diagnostics child process or Data Plane. When the child/database/file is unavailable, reads and file references return a typed `unavailable` result with diagnostics-health facts; they do not fabricate a path or empty-complete body and do not open SQLite or scan the capture directory directly.

Core observations, persisted events/descriptors/manifests, Control Plane DTOs, strict key allowlists, Desktop fixtures, and UI consume the same new artifact contract. `redaction` is neither required nor optional, receives no default, and has no old-key acceptance rule. Old `redaction` fields or `partial` artifact states are not decoded by a compatibility path. Remove obsolete body-redaction labels instead of replacing them with a constant status.

The production cutover is atomic and does not dual-write. New production opens only `TOKEN_diagnostics v5` at the paths in section 14.6. Queries, history counts, deletion, backup, export, retention, and orphan cleanup operate only on that store/tree. No old-version data or code is imported, displayed, translated, or kept dormant for rollback. Incompatible or corrupt v5 storage raises operational attention while Data Plane serving remains fail-open.

Removing the new feature in a later release requires an explicitly defined replacement contract; this specification supplies no downgrade reader or automatic rollback mode. Reverting source code is not data cleanup and does not scrub or remove previously written raw files. Older artifacts cannot be recovered as original bytes after prior redaction. Any cleanup of older or unredacted data requires a separate explicit data-management action.

### 14.9 Runtime certification requirements

Non-interference is proved by comparing each fault-injected run with the same request under diagnostics disabled. Tests use latches/barriers rather than elapsed-time thresholds to prove that the request completes without a diagnostics acknowledgement.

For a throwing Observer/recorder/policy source, saturated ordinary and reserved queues, failed child spawn/IPC, stalled/crashed/malformed/disconnected/out-of-memory diagnostics child process, slow/locked/unavailable SQLite, directory creation/body write/manifest rename/retention/cleanup failure, non-body fact-scrubbing failure, oversized/cyclic/proxy artifact input, subscriber/query/renderer exception, and cancellation/Provider-terminal race, the following must be byte- or fact-identical to the disabled baseline:

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
5. every artifact slot is `captured`, `unavailable`, or `not_applicable` with truthful byte/completeness facts and a reason where required; no incomplete prefix file is finalized;
6. no record claims Client consumption;
7. credential header/URL canaries are absent from published safe envelopes and ordinary facts; body canaries are absent from SQLite/WAL/SHM, manifests, ordinary Control Plane fact projections, exports, and subscriptions, and present unchanged in retained body files and decoded explicit body-read results;
8. architecture checks forbid Data Plane imports of the child-process supervisor, store, filesystem, or SQLite, `await` on observations, handler-generated request IDs, and observation transports injected into Pi execution;
9. architecture checks preserve the three lane dependency prohibitions while allowing only the shared observation vocabulary.

#### 14.9.1 Protocol/lane and policy matrix

Each cell certifies both an available success body and available abnormal bodies against the retention table in section 14.7.1. For abnormal cases cover normally sealed `failed`, `aborted`, and `interrupted` outcomes. A stage not reached is unavailable and must not be fabricated. Abrupt process interruption is separately tested for truthful degraded coverage and orphan cleanup, not promised complete history.

| Protocol / lane | All=true, Failed=true | All=true, Failed=false | All=false, Failed=true | All=false, Failed=false |
|---|---|---|---|---|
| Responses / Direct | All requests | All requests | Failures only | Off |
| Responses / Provider Native | All requests | All requests | Failures only | Off |
| Responses / Semantic | All requests | All requests | Failures only | Off |
| Anthropic / Provider Native | All requests | All requests | Failures only | Off |
| Anthropic / Semantic | All requests | All requests | Failures only | Off |

Tests use the real composed lane and diagnostics process. Reopening a persisted file proves byte equality to the owning boundary fixture; an Authority acknowledgement, descriptor length, or string parse is not enough. Semantic object evidence is compared to its bounded boundary snapshot, not to hypothetical HTTP serialization. Assert absent Semantic upstream wire collection and unchanged safe-envelope omissions in both protocols.

#### 14.9.2 Body evidence, settings, and failure gates

Certification must include:

- Request and response bytes containing secrets, JSON whitespace/key order, malformed JSON/JSONL, malformed UTF-8, SSE `\r\n`, multi-line `data:`, comments, and incomplete event syntax in an otherwise completely received body. The stored bytes remain identical, and the serving response remains identical to diagnostics disabled.
- Supported empty bodies, declared binary/unsupported media, exact configured capture boundaries, acquisition exceeding those boundaries, the 1 MiB object-snapshot bound, missing finish, chunk mismatch, abandonment, and queue rejection. Capture failure has no body file or invented complete descriptor; no arbitrary serializer/getter/toJSON code executes.
- P0 settings snapshots for success and abnormal Journeys, including setting changes during the Journey and policy-source exceptions using catalog defaults. After close, rejected bodies have unavailable descriptors and no indexed/provisional body left when cleanup succeeds.
- Barrier-observed provisional `.part` creation before close in Failures only and existing byte-recorder Off paths, deletion after a successful policy-rejected close, and restart cleanup after process loss. Tests prove temporary raw content is real without promising all operations produce it.
- Acquisition failure versus retention eviction: the former never saves a prefix; the latter deletes a previously complete body and preserves its historical counts/hash/truncation with `unavailable:expired`. All retention ceilings, containment of eviction failure, and exclusion of active Journeys remain certified.
- Explicit body reads with base64 decoded before comparison. The body contains the original canary while SQLite/WAL/SHM, manifests, safe queries/status/subscriptions, errors, and the SQLite-only export/backup contain none. Credential-management hygiene tests remain intact; they are not a substitute for artifact-file and body-read tests.
- Actual file-write/rename failure, worker unavailability/crash, stalled acknowledgements, queue saturation, and unavailable/slow storage under the section 14.9 equivalence test. Former redactor-rejection tests become invalid-document raw-capture tests; storage faults, not parsing rejection, prove write-failure containment.

#### 14.9.3 Single-contract cutover and isolation gates

Seed synthetic older storage plus sentinel files, then start the new runtime. Query, file read/open, settings directory display, backup, export, history deletion, retention, and orphan cleanup must exclusively address v5. Older sentinels remain byte-identical and absent from all new views/exports. This is exclusion certification, not an old-data decoder. A mismatched schema placed at the v5 path degrades diagnostics without creating an alternative store. Old wire versions and old artifact fields/states are rejected rather than projected into the new contract.

Static review must prove removal of the artifact-body redactor and isolate source, all `redaction` field writes/defaults/key allowlists/projections/labels, obsolete artifact `partial` handling, production v4 paths, old readers/writers, deprecated aliases, migration helpers, and dormant compatibility branches. Non-body safe-fact scrubbers and safe-envelope code remain referenced and certified. Companion historical design/implementation records do not authorize old production paths.

Every test or manual Backend/CLI/Electron/helper verification that can reach Codex state must run through the repository test sandbox or an equivalent newly created temporary `CODEX_HOME`. Copy only required `config.toml` and `token-model-catalog.json` when present, pass the temporary home explicitly to every process, and remove it in `finally`. Never copy native/auth/model caches, sessions, logs, or other user-owned state. Use deterministic local Provider fixtures and fake canaries; diagnostics verification does not require real credentials.

Implementation release gates are `npm run typecheck`, `npm run lint`, `git diff --check`, sandboxed targeted diagnostics/journey/Provider Native/Control Plane/Desktop tests, and sandboxed `npm test`. Five composed-lane manual checks must verify persisted byte equality or snapshot equality at the declared boundary, safe-envelope behavior, explicit raw body access, and absence of body secrets from the index. The gates apply to implementation; editing this specification does not imply they have passed.

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
| Direct Mode upstream rejects caller credential | P4/P5 Direct Mode upstream response preservation |
| Direct Mode transport/body-read failure | P4 Direct Mode dispatch/read step |
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
