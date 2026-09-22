# LuckyToken Pi AI 0.86.1 Boundary Convergence Refactoring Plan

Status: **SUPERSEDED HISTORICAL PLAN — implemented/certified for 0.86.1, replaced by the clean upstream Pi 0.87.0 boundary on 2026-09-22**

Date: **2026-09-21**

The projector deletion, Provider ownership, and central Pi Context compatibility seam remain current. The 0.86.1 `patch-package` common-option extensions and hard-output-ceiling rules recorded below are historical and are not part of the current 0.87.0 runtime.

Pinned dependency:

```text
@earendil-works/pi-ai = 0.86.1
```

Scope: Semantic Conversion only. Direct Mode and Provider Native Preservation remain
independent data-plane lanes.

## 1. Final decisions

1. OpenAI Responses and Anthropic Messages Provider-payload projectors are deleted.
2. Their projection Supplements, target registries, payload outcomes, payload repair
   callbacks, semantic `pi-execution.ts` wrappers, and projector-only tests are deleted.
3. Client Protocol conversion preserves every stable neutral fact that the Pi public
   contract can express. It does not decide whether a selected Provider supports it.
4. After protocol-specific semantic preparation, one model-resolved Pi Context
   compatibility execution seam runs exactly once before Profile credential attempts.
   For mid-conversation `SystemMessage`, verified support is identity-preserving;
   unsupported pure-text messages degrade to `UserMessage`. If such a message lies
   inside a pending tool exchange, degradation is delayed until the minimum observed
   call/result set needed for that relocation closes. That relocation is a bounded,
   explicitly warned availability degradation, not an exact conversion. Prompt/tool-state
   patch messages fail before dispatch.
5. Pi `Models` owns Provider resolution, authentication application, `Context`
   normalization, and dispatch.
6. A Pi Provider/API adapter owns all Provider-native request construction and every
   remaining Provider capability application, degradation, or omission.
7. Optional controls that a Provider cannot implement may be ignored by that Provider.
   Invalid tool relationships, lost model-visible content, and security, permission, or
   residency violations still fail explicitly.
8. Client Protocol production modules create no `onPayload` callback and remain correct
   without one. Neutral Core execution may install a diagnostics-owned, non-mutating
   observation callback.
9. CommandCode Private and CommandCode Goat expose only their versioned
   `providerPackage` registration contract from the package root. Concrete factories
   remain internal. Runtime invocation occurs only through Pi `Models`.

The ownership rule is:

> Client Protocol owns Client semantics. Pi common Context/options preserve portable
> intent. LuckyToken Pi Context compatibility repairs the narrow set of model-dependent
> Pi IR cases where Pi's generic fallback would change semantic timing. The selected Pi
> Provider owns Provider Wire and all remaining Provider capability mapping.

## 2. Final architecture

```text
Client Wire
    ↓
Client Protocol request conversion
    ↓
Pi Context + ModelsSimpleStreamOptions + Client render/continuity state
    ↓
protocol-specific reasoning / continuity preparation
    ↓
Pi Context compatibility execution
    ↓
Profile credential binding / retry
    ↓
raw Pi execution
    ↓
Pi Models
    ↓ normalizeContext()
TranscriptContext
    ↓
registered Pi Provider/API adapter
    ↓
Provider Wire
```

The reverse path is:

```text
Provider Wire
    ↓
registered Pi Provider/API adapter
    ↓
Pi AssistantMessage
    ↓
Client Protocol response conversion
    ↓
Client Wire
```

The removed architecture was:

```text
Client Protocol
→ inspect Pi-built Provider payload
→ validate or repair Provider payload
→ Provider
```

## 3. Implemented Pi common contract

The pinned Pi package is carried by one reproducible `patch-package` patch until the
same public contract is available in an accepted release.

### 3.1 Reasoning

```text
reasoning omitted → Provider/model default
reasoning "off"  → explicit disable
reasoning level  → enabled level
```

`Model.thinkingLevelMap` is the level-data authority. Pi public
`getSupportedThinkingLevels()` and `clampThinkingLevel()` own level selection.
Provider-native reasoning fields are emitted only by the selected Provider adapter.

### 3.2 Tool controls

