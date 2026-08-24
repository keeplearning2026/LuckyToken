# LuckyToken Request Journey Diagnostics Implementation Plan

- **Status:** implementation complete; guarded release certification passed on 2026-08-23
- **Authority:** `LuckyTokenRequestJourneyDiagnosticsSpec.md`
- **Method:** test-driven replacement; no dual-write compatibility period
- **Release rule:** the production cutover is atomic and is not releasable until every final gate is green

## 1. Objective

Replace Request Ledger, Invocation Diagnostics, Deep Capture, and request-owned Runtime Diagnostics with one observation-only diagnostics authority.

For every admitted request, the resulting Request Journey must answer:

1. which operation and Data Plane lane were selected;
2. which P0-P8 phase and lane-owned step last ran;
3. where a failure originated and where it was detected;
4. what request, response, attempt, Profile, conversion, and handoff evidence is available;
5. what evidence is missing, truncated, redacted, or unavailable and why.

Diagnostics are never part of request correctness. Disabling diagnostics, exhausting its queues, failing redaction, crashing or stalling its Worker, locking SQLite, or throwing from a subscriber must not change routing, credentials, conversion, transport, retry, cancellation, status, headers, body, stream ordering, or work outcome.

## 2. Fixed architecture

```text
Data Plane producers
  -> synchronous no-throw RequestJourneyObserver
  -> bounded in-process admission/flight recorder
  -> one Diagnostics Worker
  -> state/request-diagnostics/diagnostics.sqlite3

Application Control Plane
  -> Diagnostics management Interface on the same Authority object
  -> Worker commands
  -> the same SQLite database
```

The Worker is the only actor allowed to open, query, back up, or mutate the diagnostics database. Data Plane code imports only the observation vocabulary. Control Plane semantic DTOs belong to the Application Control Plane package; Core observation types must not depend on that package.

The three Data Plane lanes share only request-edge identity, lifecycle facts, and the observation vocabulary. They do not share an executor, credentials, request construction, transport, retry state, response handling, or semantic representation.

## 3. TDD and review protocol

Every implementation slice follows this order:

1. add one focused test that fails because the intended behavior is absent;
2. confirm the failure is at the expected assertion, not an unrelated compile or fixture failure;
3. implement the smallest coherent production change;
4. run the target test, directly related regression tests, TypeScript, and ESLint;
5. review information ownership and the three-lane dependency boundaries;
6. keep the final release/cutover assertions red until their prerequisites are genuinely complete.

Tests that can reach Codex state must run through the guarded test runner with a newly created temporary `CODEX_HOME`.

Parallel work is allowed only for file-disjoint slices with independently testable contracts. Contract or composition changes are integrated by one owner. The Control Plane, configuration, and Application composition cutover are coordinated as one join because partial compatibility is explicitly forbidden.

## 4. Implementation slices

### Slice 0 — Freeze vocabulary and non-interference gates

Define and test:

- P0-P8 phases, operation kinds, lane names, directions, subjects, and locations;
- Request admission, observations, Incident, artifacts, work outcome, handoff, and close seal;
- requestless Runtime Events under the same authority;
- one request ID created at the request edge;
- synchronous no-throw observation Interfaces;
- diagnostics-disabled versus fault-injected equivalence fixtures.

**Green gate:** observation calls expose no Promise or result that the Data Plane can use for a decision, and architecture tests forbid Data Plane imports of Worker, SQLite, management, and persistence modules.

### Slice 1 — Build the single diagnostics runtime

Implement behind one deep module:

- bounded ordinary queue, reserved terminal capacity, and per-admitted-Journey close reservation;
- bounded failed-request flight recorder;
- centralized serialization, redaction, truncation, and artifact completeness;
- one Worker-owned `luckytoken_diagnostics v1` SQLite schema;
- append ACK/NACK, idempotent replay after lost ACK, and same-runtime Worker restart;
- startup incompatibility and Worker-construction failure as fail-open diagnostics unavailability;
- post-COMMIT subscriptions with hostile listener containment;
- shutdown flush bounded to two seconds after Data Plane drain.

**Green gate:** queue saturation, redaction failure, Worker failure, slow persistence, and subscriber failure leave a real request byte- and fact-identical to the disabled baseline.

