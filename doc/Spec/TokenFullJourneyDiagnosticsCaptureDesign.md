# Token Full-Journey Diagnostics Capture Design

Status: reviewed and implemented, based on source and test evidence inspected on 2026-08-25. Section 8 defines the fixed Pi 0.84.2 Semantic evidence boundary; raw Provider response events are intentionally outside the required diagnostic scene.

## 1. Decision

Token should support bounded, fail-open capture of the complete diagnostic scene for all three independent data-plane lanes:

1. Direct Mode;
2. Provider Native Preservation;
3. protocol-owned Semantic Conversion for OpenAI Responses and Anthropic Messages.

For a JSON-family artifact, “complete” means the complete authoritative stage-native representation, after mandatory credential redaction, up to exactly **64 MiB (67,108,864 bytes)**. An artifact over that limit, an unsupported representation, redaction uncertainty, queue saturation, persistence failure, or an observation seam that did not expose the bytes must be reported truthfully as `partial` or `unavailable`; it must never be reported as `captured`.

This is an observation capability only. Diagnostics must not select a lane, read credentials, alter a request or response, cause a retry, consume or clone a stream solely for observation, delay cancellation, apply backpressure, or change any terminal result.

Full-journey capture is an explicit user setting:

```text
diagnostics.fullJourneyCapture.enabled = false | true
diagnostics.failedJourneyCapture.enabled = true | false
```

The first switch defaults to `false` and retains complete available scene bodies for every request. The second defaults to `true` and retains complete available scene bodies only for failed, aborted, or interrupted requests when the first switch is off. Both are hot-applied and snapshotted together by the Diagnostics Module at P0. The Data Plane does not read the Settings registry and does not receive either policy as a request fact. Changing a setting affects only Journeys admitted after the successful Settings commit.

Captured files are owned by the Diagnostics Module and stored below the resolved diagnostics root:

```text
<diagnostics.directory>/full-journeys/
```

The resolved absolute folder is exposed read-only through the Application Control Plane and displayed in Settings. It is not chosen by a handler, lane, Client Protocol, renderer, current working directory, environment fallback, or user-owned Codex state. The folder and index are opened only by an independent Diagnostics child process, so a diagnostics JavaScript exception, fatal exit, or diagnostics-process memory exhaustion cannot terminate the Backend process.

The 64 MiB limit is a diagnostics JSON-artifact limit. It does not change semantic continuity limits such as the Anthropic opaque-continuity bound.

## 2. Review baseline and disposition

The pre-implementation review proved that this contract could not be met by increasing one constant: capture was one-shot and 256 KiB-limited, the per-Journey budget was 4 MiB, bodies were SQLite BLOBs, semantic snapshots were lossy, safe HTTP envelopes and desktop body inspection were absent, and only one limited non-interference case existed. Those Token-owned gaps are now addressed by the artifact recorder, independent process, v3 index/file tree, complete protocol-owned snapshots, safe envelope artifacts, paged viewer, and cross-lane tests.

Two ownership limits remain deliberately truthful:

- an intermediate Provider Native OpenAI 429 body that the normal profile-switch path does not read remains `unavailable:response_body_not_read_before_profile_switch`; diagnostics cannot add a reader, clone, tee, or await;
- the pinned Pi 0.84.2 public contract exposes the complete provider-native request payload returned by the protocol-owned `onPayload`, response status/headers through `onResponse`, and the decoded `AssistantMessage`. These are the required Semantic Provider boundary artifacts. SDK/Adapter-internal HTTP serialization and raw Provider response events are not required, and Token does not inject transport to obtain them.

## 3. Required diagnostic vocabulary

The shared diagnostics contract may describe observations, but it must not introduce a shared data-plane executor, transport, credential authority, Provider request type, or semantic invocation model.

Each artifact descriptor should contain at least:

- lane and protocol-owned stage;
- attempt/profile identity when the stage is physical-attempt-specific;
- representation, for example `wire`, `decoded-wire`, `semantic-ir`, `provider-event-stream`, or `summary`;
- media type and encoding;
- original, accepted, redacted, and persisted byte counts;
- `captured`, `partial`, `unavailable`, or `not_applicable` state;
- truncation/failure reason and content hash when available;
- a safe-envelope reference and/or body reference.