```ts
type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { readonly type: "tool"; readonly name: string };
```

`parallelToolCalls?: boolean` independently preserves parallel-call intent.

OpenAI Responses and Anthropic Messages map Client grammar into these Pi facts and
retain the neutral tool catalog even when tool use is disabled. Pi built-in adapters
map them into Anthropic, OpenAI, Azure, Codex, Google, Bedrock, Mistral, or Pi Messages
wire shapes.

CommandCode Private has no native required/named/serial control. It keeps the tool
catalog, omits those unsupported controls inside the Provider, and emits bounded
Provider-owned notices. Explicit `none` is supported by sending an empty current tool
catalog. No Client Protocol contains a CommandCode-specific branch.

### 3.3 Output ceiling

Pi common `maxTokens` is a hard total Provider output ceiling. Pi adapters do not widen
it to satisfy a Provider minimum or reasoning budget. An impossible minimum fails
before dispatch.

## 4. Registered Provider boundary

### 4.1 CommandCode Private

```text
TranscriptContext
    ↓ collapseSystemMessages()
collapsed transcript
    ↓
getCurrentSystemPrompt(messages)
getCurrentTools(messages)
withoutInitialSystemMessage(messages)
    ↓
CommandCode messages/tools/reasoning/options
    ↓
validated CommandCode request
```

The Provider owns validation, transport, retry, SSE parsing, Pi response generation,
reasoning capability, session authority, and tool-call/result relationships. It imports
no OpenAI Responses or Anthropic source type.

### 4.2 CommandCode Goat

Goat is a registered Pi Provider that binds identity, catalog, auth, base URL, host
transport, and neutral diagnostics around Pi's built-in `openai-completions` adapter.
It contains no Client Protocol mapping and is not invoked directly by production
Semantic Conversion.

### 4.3 Visibility

Both Provider package roots export only:

```ts
providerPackage: TokenProviderPackage
```

Only composition loads that registration contract and adds the Provider to Pi
`Models`. Client Protocol modules receive a `Models` capability, never a concrete
Provider or factory. White-box Provider tests may deep-import internal source modules.

## 5. Former Supplement disposition

The old Supplements are deleted rather than renamed or retained as dormant bags.

| Fact family | Final owner/disposition |
| --- | --- |
| messages, system instructions, tools, calls/results | Pi `Context` |
| reasoning request | Pi common reasoning option |
| reasoning/history continuity | Pi content plus protocol-owned continuity state |
| maximum output, temperature, cache retention | Pi common options |
| auto/none/required/named tool choice | Pi common tool-choice option |
| parallel tool calls | Pi common parallel-call option |
| Responses allowed-tools subset | filtered Pi tool catalog plus common mode |
| hosted tools/choice | omit with bounded Client warning when no neutral Pi representation exists |
| optional private controls | omit with bounded warning or require Native Preservation |
| structured output, stop sequences, `topP`, `topK` not in the pinned common contract | omit with bounded warning; never hide in a generic bag |
| tool IDs/names/relationships, visible content, privileges, permissions, required structure | preserve or fail before dispatch |

No raw Client body, Provider payload, credentials, or mutable lifecycle object is
carried through Pi semantic state.

## 6. `onPayload`

Pi retains its callback for Provider tests, wire capture, bounded diagnostics, and
explicit low-level observation. Production Client Protocol code does not create,
mutate, or depend on it. Test capture is observation, never a semantic write path.

## 7. Deleted implementation

The following obsolete production families are removed for both Client Protocols:

- `semantic/projection/**`;
- `semantic/supplement/**`;
- semantic `pi-execution.ts`;
- target-API registries and source-protocol × target-API matrices;
- Provider-payload reasoning repair;
- projection outcomes, candidate carriers, validation helpers, and projector-only
  final-wire fixtures.

The architecture guard fails if these directories or dependencies return.

## 8. Test boundaries

```text
Client tests:
Client Wire → Pi Context/options + Client render/continuity state

Provider tests:
TranscriptContext + Pi options → Provider request → Pi AssistantMessage

Continuity tests:
Provider response → Pi AssistantMessage → Client response
→ next complete-history Client request → Pi Context → Pi Provider request
```

