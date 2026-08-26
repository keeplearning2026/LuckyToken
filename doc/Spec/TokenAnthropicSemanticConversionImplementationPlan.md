# Anthropic Messages Semantic Conversion vNext Refactoring Implementation Plan

Status: **IMPLEMENTED AND VERIFIED**

Date: **2026-08-25**

Scope: **Anthropic Messages Client Protocol on the Semantic Conversion lane only**.

This plan replaces the previous Anthropic implementation plan. It incorporates the
latest availability, Supplement, request-repair, response-rendering, and
specification-authority decisions. It is intentionally implementation-oriented:
each slice names its production scope, test seam, red evidence, implementation
work, cleanup, and completion gate.

## 1. Outcome

Refactor the Anthropic Messages Semantic Module so that it:

1. accepts the Claude-compatible message-level `role: "system"` extension;
2. honestly repairs interrupted Client tool histories without weakening invalid
   relationship checks;
3. rejects `max_tokens=0` at Client ingress;
4. uses one fixed, typed, immutable, candidate-only Anthropic Projection
   Supplement;
5. treats server-tool and `inference_geo` target unavailability as omission rather
   than a dispatch-blocking semantic failure;
6. removes partial cache promotion and projects only exact certified cache
   semantics;
7. converts Pi responses through the strongest legal Anthropic representation,
   with JSON and SSE sharing one converted message;
8. preserves foreign opaque continuity only through the approved item-local
   `token_continuity` envelope;
9. keeps every change local to Anthropic Messages, apart from mechanical removal
   of Anthropic-only configuration keys from composition defaults and tests; and
10. proves behavior at the Client Wire, final Provider Wire, Client response, and
    next complete-history replay endpoints.

Semantic loss, privilege loss, and source timing changes are acceptable when an
exact conversion is unavailable and the result remains honest, legal, and useful.
They must be represented as `degraded` or `omitted`; they must never be reported as
exact application.

## 2. Authority and document synchronization

### 2.1 Authority order

After Slice 0 is complete, authority is:

1. `doc/Spec/TokenAnthropicSemanticConversionArchitectureSpec.md` — the sole
   Anthropic architecture and policy authority;
2. `doc/Protocols/Anthropic-Pi AI IR Conversion Method.md` — the concrete mapping
   method implementing that architecture;
3. `doc/AnthropicMessagesPiProviderSemanticAudit.md` — version-bound Pi and
   Provider evidence plus the enabled consumer matrix;
4. this plan — implementation order and verification gates.

`doc/Spec/TokenSemanticConversionArchitectureSpec.md` remains authoritative only
for cross-protocol locality. It does not decide Anthropic field dispositions.

Certification must verify behavior. A document title, marker string, content hash,
or synchronized heading is version identity evidence only; it is not proof of
conversion correctness.

### 2.2 Contradictions that must be removed before production edits

The current Anthropic documents still contain obsolete decisions. Slice 0 must
correct all of these together:

- message-level `role: "system"` is rejected or described as optional widening;
- unresolved ToolCall repair is configurable or prohibited;
- server-tool target unavailability is terminal;
- explicit `inference_geo` target unavailability is terminal;
- local cache `promote` is offered as a supported policy;
- unknown Pi response content may be configured to fail the whole response;
- missing ToolCall caller provenance or namespace always fails the whole response;
- refusal is described as supported while SSE rejects it;
- response conversion failures are defined before applying the strongest legal
  block-level representation;
- the architecture links to a nonexistent ADR as its policy authority.

No production behavior slice begins until the architecture, mapping document, and
semantic audit agree on the fixed decisions in Section 3.

## 3. Fixed decisions

These are implementation requirements, not configuration choices.

### 3.1 Demand-driven extraction

- The main Anthropic consumer and the Anthropic Supplement consumer are the only
  request-field authorities.
- A source field claimed by neither consumer remains unread. Its shape cannot
  reject the request.
- A consumer validates only the paths it reads. An unclaimed sibling cannot
  invalidate a claimed object.
- The Supplement consumer is the union of facts consumed or verified by at least
  one currently enabled Anthropic-source target Adapter.
- Target selection does not change the Supplement Interface. The selected Adapter
  consumes only its positive subset.
- Adding a Supplement member requires a declared source path, an enabled target
  consumer, and a Client Wire to final Provider Wire test.
- Removing the final target consumer removes the member. Dormant future fields are
  not retained.

### 3.2 Message-level `role: "system"` extension

Token formally supports `role: "system"` inside `messages[]` as an Anthropic
compatibility extension:

1. Preserve the existing top-level `system` text first.
2. Find the first message-level system message in source order.
3. Append all text blocks from that message, in block order, to `systemPrompt`.
4. Separate existing top-level system text and the promoted message text with one
   `\n`; do not trim either source string.
5. Convert non-text blocks from that first system message as ordinary user content
   at the source message position. They receive no system privilege.
6. Convert every later message-level system message entirely as ordinary user
   content.
7. Omit empty ordinary fragments rather than producing empty Pi messages.
8. Publish at most one request-local degradation notice per request.

The original message-level role is not carried in the Supplement because no
enabled target Adapter consumes it. The timing change caused by promoting the
first text is accepted.

### 3.3 Interrupted Client ToolCall repair