`captured` must mean complete. A bounded summary must use a summary artifact kind and cannot satisfy a full-scene requirement. Internal body references may deduplicate identical client, upstream-preserved, and client-response bytes without changing the lane-owned stage records.

The setting, policy, and evidence have one owner at each stage:

| Fact | Authoritative owner | Consumer receives |
| --- | --- | --- |
| User preference | Settings Authority | Diagnostics-only synchronous policy snapshot capability |
| P0 capture decision | Diagnostics Module | Internal immutable Journey policy; never returned to the Data Plane |
| Lane evidence | Owning lane or Client Protocol module | Immutable safe metadata and byte chunks only |
| Artifact lifecycle/completeness | Diagnostics Module | Typed descriptor through the Control Plane |
| Stored file layout and retention | Diagnostics child process | Paged reads and read-only storage status through the Control Plane |
| UI toggle/directory display | Renderer Settings feature | Settings command result plus diagnostics storage projection |

No broad settings snapshot, mutable Pi object, Provider object, transport, `Request`, `Response`, stream, credential, or storage path is passed through unrelated modules.

## 4. Settings and capture policy seam

The registered Settings catalog owns exactly two user-editable capture keys:

```text
key: diagnostics.fullJourneyCapture.enabled
type: boolean
default: false
apply: hot-apply
sensitivity: public

key: diagnostics.failedJourneyCapture.enabled
type: boolean
default: true
apply: hot-apply
sensitivity: public
```

The old static `diagnostics.successArtifacts.enabled` field is obsolete and is removed rather than retained as a third policy. Base Journey timelines, descriptors, incidents, and safe failure classifications remain always-on and fail-open. The first switch retains bodies for all outcomes. With it off, the second switch controls body retention for failed, aborted, and interrupted Journeys. With both off, descriptors remain but bodies record a truthful policy-disabled reason.

The Diagnostics Module receives one narrow internal policy capability during Backend composition:

```ts
interface JourneyCapturePolicySource {
  snapshot(): Readonly<{
    allRequestsEnabled: boolean;
    failedRequestsEnabled: boolean;
  }>;
}
```

Production adapts the Settings Authority; diagnostics tests use an in-memory adapter. `begin()` catches policy-source failure and uses the catalog defaults (`allRequestsEnabled=false`, `failedRequestsEnabled=true`). Neither `begin()` nor any observer call exposes the policy or a result that serving code can branch on.

The Application Control Plane exposes a named, read-only diagnostics storage query containing the resolved full-journey directory and fixed artifact limit. It does not expose child-process IPC details, temporary paths, SQLite handles, file handles, or arbitrary filesystem operations. Electron Main remains a thin typed bridge; the Renderer changes the switch only with the existing Settings command and displays the directory returned by the diagnostics query.

## 5. Deep artifact capture module

Replace the one-shot body observation with a diagnostics-owned, synchronous, no-throw lifecycle such as:

```ts
interface ArtifactRecorder {
  append(bytes: Uint8Array): void;
  finish(result: { originalBytes: number; complete: boolean; reason?: string }): void;
  abandon(reason: string): void;
}

interface RequestJourneyObserver {
  openArtifact(meta: ImmutableArtifactMeta): ArtifactRecorder;
}
```

All methods return immediately, return no serving decision, and expose no Promise. Failure returns or converts the recorder to a no-op recorder. The data-plane owner may publish bytes it already owns, in small immutable chunks; diagnostics never obtains a `Request`, `Response`, stream reader, Provider object, credential object, abort controller, or mutable semantic object.

Recommended chunk size is 64 KiB. Exact size is an implementation detail, but the following bounds are contractual and independent:

- JSON-family artifact accepted bytes: 64 MiB;
- per-journey accepted and persisted bytes: 512 MiB by default, independently bounded so one Semantic Journey can retain all declared stages;
- main-process unacknowledged queue bytes: small and fixed;
- process-wide active-capture bytes: fixed;
- retained disk bytes/age: fixed and policy-controlled, with an explicit total-byte ceiling in addition to age and Journey count.