### Slice 2 — Give every operation one Journey

Instrument the real request seams in ownership order:

1. HTTP/in-process P0 identity and P8 handoff/close;
2. unmatched route and unsupported transport rejection;
3. model discovery;
4. conversation compaction;
5. Anthropic and OpenAI Responses model generation.

The edge owns request identity and final Journey close. Handlers may refine the operation and record protocol ingress, but may not mint another request ID. A response body is materialized once, and all normal, timeout, fallback, disconnect, and socket-close paths converge on the same P8 writer.

**Green gate:** every production route has exactly one Journey and early rejection never enters a Data Plane lane.

### Slice 3 — Instrument the three independent lanes

For each lane, publish step entry immediately before owned work and step completion only after truthful completion.

#### Direct Mode

- local model recognition and lane commitment;
- caller-envelope preservation and direct envelope construction;
- dispatch and response read;
- native response preservation and real terminal usage extraction;
- local failures located only in Direct Mode steps.

#### Provider Native Preservation

- resolved model compatibility and lane commitment;
- request-bound Profile/auth capture and provider-owned envelope reconstruction;
- provider-specific request projection, including only the declared Anthropic OAuth exception;
- physical attempts, final 429, Profile transitions, and response read;
- native alias/response preservation and real terminal usage extraction.

#### Semantic Conversion

- Client Wire to Pi AI IR conversion and tool/resource lifecycle validation;
- Pi invocation and trusted Pi Provider observations for Pi IR to Provider Wire;
- Provider events to Pi IR terminal construction;
- Pi IR to Client Wire projection and response encoding;
- distinct model work, client presentation, and P8 handoff outcomes.

**Green gate:** a failure in one lane produces zero execution observations for the other two lanes, and diagnostics does not introduce a shared lane execution abstraction.

### Slice 4 — Complete query, analytics, retention, and backup behavior

Add Worker commands over the same database for:

- paged Journey summaries and full Journey reads;
- bounded artifact reads of at most 256 KiB per call;
- paged Runtime Event reads;
- analytics from real Journey facts, incrementally aggregated page by page;
- online SQLite backup without opening the database on the main thread;
- half-open history count and delete operations;
- retention that preserves immutable redaction/truncation/eviction facts.

History count and deletion include only sealed Journeys. An active Journey remains writable and cannot be turned into orphan events by a concurrent management cleanup.

Analytics producers publish only facts known at their real ownership seam. Missing or partial usage is excluded according to the current analytics contract; no adapter invents tokens, duration, Profile, model, or outcome.

**Green gate:** large paged analytics input is not materialized as one row array, backups are consistent and temporary files are removed, and all management failure returns typed unavailability rather than a fabricated empty-complete result.

### Slice 5 — Freeze Application Control Plane v3

The Application Control Plane package owns strict semantic DTOs and codecs for:

- `queryRequestJourneys`;
- `getRequestJourney`;
- `getRequestArtifact`;
- `queryRuntimeEvents`;
- both subscriptions;
- `getAnalytics`;
- typed diagnostics unavailability.

Then replace the wire contract with version 3. Remove, rather than alias, the legacy diagnostics, ledger, and capture commands and client methods. Contain subscriber failure per connection.

**Green gate:** v2 negotiation is incompatible, v3 round-trips strict DTOs, malformed wire data is rejected, old command names return `unknown_command`, and Core has no dependency on Control Plane or Electron packages.

### Slice 6 — Atomic configuration and Application composition cutover

In one coordinated change:

- change the root schema to `luckytoken-config-v2`;
- replace the four diagnostics-related roots with one strict `diagnostics` root;
- update the generated first-run configuration;
- construct one Diagnostics Authority per Backend lifetime;
- pass its observation view to every Data Plane route;
- pass its management view to the Control Plane, analytics, history, and backup owners;
- reuse the same Authority across Data Plane restart;
- stop admission and drain Data Plane work before closing producers/subscriptions and then the Authority;
- close the Authority once, with the two-second flush bound, before releasing the instance lease.

Do not read deprecated configuration fields. Do not open, import, migrate, rewrite, or delete any legacy store during startup.