Repair is fixed and has no end-user switch:

- It applies only to unresolved ordinary Client/BYOT ToolCalls.
- It does not apply to Provider/server-tool calls or results.
- Preserve every real ToolResult.
- Before history crosses from pending calls into unrelated subsequent content,
  insert one synthetic ToolResult for every still-pending call in original call
  order.
- At end of history, append results for every remaining pending Client call.
- Each synthetic result uses the original ID and name, `isError=true`, and exactly:

  ```text
  No result — the tool call did not complete (interrupted or lost).
  ```

- Publish one bounded repair notice per synthetic result.
- Orphan result, result-before-call, duplicate result, duplicate call identity,
  empty ID, empty name, and ambiguous Client relationship still fail.
- A later real result for an already repaired call is a duplicate and fails; the
  repair must not mask inconsistent history.

This is an honest statement that execution did not complete, not a fabricated tool
answer.

### 3.4 Output-token ceiling

- `max_tokens` must be a positive integer.
- `max_tokens=0` fails immediately as an Anthropic invalid request before model
  resolution-dependent representability checks and before Provider dispatch.
- The Supplement retains an `outputTokenCeiling` verifier because Pi may add or
  clamp thinking budgets.
- The final Provider ceiling must never exceed the Client value.
- A certified context-safety reduction may lower it.
- A Provider minimum must not widen it.
- If a valid source thinking budget becomes incompatible with the final safe
  ceiling, use the existing named reasoning-disable degradation rather than
  widening the ceiling.

### 3.5 Server tools and `inference_geo`

Both are fixed candidate-only semantics:

- Retain only the typed fields needed by an enabled exact target Adapter.
- An Adapter with a certified exact mapping may project them.
- A target without that mapping leaves the candidates unconsumed.
- The Anthropic coordinator resolves them to `omitted + warning` and dispatches.
- Never reclassify a server tool as an ordinary Client tool.
- Never fabricate server execution, tool results, geography enforcement, or
  target capability.
- Preserve visible server-result text or other ordinary model-visible content when
  it has a legal Pi representation; omit only unsupported server-specific
  structure.

If all model-visible content is removed and neither Pi nor an Adapter can construct
a legal final request, the request may fail for final-payload invalidity. That is
not a server-tool or geography availability failure.

Client-tool IDs, Client tool-result relationships, and actual caller permissions
remain independently validated. Ignoring server-tool semantics does not weaken
ordinary Client tool integrity.

### 3.6 Cache control

Remove `localCacheControl: "ignore" | "promote"`.

- Preserve every currently consumed top-level, system-block, message-block, and
  tool-local cache marker as an attachment-specific Supplement candidate.
- Project a marker only when the selected Adapter has an exact certified target
  attachment point and TTL mapping.
- Otherwise centrally omit it with a warning.
- Do not convert a local breakpoint into request-wide Pi `cacheRetention`.
- Do not add a prompt instruction or other model-visible approximation.

Reintroducing promotion would require a new architecture decision, a target-aware
pre-Pi preparation Interface, mutual exclusion with exact projection, and final-wire
proof of the degraded request-wide retention. It is outside this plan.

### 3.7 Response conversion: strongest legal representation

For every Pi response fact use this order:

1. exact standard Anthropic representation;
2. the approved `token_continuity` extension for compatible foreign opaque replay;
3. visible block-level fallback;
4. legal omission, null, or target default;
5. whole-response failure only when no legal response envelope can be constructed
   or a non-degradable security/relationship contract would be falsified.

Specific fixed behavior:

- Ordinary text survives loss of citations or optional metadata.
- Foreign Provider thinking signatures never occupy Anthropic native signature
  fields as if they were Anthropic signatures.
- Missing ordinary thinking signature may use `signature: ""`, warn, and treat the
  empty value as absent during replay.
- Missing redacted opaque data never becomes an invented signature; use a visible
  fallback when available, otherwise omit that block and warn.
- A ToolCall with a valid ID, name, JSON-object input, and uniquely provable direct
  Client tool maps to `tool_use` with `caller: {type: "direct"}`.
- Namespace may be discarded only when the current request tool catalog uniquely
  resolves the qualified identity to one declared Client tool. The emitted name is
  that declared Client tool name.
- Missing caller provenance, ambiguous namespace, invalid tool identity, or
  malformed arguments omits that ToolCall block and all of its continuity
  attachments; it does not fail the whole response.
- Unknown or future Pi content is omitted with a warning.
- Optional citations, container, service tier, inference geography, server-tool
  usage, refusal detail, and usage breakdown loss cannot replace an otherwise legal
  response with HTTP 500.
- Recompute `stop_reason` after final block projection:
  - an authoritative committed refusal becomes `refusal`;
  - an authoritative length terminal becomes `max_tokens`;
  - otherwise any retained `tool_use` becomes `tool_use`;
  - otherwise use `end_turn`.
- A ToolCall omitted during conversion cannot leave `stop_reason=tool_use`.
- JSON and SSE consume the same fully converted `AnthropicResponseMessage`.
- SSE must accept and emit `stop_reason: "refusal"` wherever JSON does.
- Empty `content: []` is legal; no empty text block is fabricated.

### 3.8 Configuration after refactor