The Backend process must not accumulate a 64 MiB artifact until journey close. It copies already-owned bytes into at most 64 KiB IPC chunks and admits at most 16 MiB of unacknowledged data. An independent Diagnostics child process owns the complete-document buffer, bounded to 64 MiB per artifact and 512 MiB process-wide, because JSON secrecy cannot be proved from a truncated prefix. Child-process acknowledgement releases Backend queue capacity. IPC backpressure or saturation stops diagnostic acceptance, marks the artifact unavailable/partial truthfully, and leaves observed work untouched. No Data Plane request awaits IPC or an acknowledgement.

Persistence uses a new diagnostics schema and a Diagnostics-process-owned file tree. The child process is the only actor that opens either the SQLite index or the capture tree:

```text
<diagnostics.directory>/
  diagnostics-v3.sqlite3
  full-journeys/
    .inflight/<runtime-id>/<request-id>/
    YYYY-MM-DD/<request-id>/
      manifest.json
      artifacts/
        client-request-wire-<hash>.json
        pi-provider-request-payload-<hash>.json
        ...
```

Runtime and request IDs are hashed into opaque path segments. Artifact names use only a bounded allowlisted slug plus a short hash and a media-accurate extension. Every resolved path is checked to remain below the managed root. Directories are private to the current user; files are created with owner-only permissions where supported. Only sanitized complete bodies are written as `.part` files below `.inflight`; raw IPC chunks never reach disk. On close, the child commits the closed index row and provisional relative references, then atomically writes the manifest and renames the directory into its final date partition outside the SQLite transaction. A crash on either side is recoverable: the next diagnostics-process start finds closed rows still pointing into `.inflight`, finalizes them idempotently, and removes only unreferenced `.inflight` orphans. No request path performs or waits for recovery.

SQLite remains the authoritative Journey index and manifest relationship; the file tree is child-process-owned artifact-body storage, not a second diagnostics authority. Queries and exports go through the Control Plane, never by scanning the folder from the Renderer or Data Plane. Deletion first removes/seals index references transactionally and then garbage-collects unreferenced Journey directories. Retention applies the same rule. Under the project compatibility policy, replace the obsolete v2 shape rather than adding dual readers/writers or a migration shim unless compatibility is explicitly requested.

The Backend owns a bounded diagnostics-process supervisor. Spawn failure creates a no-op observation Adapter. Unexpected diagnostics exit records only process-local health when possible and schedules bounded restart (`100 ms → 500 ms → 2 s → 10 s → 30 s`). Pending messages remain subject to the same byte cap and may be dropped truthfully. The child is launched with no serving sockets, credentials, Provider objects, cancellation handles, or authority over Backend lifecycle. Its `error`, `disconnect`, malformed-message, timeout, and `exit` events are all contained; none is rethrown on the Backend event loop. Diagnostics shutdown happens only after Data Plane drain and is bounded, so a hung child is terminated without delaying normal serving or preventing Backend shutdown.

At close, the P0 snapshot selects retention without consulting the Data Plane: all-request capture retains every outcome; otherwise failure capture retains failed, aborted, and interrupted outcomes. A successful body rejected by policy records `unavailable:full_journey_capture_disabled`; an abnormal body rejected by policy records `unavailable:failed_journey_capture_disabled`. A mid-request setting change never produces a mixed policy.

## 6. Isolated complete-document redaction

Credential-bearing request/response headers and URL credentials are excluded at the lane owner through a small allowlist serializer before observation. Body values can contain arbitrarily named secrets, so Token does not parse or stringify up to 64 MiB on the Backend event loop. Raw body chunks cross only the private child-process IPC seam transiently; the child is launched with an empty environment, ignored stdio, no serving sockets, no credentials, and no lifecycle authority. Raw bytes are bounded in memory and are never written to SQLite or disk.

After `finish` proves the complete byte count, the child performs fail-closed redaction and only then writes a sanitized file:

- JSON and `+json`: parse the complete document, redact secret-named fields and credential patterns in strings, then serialize with two-space indentation for human reading; if indentation alone would cross the 64 MiB ceiling, keep the bounded compact sanitized form;
- JSONL/NDJSON: frame complete records and redact every JSON record;
- SSE: frame complete events, redact JSON `data:` payloads, preserve `[DONE]`, and reject unclassified non-JSON data rather than guessing it safe;
- safe envelopes: retain method/status, sanitized URL, and allowlisted protocol/diagnostic headers; authorization, cookie, API-key, signing, proxy-credential, and unknown header values never enter IPC;
- binary or unknown encodings: remain unavailable unless a separately reviewed redactor exists.

This child-owned complete-document design is intentional: doing 64 MiB parsing or synchronous streaming-tokenizer work in the Backend would let diagnostics CPU, memory, or parser defects delay normal requests. If the child crashes or exhausts memory, the artifact degrades and the supervisor restarts it; serving remains authoritative.

If syntax is malformed, the value crosses an unsupported boundary, or completeness cannot be proved, stop retaining the body and record `partial` or `unavailable` with a reason. Redaction, validation, hashing, setting-policy, queue, child-process, directory, file, SQLite, query, subscription, and renderer errors are diagnostic health events only. They are caught at the diagnostics seam and cannot escape into routing, conversion, dispatch, retry, cancellation, response construction, HTTP handoff, or terminal-outcome code.

## 7. Lane-owned capture matrices

The tables define required diagnostic stages. Each lane publishes only facts it already owns at an existing lifecycle seam.

### 7.1 Direct Mode

| Stage | Required artifact | Authoritative owner/seam |
| --- | --- | --- |
| Client ingress | Method, safe path/query/header envelope, complete decoded JSON body | Server request body owner after normal body acquisition |
| Lane commitment | Direct Mode model/capability recognition outcome without credentials | Direct Mode router |
| Direct Mode upstream request | Final method, URL with secrets removed, safe headers, exact outbound body | `src/codex-direct-responses-transport.ts` after ordinary request construction |
| Direct Mode upstream response | Status, safe headers, complete body as normally consumed | Direct Mode response owner |
| Client egress | Status, safe headers, exact body emitted to the client | `src/server.ts` response-emission owner |

No Pi Model, Pi AI IR, Provider Native transport, alias resolver, or semantic module participates.

### 7.2 Provider Native Preservation

| Stage | Required artifact | Authoritative owner/seam |
| --- | --- | --- |
| Client ingress | Safe envelope and complete decoded JSON body | Server request owner |
| Lane commitment | Resolved Pi model/API and profile identity, excluding auth | Provider Native router |
| Physical upstream attempt | Final method, safe URL/headers, exact body for every attempt/profile | `src/provider-native-responses/openai.ts` or `src/provider-native-anthropic/transport.ts` after lane-owned construction |
| Physical upstream response | Status, safe headers, body bytes that normal lane behavior consumes | Provider-native response owner, per attempt |
| Preservation result | Exact response representation selected for client preservation | Protocol-specific Provider Native handler |
| Client egress | Status, safe headers, exact emitted body | Server response-emission owner |

For an intermediate OpenAI 429 whose body is not normally read before profile switch, current truthful evidence remains `unavailable`. If complete capture of that body becomes mandatory, the Provider Native lane must adopt bounded materialization as its normal behavior with diagnostics both enabled and disabled. Diagnostics itself must not add a reader, clone, tee, or await.

### 7.3 OpenAI Responses Semantic Conversion