Pi adapter certification uses `onPayload` only as a capture seam. It proves rich tool
control mapping for Anthropic, OpenAI Completions, OpenAI Responses, Azure OpenAI
Responses, OpenAI Codex Responses, Google Generative AI, Google Vertex, Bedrock,
Mistral, and Pi Messages.

## 9. Verification record

Guarded offline verification completed on 2026-09-21:

- typecheck: passed for root and all workspaces;
- unit: 140 files, 1666 tests passed;
- integration: 119 files, 573 tests passed;
- architecture/certification: 69 tests passed;
- distribution: install/resolve certification passed, Desktop 20 files/110 tests
  passed, packaged product E2E 7 tests passed;
- lint and root/Desktop build: passed;
- clean Pi patch application: passed against a fresh 0.86.1 install; all 32 API
  adapter JavaScript files passed syntax validation.

Online verification using `CommandcodeAPIKey.txt`:

- Claude CLI → Anthropic Messages → Pi Models → CommandCode Private: 18/18;
- Codex CLI → OpenAI Responses → Pi Models → CommandCode Private: 21/21;
- CommandCode Private Anthropic protocol certification: 8/8;
- CommandCode Private Responses protocol certification: 50 completed requests,
  including 35 JSON, 14 SSE, and one complete-history reasoning replay; one transient
  upstream 502 was recorded and recovered;
- direct Pi IR ↔ CommandCode Private probe: 23/23.

CommandCode Goat online execution is excluded at the user's direction because the key's
plan does not include Goat API access. Goat registration, Pi adapter use, catalog,
auth, transport, reasoning, response, and distribution behavior remain covered offline.

## 10. Token 1.0.3 release record

The root and every shipped workspace now report version `1.0.3`. The release gate was
also corrected so its assembled-Backend certification always rebuilds root output and
cannot accidentally certify a stale version.

An unsigned Windows Squirrel candidate was built once and certified from the working
tree after the version bump:

```text
artifacts/release-candidates/1.0.3-dced5d0fdfb5/Token-Setup.exe
SHA-256: a69016314890bf386313d448ceac86d9a31eb23e5e164647ee4bbae91fda2083
```

Its release gates passed:

- production dependency audit: zero vulnerabilities;
- release certification: 69/69;
- root Vitest: 259 files, 2239/2239;
- Desktop tests: 20 files, 110/110;
- distribution install/resolve: 1/1;
- packaged product E2E: 7/7.

The manifest truthfully records `promotable: false`: the candidate was built from an
uncommitted working tree and no Authenticode certificate is configured locally or in
the repository's GitHub Actions secrets. It is a certified installable candidate, not
an official signed release.

## 11. Definition of Done

1. Every direct workspace dependency pins Pi AI exactly to 0.86.1.
2. Custom Provider streams consume `TranscriptContext`.
3. Client converters produce public `Context`, never `TranscriptContext`.
4. Registered custom Providers are hidden behind Pi `Models` at runtime.
5. Client Protocols preserve portable Pi semantics without inspecting Provider
   capability.
6. The shared Pi Context compatibility seam reads only resolved Pi Model capability and
   may repair only Pi IR itself; it never reads or writes Provider Wire. It is composed
   once outside Client Protocols and outside the Profile retry loop.
7. Supported mid-system Context is returned by identity. Unsupported pure-text
   mid-system messages degrade in place when no tool exchange is pending; when relocation
   is necessary, compatibility validates only the minimum tool-exchange conditions needed
   for that move, places the degraded user message after the completed exchange, and emits
   a warning. It does not validate the whole tool history. Complex prompt/tool-state
   patches fail.
8. Provider adapters own Provider Wire and all remaining capability mapping.
9. Projector and Supplement production trees are absent.
10. Client Protocol semantic modules create no `onPayload` callback; optional Neutral
   Core diagnostics observation is non-mutating and semantically removable.
11. Reasoning default/off/level and tool auto/none/required/named/parallel intent are
   unambiguous in the common contract.
12. Provider-private facts do not enter Pi IR or generic escape-hatch bags.
13. Critical content, relationship, permission, and request-validity facts never
    disappear silently.
14. Client, Provider, response, continuity, architecture, distribution, and available
    online suites pass under guarded isolation.