Anthropic configuration retains only request behavior that remains genuinely
configurable, currently `unknownContent` for a consumed content envelope with an
unknown discriminator.

Remove:

- `conversion.request.localCacheControl`;
- `conversion.response.unknownPiContent`;
- any unresolved ToolCall policy if encountered in obsolete fixtures or docs.

Old keys are rejected by the current closed-world configuration parser. Do not add
aliases, migrations, dual readers, or deprecated compatibility behavior.

## 4. Scope

### 4.1 Production files in scope

The semantic implementation scope is strictly:

```text
src/protocols/anthropic/**
```

Expected primary files:

```text
src/protocols/anthropic/configuration.ts
src/protocols/anthropic/request.ts
src/protocols/anthropic/representability.ts
src/protocols/anthropic/response.ts
src/protocols/anthropic/sse.ts
src/protocols/anthropic/wire.ts
src/protocols/anthropic/handler.ts
src/protocols/anthropic/semantic/invocation.ts
src/protocols/anthropic/semantic/execution.ts
src/protocols/anthropic/semantic/pi-execution.ts
src/protocols/anthropic/semantic/response.ts
src/protocols/anthropic/semantic/supplement/contract.ts
src/protocols/anthropic/semantic/supplement/candidates.ts
src/protocols/anthropic/semantic/supplement/validation.ts
src/protocols/anthropic/semantic/projection/contract.ts
src/protocols/anthropic/semantic/projection/request.ts
src/protocols/anthropic/semantic/projection/registry.ts
src/protocols/anthropic/semantic/projection/supplement-disposition.ts
src/protocols/anthropic/semantic/projection/adapters/*.ts
```

The plan may add a protocol-local Supplement builder or immutable JSON utility only
if it deepens the Anthropic Module. Such a utility remains Anthropic-owned unless a
separate future task proves identical mechanism in another protocol.

### 4.2 Mechanical composition files in scope

Only these non-Anthropic locations may change, and only to remove or update an
Anthropic configuration shape or Anthropic-only assertion:

```text
src/first-run-config.ts
test/unit/adapter-configuration.test.ts
test/unit/cli-config.test.ts
test/integration/* configuration fixtures containing anthropic-messages
test/certification/* Anthropic locality or protocol-behavior assertions
```

No OpenAI Responses value, default, type, parser, or behavior changes in these
files.

### 4.3 Documentation in scope

```text
doc/Spec/TokenAnthropicSemanticConversionArchitectureSpec.md
doc/Spec/TokenAnthropicSemanticConversionImplementationPlan.md
doc/Protocols/Anthropic-Pi AI IR Conversion Method.md
doc/AnthropicMessagesPiProviderSemanticAudit.md
```

### 4.4 Explicitly out of scope

- `src/protocols/openai-responses/**`;
- OpenAI Responses specifications, audits, projectors, fixtures, and online tests;
- Provider Native Preservation behavior;
- Direct Mode behavior;
- Pi AI or `node_modules` modifications;
- a shared Semantic Conversion Invocation, Supplement, outcome, error, registry, or
  executor;
- Provider credentials, transport, retry, cancellation, and diagnostics ownership;
- server-side continuity storage;
- response interception below Pi `AssistantMessage`;
- local Provider-response truncation;
- Codex CLI as evidence for the Anthropic Client protocol.

## 5. Test seams

Tests use the same three Interfaces as production callers. Internal helper shapes
are not the long-term test surface.

### Seam A — Anthropic Client Wire to conversion result

Interface:

```ts
validateAnthropicSourceRequest(...)
convertValidatedAnthropicRequestWithPolicy(...)
```

Observable evidence:

- Pi Context and options;
- Anthropic reasoning semantics;
- immutable Supplement candidates;
- render state;
- bounded conversion notices;
- Anthropic invalid-request failures.

### Seam B — Anthropic semantic execution to final Provider Wire

Interface:

```ts
executeAnthropicSemanticInvocation(...)
```

Use the existing injected `ExecutionOperation`/test transport to capture the final
Provider request after Pi and `onPayload`. Do not call private Adapter helpers as a
substitute for final-wire evidence.

Observable evidence:

- exact final Provider payload;
- exactly one projection outcome per Candidate ID;
- central omission of unconsumed candidates;
- no Provider dispatch after a terminal source or payload-shape failure;
- no failure for ordinary target unavailability.

### Seam C — Pi response to Anthropic JSON/SSE and replay

Interfaces:

```ts
convertAssistantMessageToAnthropicResponse(...)
createAnthropicAtomicSseEvents(...)
```

Observable evidence:

- one legal Anthropic message;
- JSON/SSE semantic equivalence;
- block-level omissions and notices;
- final stop reason;
- continuity envelope attachment;
- next complete-history final Provider request.

Selected Provider response to Pi parser fixtures remain dependency certification.
They are not a new runtime seam.

## 6. Target Supplement Interface

### 6.1 Design goals

`AnthropicProjectionSupplement` is a deep, protocol-local candidate carrier. Its
Interface must make these invariants mechanically visible:

- fixed union, not `kind: string`;
- one atomic semantic fact per Candidate ID;
- no raw Anthropic records;
- no Provider payload indexes or payload fragments;
- no reasoning or continuity state;
- no diagnostics, credentials, transport, or mutable lifecycle state;
- recursive JSON validation and immutability;
- enough source and Pi association for the consuming Adapter to resolve an exact
  target attachment;
- target-independent construction;
- central settlement of every candidate exactly once.

### 6.2 Core types

The implementation may refine names, but it must preserve this shape and these
invariants:

```ts
declare const anthropicCandidateIdBrand: unique symbol;

type AnthropicCandidateId = string & {
  readonly [anthropicCandidateIdBrand]: true;
};

type ReadonlyJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ReadonlyJsonValue[]
  | { readonly [key: string]: ReadonlyJsonValue };

type AnthropicSourceAttachment =
  | { readonly kind: "request"; readonly path: string }
  | { readonly kind: "system-block"; readonly blockIndex: number }
  | {
      readonly kind: "message-content";
      readonly messageIndex: number;
      readonly contentIndex: number;
    }
  | { readonly kind: "tool-definition"; readonly toolIndex: number };

type AnthropicPiAttachment =
  | {
      readonly kind: "message-content";
      readonly messageIndex: number;
      readonly contentIndex: number;
    }
  | { readonly kind: "tool-call"; readonly callId: string }
  | { readonly kind: "tool-result"; readonly callId: string }
  | { readonly kind: "tool-definition"; readonly toolName: string };

interface AnthropicCandidateBase {
  readonly id: AnthropicCandidateId;
  readonly source: AnthropicSourceAttachment;
  readonly piAttachment?: AnthropicPiAttachment;
}
```

`AnthropicPiAttachment` describes semantic association with the Pi input. It does
not describe a Provider array offset. Reasoning preparation must update attachment
indexes when it changes Pi history. An Adapter resolves the association against its
audited final payload shape and fails only for an incompatible selected-projector
shape; ambiguity in an optional candidate leaves it unconsumed for central
omission.

Do not introduce `piSpan`, `replacesPiSpan`, final-payload ordinal, or a Provider
JSON path into the Supplement.

### 6.3 Control candidates and writer roles

Controls are statically named and their final-writer roles are explicit:

```ts
interface AnthropicControlCandidates {
  readonly outputTokenCeiling: AnthropicCeilingVerificationCandidate;
  readonly temperature?: AnthropicPiVerificationCandidate<number>;
  readonly topP?: AnthropicPiFirstProjectionCandidate<number>;
  readonly topK?: AnthropicPiFirstProjectionCandidate<number>;
  readonly stopSequences?: AnthropicProjectionCandidate<readonly string[]>;
  readonly toolChoice?: AnthropicToolChoiceCandidate;
  readonly outputFormat?: AnthropicOutputFormatCandidate;
  readonly metadataUserId?: AnthropicPiFirstProjectionCandidate<string | null>;
  readonly serviceTier?: AnthropicProjectionCandidate<"auto" | "standard_only" | null>;
  readonly inferenceGeo?: AnthropicProjectionCandidate<string | null>;
  readonly container?: AnthropicProjectionCandidate<string | null>;
  readonly finalAssistantPrefill?: AnthropicProjectionCandidate<true>;
}
```

The concrete candidate types encode the policy:

- `PiVerificationCandidate`: observe only; never restore a value intentionally
  omitted by Pi;
- `CeilingVerificationCandidate`: verify or apply only a certified downward repair;
- `PiFirstProjectionCandidate`: accept exact Pi output, otherwise perform only a
  certified projection/repair;
- `ProjectionCandidate`: Adapter-owned exact projection or central omission;
- `ToolChoiceCandidate`: exact projection or its specifically named bounded
  fallback.

`temperature` remains Pi-owned. `outputTokenCeiling` is not a second ordinary
`maxTokens` writer.

### 6.4 Structured system, content, cache, and tool candidates

Use fixed discriminated unions derived from the enabled consumer matrix. The
initial union must cover only currently consumed families:

```text
System candidates
  structured-system-block
  system-cache-marker

Content candidates
  text-citations
  content-cache-marker
  url-image-source
  document-source
  document-metadata
  search-result
  client-tool-use-caller
  client-tool-use-cache-marker
  rich-client-tool-result
  tool-reference
  server-tool-use
  server-tool-result
  container-upload

Tool candidates
  custom-tool-cache-marker
  custom-tool-caller-policy
  custom-tool-deferred-loading
  custom-tool-input-streaming
  custom-tool-input-examples
  server-tool-definition
```

Each member contains only the exact typed fields consumed by a current Adapter.
Do not store a complete SDK block merely because one nested field is needed.
Arbitrary JSON is permitted only where the source semantic is itself arbitrary
JSON, such as a validated JSON Schema or ordinary tool input.

If one source block contains independently projectable facts, create multiple
Candidate IDs. For example, visible text remains Pi-owned while citations and a
cache marker are two separate candidates. This prevents partial outcomes.

`rich-client-tool-result` additionally records, for each retained nested source
block, whether that block emitted zero or one Pi ToolResult content item. This is
value-free association metadata, not a duplicate of Pi content. An exact
Anthropic replay consumes the associated Pi fallback item before restoring the
retained source block, so no Pi content is left orphaned.

### 6.5 Conversation layout