| Stage | Required artifact | Authoritative owner/seam |
| --- | --- | --- |
| Client ingress | Safe envelope and complete OpenAI Responses Client Wire JSON | Server/request converter boundary |
| Protocol invocation | Complete protocol-owned invocation, Pi context/options, tools, reasoning/continuity facts, and projection supplement; credentials/functions/signals excluded | OpenAI Responses semantic module |
| Provider request payload | Complete provider-native payload returned by the protocol-owned `onPayload` after Pi construction and protocol projection; excludes credentials and Adapter/SDK transport serialization | OpenAI Responses semantic executor through pinned Pi `onPayload` |
| Provider response evidence | Safe response status/headers plus the complete decoded Pi `AssistantMessage`; raw Provider events are not required | Pinned Pi `onResponse` plus OpenAI Responses semantic executor |
| Pi result | Complete Pi `AssistantMessage` representation plus protocol-owned continuity provenance required by the response converter | OpenAI Responses semantic module |
| Client egress | Exact OpenAI Responses result/status/safe headers/body | Response converter/server emission owner |

### 7.4 Anthropic Messages Semantic Conversion

| Stage | Required artifact | Authoritative owner/seam |
| --- | --- | --- |
| Client ingress | Safe envelope and complete Anthropic Messages Client Wire JSON | Server/request converter boundary |
| Protocol invocation | Complete protocol-owned invocation, Pi context/options, tools, reasoning/continuity facts, and Anthropic-owned projection supplement; credentials/functions/signals excluded | Anthropic Messages semantic module |
| Provider request payload | Complete provider-native payload returned by the protocol-owned `onPayload` after Pi construction and protocol projection; excludes credentials and Adapter/SDK transport serialization | Anthropic semantic executor through pinned Pi `onPayload` |
| Provider response evidence | Safe response status/headers plus the complete decoded Pi `AssistantMessage`; raw Provider events are not required | Pinned Pi `onResponse` plus Anthropic semantic executor |
| Pi result | Complete Pi `AssistantMessage` plus Anthropic-owned opaque continuity provenance | Anthropic Messages semantic module |
| Client egress | Exact Anthropic Messages result/status/safe headers/body | Response converter/server emission owner |

OpenAI and Anthropic must implement their own serializers and artifact-stage definitions. They may share only the mechanism-only recorder, chunking, redaction, hashing, and storage facilities. No common Semantic Invocation, supplement, projector registry, semantic executor, outcome union, or semantic error may be introduced.

## 8. Pinned Pi 0.84.2 Semantic evidence boundary

The required Semantic Provider request artifact is the complete provider-native payload returned from the protocol-owned `onPayload` projection operation. This is Pi 0.84.2's public request-construction boundary: Pi has constructed the selected Adapter's payload, the owning Client Protocol has applied and verified its certified projections, and that exact returned value continues into the Adapter. Credentials, URL/header transport assembly, SDK serialization, signing, and fixed transport framing that an Adapter adds later are outside this artifact and must not be reconstructed or guessed.

The required Semantic response scene deliberately stops at the public Pi boundary. Raw Provider response events are not required. Token records safe status/headers when Pi calls `onResponse`, then records the complete decoded Pi `AssistantMessage` and protocol-owned continuity provenance. A failure before either callback receives an explicit unavailable descriptor for that required public-boundary artifact; it does not create a raw-wire placeholder.

Each Semantic Client Protocol owns its own artifact names and serialization:

1. `pi_invocation_snapshot`: complete protocol-owned invocation/Pi Context and safe Pi options, excluding functions, signals, credentials, transport objects, and mutable execution state;
2. `pi_provider_request_payload`: complete value returned by that protocol's `onPayload` operation;
3. `pi_provider_response_metadata`: safe status and allowlisted headers published through Pi `onResponse`, or a truthful unavailable reason when the callback was not reached;
4. `pi_provider_response_ir`: complete decoded Pi `AssistantMessage` and protocol-owned continuity facts, or a truthful unavailable reason when decoding did not complete;
5. `client_response_wire`: exact Client response body at the normal response-emission seam.

There is no `pi_provider_final_request_wire` or `pi_provider_raw_response_wire` contract. Product/UI language says “Provider request payload”, “Provider response metadata”, and “Pi response IR”; it does not call these raw HTTP wire. A global fetch wrapper, injected diagnostic transport, `Response.clone()`, tee, second consumer, hidden Pi fork, or guessed post-Adapter field remains prohibited because it would violate ownership and non-interference.

## 9. Non-interference proof