**Green gate:** an Application lifecycle test observes one Authority factory call, one runtime ID, reuse across restart, one close after drain, and creation of only `state/request-diagnostics/diagnostics.sqlite3`; seeded legacy trees remain byte- and metadata-identical.

### Slice 7 — Remove legacy production paths

Delete production composition and modules for:

- `src/request-ledger`;
- `src/invocation-diagnostics`;
- `src/deep-diagnostics`;
- `src/runtime-diagnostics`;
- diagnostics-specific `src/persistence-degradation` adapters;
- old history/backup/compatibility readers that require those stores.

Move any still-valid neutral fact contract to its actual information owner before deletion. In particular, credential/Profile activity must not remain owned by Request Ledger, and conversion notices must use the provider-contract diagnostics vocabulary.

Update history export, backup, operational attention, catalog/runtime events, and desktop callers to use the single Authority or Control Plane v3. Do not keep no-op legacy factories, shims, deprecated aliases, dual readers, or dual writers.

**Green gate:** repository scans find no production import, configuration key, command, database path, or write call for the four replaced systems.

### Slice 8 — Desktop and product integration

Preserve the dependency direction:

```text
Renderer -> typed preload -> Electron Main -> Application Control Plane -> Backend Application -> Core
```

Renderer and Electron Main consume only Control Plane v3 DTOs. They never read SQLite, construct Core authorities, or duplicate diagnostics authority. Update history, export, backup, attention, and diagnostics UI states to distinguish complete, degraded, unavailable, truncated, and redacted evidence.

**Green gate:** Electron architecture certification passes and desktop management remains an out-of-process Control Plane client.

### Slice 9 — Final diagnostic-quality certification

Run the complete scenario matrix in the diagnostics specification, including:

- ingress/media/body failures;
- unknown model and cancellation before lane commitment;
- Direct Mode envelope, dispatch, and body-read failures;
- Provider Native auth, OAuth projection, final 429/Profile switch, and alias projection failures;
- all four Semantic Conversion directions and tool lifecycle failures;
- response encoding, client rendering, and P8 disconnect failures;
- compact, model discovery, unmatched route, and unsupported transport;
- throwing observer, saturated queues, redaction failure, crashed/stalled Worker, unavailable SQLite, hostile subscriber, and cancellation/terminal races;
- secret canaries absent from observation messages, database/WAL/SHM, Control Plane, subscriptions, backups, and exports.

For each fault-injection scenario, compare against the same real request with diagnostics disabled.

**Green gate:** guarded unit, integration, certification, desktop, TypeScript, and ESLint suites all pass with no release-gate exceptions.

## 5. Dependency and parallelization map

```text
Slices 0-1
    |
    +--> Slice 2 operation coverage
    |        |
    |        +--> Slice 3 lane producers
    |                    |
    +--> Slice 4 management/analytics/backup
                         |
                         +--> Slice 5 CP DTO prerequisite
                                      |
              Slice 5 CP v3 ----------+---------- Slice 6 config/Application
                                                     |
                                                     +--> Slice 7 legacy removal
                                                               |
                                                               +--> Slice 8 desktop
                                                                         |
                                                                         +--> Slice 9 certification
```

Operation and lane tests can run in parallel when they own disjoint modules. Worker analytics, backup, and history commands must be serialized when they edit the Worker actor. Control Plane DTO preparation can run beside Data Plane producers, but the version switch and Application composition change join atomically.

## 6. Final definition of done

The refactor is complete only when all of the following are true:

- one admitted request has one request ID and one Request Journey Record;
- the record identifies exact phase, lane step, failure origin/detection, attempts, outcomes, and evidence completeness;
- requestless events use the same authority without fabricated requests;
- one Worker owns one SQLite diagnostics database;
- every diagnostic observation is synchronous, no-throw, bounded, and decision-free;
- disabled and faulted diagnostics are behaviorally equivalent for the observed work;
- Control Plane v3 is the only running management seam;
- config v2 contains only the unified diagnostics root;
- the four legacy systems have no production readers or writers and their existing files are left untouched;
- the full diagnostics specification, three-lane architecture, Electron architecture, and guarded test requirements agree with the implementation.