The exact Anthropic-target reconstruction Adapter may need source ordering, but
ordering metadata must not duplicate candidate values.

Use a value-free layout:

```ts
interface AnthropicConversationLayout {
  readonly messages: readonly {
    readonly sourceMessageIndex: number;
    readonly effectiveRole: "user" | "assistant";
    readonly entries: readonly (
      | {
          readonly kind: "source-content";
          readonly sourceContentIndex: number;
          readonly piAttachment?: AnthropicPiAttachment;
          readonly candidateIds: readonly AnthropicCandidateId[];
        }
      | {
          readonly kind: "synthetic-tool-result";
          readonly callId: string;
          readonly piAttachment: {
            readonly kind: "tool-result";
            readonly callId: string;
          };
          readonly candidateIds: readonly [];
        }
    )[];
  }[];
}
```

The layout records association and order only. Synthetic repair entries are
value-free associations with the actual Pi ToolResult; they do not duplicate its
honest error text. Candidate values exist once in the fixed candidate collections.
The target Adapter owns the version-bound resolver that maps this layout and
Pi-built content to its audited payload.

### 6.6 Top-level Supplement shape

```ts
interface AnthropicProjectionSupplement {
  readonly controls: AnthropicControlCandidates;
  readonly system: readonly AnthropicSystemCandidate[];
  readonly conversation: AnthropicConversationLayout;
  readonly content: readonly AnthropicContentCandidate[];
  readonly tools: readonly AnthropicToolCandidate[];
  readonly cache: readonly AnthropicCacheCandidate[];
}
```

The builder returns a recursively frozen snapshot. It must copy only validated
plain JSON values, reject cycles/accessors/symbol keys/non-finite values, and never
freeze a caller-owned raw object in place.

### 6.7 Candidate accounting

Change projection outcomes from free-form `control: string` to branded
`candidateId`:

```ts
interface AnthropicProjectionOutcome {
  readonly candidateId: AnthropicCandidateId;
  readonly outcome:
    | { readonly kind: "pi-native" }
    | { readonly kind: "payload-projected"; readonly projector: string; readonly repaired?: true }
    | { readonly kind: "degraded"; readonly warning: string }
    | { readonly kind: "omitted"; readonly warning: string };
}
```

The coordinator enforces:

- every emitted ID exists in the Supplement;
- an Adapter cannot emit an ID twice;
- two semantic owners cannot claim the same final Provider field;
- an Adapter emits outcomes only for candidates it consumed or verified;
- every remaining candidate receives one central `omitted` outcome;
- `degraded` is emitted only after the Adapter constructs or verifies the named
  fallback in the final Provider payload;
- a candidate cannot be both omitted and degraded;
- ordinary Supplement target unavailability cannot construct `failed`.

Reasoning outcomes remain Anthropic reasoning outcomes and do not enter the
Supplement candidate set. Request-conversion repair and system degradation notices
are conversion notices, not projection outcomes.

## 7. Target Adapter contract

Each target Adapter remains Anthropic-source-owned and positive-only.

Small Interface:

```ts
interface AnthropicTargetProjectionAdapter {
  project(input: {
    readonly payload: unknown;
    readonly model: Model<string>;
    readonly supplement: AnthropicProjectionSupplement;
    readonly reasoning: PreparedAnthropicReasoning;
  }): AnthropicPayloadProjectionResult | Promise<AnthropicPayloadProjectionResult>;
}
```

The Adapter implementation may:

- validate its exact pinned Pi payload shape;
- verify the candidates it declares;
- return a copied payload with certified exact mappings;
- perform an explicitly named bounded fallback;
- return outcomes for the IDs it consumed.

It must not:

- parse raw Anthropic Wire;
- inspect candidates it does not support merely to return “unsupported”;
- emit omission outcomes for other Adapters' candidates;
- mutate an unaudited payload shape;
- guess from Provider name, URL, or similar-looking field names;
- write a Pi-owned value a second time;
- make diagnostics part of dispatch correctness.

Registered implementations remain:

```text
commandcode-private
anthropic-messages
openai-completions
openai-responses / azure-openai-responses / openai-codex-responses
google-generative-ai / google-vertex
mistral-conversations
bedrock-converse-stream, with certified model-family splits
pi-messages
```

A target with no positive mapping has no no-op Adapter. Pi dispatches normally and
the coordinator omits every remaining candidate.

## 8. Implementation slices

Every slice is a vertical change. Do not create a compatibility Supplement or run
old and new projection contracts in parallel. A working branch may contain red
tests, but a completed slice must compile and pass its focused tests.

### Slice 0 — Synchronize authority and freeze behavioral fixtures

Documentation:

1. Update the Anthropic architecture fixed-decision and disposition sections.
2. Update the conversion method with the exact algorithms from Section 3.
3. Update the semantic audit request, content/tool, target, response, and failure
   matrices.
4. Remove the broken ADR reference or replace it with an existing real authority;
   do not create a second competing policy source.
5. Mark this plan as the only current Anthropic implementation plan.

Red behavioral fixtures:

- first and later message-level system roles;
- mixed text/non-text first system message;
- unresolved Client ToolCall at message transition and history end;
- orphan, duplicate, empty-ID, and late duplicate results;
- `max_tokens=0` ingress failure;
- unsupported server tool and `inference_geo` dispatch with omission;
- exact local cache marker projection and unsupported omission;
- missing ToolCall caller, namespace ambiguity, malformed arguments, and unknown Pi
  block response omission;
- refusal JSON/SSE parity;
- stop-reason recomputation after block omission;
- foreign thinking continuity and replay;
- unclaimed malformed fields remaining unread.

Gate:

- every fixed decision has a failing or already-green behavioral test at one of the
  three Interfaces in Section 5;
- documents no longer prescribe mutually exclusive behavior;
- no test claims correctness by checking headings or hashes alone.

### Slice 1 — Ingress validity and message-level system conversion

Production work:

1. Accept `user | assistant | system` only in the Anthropic compatibility parser.
2. Keep official role widening local; Pi still receives only legal Pi roles.
3. Implement the first-text promotion and user fallback algorithm exactly once in
   request conversion.
4. Ensure structured non-text system blocks pass through their normal content
   converters and Supplement candidate construction without privilege elevation.
5. Emit one bounded degradation notice.
6. Move positive `max_tokens` validation into source request validation and delete
   the model-aware zero check.

Focused tests:

```text
test/unit/anthropic-request-conversion.test.ts
test/unit/anthropic-request-doc-align.test.ts
test/unit/anthropic-main-call-validity.test.ts
test/integration/anthropic-ingress-order.test.ts
```

Gate:

- the Claude-generated request that previously failed with “messages require a
  user or assistant role” produces a valid Pi invocation;
- no `system` role reaches Pi history;
- `max_tokens=0` is an Anthropic invalid request before dispatch.

### Slice 2 — Fixed interrupted Client ToolCall repair

Production work:

1. Replace `pushRepairResults()` failure with deterministic synthesis for pending
   ordinary Client calls.
2. Track call kind so server-tool calls are never repaired.
3. Insert synthetic results at the earliest relationship-safe point.
4. Preserve actual results and the exact order of parallel pending calls.
5. Keep orphan/duplicate/identity validation unchanged or stronger.
6. Remove any obsolete repair configuration from docs, types, defaults, and tests.

Focused tests:

```text
test/unit/anthropic-request-conversion.test.ts
test/unit/tool-turns.test.ts
test/integration/anthropic-ingress-order.test.ts
test/integration/anthropic-semantic-final-payload.test.ts
```

Gate:

- an interrupted Claude history becomes usable with an honest error result;
- no invalid ToolCall/ToolResult relationship becomes accepted;
- final Provider history contains the repaired relationship in correct order.

### Slice 3 — Atomic typed Supplement migration

This is one coherent contract replacement across builder, registry, every registered
Adapter, coordinator, and tests. Do not merge a state where some Adapters consume
the old record bags and others consume the new union.

Production work:

1. Replace `kind: string`, `Record<string, unknown>`, duplicated `messageFrames`
   values, and string control names with Section 6 types.
2. Build candidates during the single demand-driven conversion operation.
3. Generate deterministic request-local Candidate IDs from candidate family and
   source attachment; reject duplicates.
4. Copy and recursively freeze validated JSON values.
5. Update reasoning preparation to preserve or remap Pi attachment associations.
6. Change projection outcomes and central settlement to Candidate IDs.
7. Migrate every registered Adapter in the same slice.
8. Delete the old contract and its tests; do not retain aliases or translators.

Adapter migration order inside the atomic slice:

1. `anthropic-messages` — typed exact structured reconstruction and attachment
   resolver;
2. `openai-completions` — ceiling, Pi-owned temperature verification, sampling,
   stop, tool choice, format, identity/tier, and prefill;
3. `openai-responses` family — separate API compatibility facts retained;
4. `google` — separate Generative AI and Vertex payload-shape certification;
5. `bedrock` — certified Claude/non-Claude model-family splits;
6. `mistral`;
7. `commandcode-private`;
8. `pi-messages`.

Focused tests:

```text
test/unit/anthropic-supplement-validation.test.ts
test/unit/anthropic-supplement-projection.test.ts
test/unit/anthropic-semantic-invocation.test.ts
test/unit/anthropic-pi-execution.test.ts
test/integration/anthropic-semantic-final-payload.test.ts
test/integration/pi-payload-shape-certification.test.ts
```

Required assertions:

- no raw source record survives in the Supplement;
- every nested array/object is frozen;
- source mutation after conversion cannot alter a candidate;
- each Candidate ID is unique and settled exactly once;
- unknown targets omit and dispatch;
- selected Adapter payload-shape drift fails before dispatch;
- removing an Adapter consumer makes the now-unused candidate fail the consumer
  matrix test until the candidate is removed.

Gate:

- repository search finds no old Supplement record bag, `messageFrames` value
  duplication, or string-based candidate accounting;
- all registered target final-wire fixtures pass on the new contract.

### Slice 4 — Server-tool, geography, and rich-content availability

Production work:

1. Remove server-tool and `inference_geo` hard gates from
   `representability.ts`.
2. Preserve their fixed typed candidates only when a current Adapter consumes the
   exact fields.
3. Let positive Adapters project exact native representations.
4. Let the coordinator omit them on all other targets.
5. Preserve ordinary visible content from rich results when Pi can legally carry
   it; omit server-specific lifecycle fields.