For every lane and semantic Client Protocol, run the same request with diagnostics disabled and with each of the following diagnostic conditions:

- complete capture enabled;
- observer/recorder methods throwing;
- recorder queue saturated from the first chunk and mid-artifact;
- diagnostics child process stalled, crashed, malformed, disconnected, out of memory, or unavailable;
- SQLite locked/unavailable and retention disk budget exhausted;
- redactor rejecting or failing mid-token;
- capture-policy source throwing and setting changed during an active Journey;
- child-process spawn/IPC/exit plus directory creation, file append, manifest rename, and garbage collection failures;
- exactly 67,108,864 bytes and 67,108,865 bytes;
- cancellation at request, upstream-response, and client-emission boundaries;
- retry/profile-switch transitions where supported.

Assert byte-for-byte equivalence of selected lane, resolved model/profile, physical attempt sequence, outbound method/URL/safe-relevant headers/body, upstream consumption behavior, retries, cancellation winner, client status/headers/body, and terminal outcome. Diagnostic completeness/health may differ; serving behavior may not.

The tests must also prove that diagnostic failures are contained synchronously: no observer method throws, returns a Promise, schedules a serving callback, mutates an input buffer/object, or returns a value used by the caller. Latches/barriers prove request completion without child-process or filesystem acknowledgement; elapsed-time thresholds alone are insufficient.

Add end-to-end success and failure capture tests for:

- Direct Mode;
- Provider Native OpenAI Responses;
- Provider Native Anthropic Messages;
- OpenAI Responses Semantic Conversion;
- Anthropic Messages Semantic Conversion.

Tests that can reach Codex state must use a fresh temporary `CODEX_HOME`, copy only approved fixtures, pass that path explicitly to every process, clean it in `finally`, and run through guarded npm commands.

## 10. Control Plane and desktop inspection

Keep artifact retrieval paged and add metadata-first inspection. The renderer must never load artifact bytes or a 64 MiB body into one message, state value, or DOM node.

- Fetch descriptors and safe envelopes first.
- A named desktop open action lets Electron Main fetch body pages with explicit offset/limit into one private bounded temporary file, open it with the system default viewer, and fall back to the platform chooser when no association exists.
- Group captures by journey stage, show readable collision-safe filenames, and use a contextual magnifier action for each available file; do not render raw bodies inline.
- Support stage-to-stage comparison by requesting bounded windows, not whole bodies.
- Display `complete`, `partial`, or `unavailable`, original/captured byte counts, redaction status, and reason prominently.
- Put both switches in Settings → Data & privacy: all-request capture defaults off and failed-request capture defaults on. Describe their sensitive-data and disk-use implications and display the resolved managed directory.
- Export, if added, must stream through the Control Plane and preserve the same access controls and redaction guarantees.

## 11. Implementation and certification order

1. Revise `TokenRequestJourneyDiagnosticsSpec.md` and introduce the Settings-owned switch, Diagnostics-owned managed folder, independent child-process isolation, v3 artifact/completeness/configuration contract, and exact 64 MiB JSON limit.
2. Add red Settings, storage-directory, non-interference, and boundary tests before production wiring.
3. Implement the policy snapshot Adapter, chunked recorder, isolated complete-document redaction, bounded IPC queue/process supervisor, provisional v3 file storage/index, health reporting, and paged read contract.
4. Wire Direct Mode and both Provider Native implementations at their lane-owned seams.
5. Wire `pi_provider_request_payload`, safe response metadata, and decoded response IR independently for OpenAI Responses and Anthropic Messages through official Pi 0.84.2 public callbacks.
6. Replace lossy semantic snapshots with complete protocol-owned artifacts while retaining optional summaries only as explicitly labelled convenience artifacts.
7. Add the Settings toggle/directory display, paged/virtualized desktop viewer, and the full cross-lane certification matrix.

The milestone is implemented under the required public-boundary scene above. Missing required callback/IR stages remain visible as `partial` or `unavailable` rather than being hidden behind summaries. Raw Provider response events and Adapter/SDK-internal HTTP wire are intentionally not part of the Semantic diagnostic contract.