6. Keep final-payload minimum validity, ordinary media capability checks, and Client
   tool relationships separate.

Focused tests:

```text
test/unit/anthropic-main-call-validity.test.ts
test/unit/model-aware-validity.test.ts
test/unit/anthropic-supplement-projection.test.ts
test/integration/anthropic-semantic-final-payload.test.ts
```

Gate:

- unsupported server tools and geography reach Provider dispatch with omitted
  outcomes and warnings;
- no target receives a fabricated ordinary client tool or geography field;
- exact Anthropic-target reconstruction remains exact where certified.

### Slice 5 — Exact-only cache projection and configuration cleanup

Production work:

1. Remove `localCacheControl` from Anthropic configuration and request-conversion
   policy.
2. Delete request-wide promotion to Pi `cacheRetention`.
3. Enumerate all currently consumed marker attachment points.
4. Project exact markers only in positive target Adapters.
5. Centrally omit every other marker.
6. Remove `unknownPiContent` from Anthropic response configuration and make unknown
   Pi content fixed block-level omission.
7. Update first-run defaults and all configuration fixtures mechanically.

Focused tests:

```text
test/unit/adapter-configuration.test.ts
test/unit/cli-config.test.ts
test/unit/anthropic-request-conversion.test.ts
test/unit/anthropic-supplement-projection.test.ts
test/integration/configured-composition.test.ts
```

Gate:

- old keys are rejected rather than silently accepted;
- OpenAI Responses configuration snapshots are byte-for-byte/structurally
  unchanged in their focused tests;
- no local marker can set request-wide cache retention.

### Slice 6 — Strongest-legal response conversion

Production work:

1. Convert each Pi content block independently into retained or omitted output.
2. Replace whole-response ToolCall failures with deterministic direct-tool proof or
   block omission.
3. Resolve namespace only through the request-local Client tool catalog.
4. Remove continuity attachments whenever the owning block is omitted.
5. Convert unknown/future Pi blocks to fixed omission with warning.
6. Apply optional-auxiliary null/default/omission behavior.
7. Recompute stop reason from the final retained blocks and authoritative terminal
   fact.
8. Ensure refusal is legal in the common response message and SSE validator.
9. Keep JSON and SSE downstream of the same conversion result.

Focused tests:

```text
test/unit/anthropic-response-projection.test.ts
test/unit/anthropic-response-interpretation.test.ts
test/unit/anthropic-response-continuity.test.ts
test/unit/anthropic-response.test.ts
test/unit/anthropic-sse.test.ts
test/unit/anthropic-wire.test.ts
test/integration/anthropic-atomic-sse.test.ts
test/integration/anthropic-continuity-roundtrip.test.ts
```

Required paired JSON/SSE cases:

- refusal with unavailable optional details;
- caller inferred uniquely;
- caller unavailable and ToolCall omitted;
- redundant namespace discarded;
- ambiguous namespace omitted;
- malformed tool arguments omitted;
- unknown Pi content omitted;
- omitted final ToolCall changes stop reason to `end_turn`;
- retained ToolCall produces `tool_use`;
- length remains `max_tokens`;
- empty legal content;
- native and foreign thinking continuity.

Gate:

- JSON and reconstructed SSE messages are semantically equal for every case;
- no optional response auxiliary produces HTTP 500;
- no omitted block leaves orphan continuity or a false tool terminal.

### Slice 7 — Replay and response-parser certification

Production and test work:

1. Retain actual Provider/API/model provenance from Pi `AssistantMessage`.
2. Keep standard Anthropic native signature/redacted fields native only under
   certified compatible provenance.
3. Keep foreign opaque values exclusively in `token_continuity` v1.
4. Restore the value to its original thinking/text/tool-call attachment only on a
   compatible next target.
5. On mismatch, discard opaque state and retain the strongest portable visible
   meaning.
6. Treat empty synthetic signature as absent during next-request replay.
7. Update pinned Provider-response parser fixtures only when Pi actually exposes a
   fact; do not introduce raw response interception.

Focused tests:

```text
test/unit/anthropic-continuity-codec.test.ts
test/unit/anthropic-response-continuity.test.ts
test/integration/anthropic-continuity-roundtrip.test.ts
test/integration/anthropic-response-parser-certification*.test.ts
```

Gate:

- every certified compatible response-to-history round trip restores final
  Provider attachment, value, and provenance;
- model/API switch drops opaque state while keeping visible meaning;
- malformed envelopes remain fail-open and bounded.

### Slice 8 — Anthropic locality and behavioral certification

1. Update Anthropic dependency tests to prohibit imports from OpenAI Responses
   semantic modules and shared semantic kernels.
2. Replace title/hash-only protocol synchronization assertions with behavioral
   certification or explicit version-identity-only naming.
3. Prove diagnostics disabled, throwing, and saturated states do not change final
   request or response.
4. Run guarded unit, integration, certification, type, lint, and complete suites.
5. Confirm `git diff` contains no OpenAI Responses semantic change.

Gate:

- Anthropic can be added or removed without editing another Client Protocol Module;
- Provider Native and Direct Mode lane tests remain unchanged and green;
- every plan requirement has direct evidence rather than absence-of-failure.

### Slice 9 — Independent online and real-client certification

Run the existing independent Anthropic scripts:

```text
npm run test:online-anthropic:private
npm run test:online-anthropic:goat
npm run test:online-anthropic:opencode-go
```

Each script must assert:

- Anthropic Client request;
- captured final Provider request;
- returned Anthropic JSON or SSE;
- at least one complete-history replay case supported by that target;
- fixed omission/fallback behavior for unsupported candidates;
- no diagnostics side channel as correctness oracle.

Then run Claude Code/Claude CLI through the guarded existing real-client entry point,
with primary attention to:

```text
opencode-go/deepseek-v4-flash
```

The real-client test must prove that a request containing message-level
`role: "system"` no longer returns the previous 400 error. It must also exercise one
interrupted tool history if the client can produce or replay that history.

Codex CLI is not used because it cannot certify Anthropic Messages Client behavior.

Online credentials, API keys, real Codex state, and user profiles are never copied
into fixtures or output. Every script runs under the repository's temporary
`CODEX_HOME` guard.

Gate:

- the three direct-protocol scripts pass independently;
- Claude Code/Claude CLI has a separate pass/fail report;
- captured requests contain no secrets and are retained only according to the
  existing bounded test policy.

## 9. Test command order

Use guarded commands only:

```text
npm run test:unit
npm run test:integration
npm run test:certification
npm run typecheck
npm run lint
npm test
```

During a slice, a direct Vitest command is allowed only through the same repository
temporary-`CODEX_HOME` guard. Tests must not write to the user's real Codex state.

Online execution comes last and is not a substitute for deterministic final-wire
tests.

## 10. Required implementation order and rollback points

The intended merge order is:

```text
0. authority + red fixtures
1. system role + max_tokens ingress
2. interrupted Client ToolCall repair
3. atomic Supplement migration
4. server-tool / inference_geo availability
5. cache and configuration cleanup
6. strongest-legal response + refusal parity
7. continuity replay certification
8. locality and complete deterministic verification
9. online and Claude real-client verification
```

Rollback is by whole completed slice. Do not restore an obsolete configuration key
or old Supplement translator to make a partial migration pass. If Slice 3 cannot be
completed atomically, keep the branch before Slice 3 and split the implementation
work internally without merging a dual-contract state.

## 11. Completion evidence matrix

| Requirement | Required evidence |
|---|---|
| message-level system extension | Client Wire conversion tests plus Claude real-client run |
| honest interrupted ToolCall repair | conversion and final Provider history tests |
| invalid `max_tokens=0` | ingress invalid-request test proving no dispatch |
| fixed typed Supplement | compile-time fixed union, immutability tests, no raw record search |
| fixed Provider union | consumer matrix plus at least one final-wire test per enabled mapping |
| server-tool omission | unsupported-target final-wire dispatch and omitted outcome |
| `inference_geo` omission | unsupported-target final-wire dispatch and omitted outcome |
| exact-only cache | exact target fixture, unsupported omission fixture, no promotion search |
| strongest legal response | block-level fallback tests and no optional-auxiliary 500 |
| ToolCall caller/namespace handling | unique/default and ambiguous/omitted response cases |
| refusal JSON/SSE parity | paired JSON and reconstructed SSE equality test |
| foreign continuity | response → Client history → next final Provider replay test |
| no config half-policy | closed-world rejection of removed keys |
| Anthropic locality | dependency certification and diff audit |
| no Native lane regression | existing Native preservation suites |
| online Provider behavior | three independently runnable reports |
| real Claude behavior | separate Claude Code/CLI report for the original failure |

## 12. Definition of done

The refactor is complete only when all of the following are true:

1. The Anthropic architecture, mapping document, audit, implementation, and tests
   contain one consistent decision for every item in Section 3.
2. The external Anthropic request, execution, and response Interfaces remain small;
   projection complexity stays behind protocol-local internal seams.
3. Message-level system input is usable under the fixed privilege-degradation
   algorithm.
4. Interrupted Client ToolCalls receive the fixed honest repair while orphan,
   duplicate, empty-ID, and ambiguous relationships still fail.
5. `max_tokens=0` fails at Client ingress.
6. The old broad Supplement and string control accounting no longer exist.
7. Every Supplement member belongs to the fixed current Provider-consumer union,
   is recursively immutable, and is settled exactly once.
8. No target Adapter imports another Client Protocol, guesses a mapping, or owns
   central omission.
9. Unsupported server tools, `inference_geo`, local cache markers, and other
   candidate-only semantics omit honestly without blocking an otherwise valid
   request.
10. Response conversion uses the strongest legal block-level representation,
    recomputes stop reason, and keeps refusal behavior identical in JSON and SSE.
11. Compatible opaque continuity restores the exact next-request attachment and
    incompatible opaque state is discarded without losing portable visible meaning.
12. Removed configuration fields have no aliases, shims, or dual behavior.
13. All deterministic guarded test commands pass.
14. All three direct Anthropic online scripts pass independently.
15. Claude Code/Claude CLI separately proves the original OpenCode GO system-role
    failure is resolved.
16. OpenAI Responses, Direct Mode, and Provider Native Preservation remain behaviorally
    unchanged.
