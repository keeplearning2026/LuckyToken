# Token Reasoning Effort Unification Implementation Plan

Status: **PLANNED — NOT STARTED**

Date: **2026-08-24**

Scope: make the resolved model's `thinkingLevelMap` the level-data authority and pinned Pi's public thinking-level functions the mechanical selection authority. Reasoning-effort handling is availability-first: unsupported strength or capability is repaired, omitted, or degraded into a valid ordinary request rather than rejected. OpenAI Responses and Anthropic Messages retain separate protocol-owned plans, projection outcomes, failures, and target Adapters. CommandCode Private retains its API identity and private transport.

## 1. Outcome

The completed change has two shared authorities, and no new Token-wide effort module:

1. A resolved Pi `Model` owns its level data in `thinkingLevelMap`. Both CommandCode providers are projected from the same CommandCode model facts.
2. Pinned Pi owns nearest-level mechanics through `getSupportedThinkingLevels()` and `clampThinkingLevel()`.

Each Client Protocol owns the rest:

```text
Responses Client intent
→ Responses-owned structural effort plan
→ Pi options
→ Responses target Adapter verifies/repairs final Provider Wire
→ one Responses effort outcome

Anthropic Client intent
→ Anthropic-owned structural effort plan
→ Pi options
→ Anthropic target Adapter verifies/repairs final Provider Wire
→ one Anthropic effort outcome

Shared data: CommandCode model facts → thinkingLevelMap
Shared dependency: pinned Pi public level-selection behavior
Not shared: intent type, prepared plan type, target semantics, outcome, failure, wire shape
```

Completion means:

- no Token implementation reimplements upward-then-downward nearest-level selection;
- no request converter writes an unresolved client effort directly as the authoritative Pi effort;
- every target Adapter records the effort outcome only after inspecting the final Provider payload;
- reasoning-effort unavailability alone never prevents dispatch of an otherwise valid request;
- Codex routed catalog injection projects real model capability through Pi keys into exactly five Codex reasoning slots rather than advertising Provider wire values;
- CommandCode GOAT and Private read the same explicit model level table while keeping their distinct API, transport, and response provenance.

### 1.1 Non-negotiable final-wire invariants

These invariants apply to every Client Protocol and target Adapter. They are asserted against the final Provider request after Pi serialization and projection, not against intermediate intent, plan, or options.

#### I1. Reasoning model with selectable levels

Every emitted graded reasoning control must be certified for the resolved model. For string-valued transports, the final value must correspond to a supported key's authoritative `thinkingLevelMap` mapping. For structured transports, the target Adapter must certify the selected key's exact Provider-native representation.

When the requested level is unavailable, Pi selects the nearest supported key. The Adapter emits that legal representation, records a named `degraded` outcome, and dispatches. When no certified graded representation can be constructed, the Adapter removes the graded control, applies its certified binary-enable or Provider-default fallback, records `degraded`, and dispatches.

#### I2. Reasoning model with no selectable level

The final Provider request contains no graded reasoning control. This includes direct effort strings and indirect strength controls such as thinking budgets, token budgets used as effort, or graded prompt modes. A certified binary reasoning-enable field may remain because it expresses reasoning without claiming a strength. If the target has no certified binary representation, the Adapter uses Provider default, records `degraded` when the Client requested a level, and dispatches.

#### I3. Non-reasoning model

The final Provider request contains no graded reasoning control, thinking budget, or reasoning-enabling field. A target-required explicit disabled marker may remain because it truthfully expresses that reasoning is off. When the Client requested reasoning, the Adapter removes the unsupported controls, records ordinary-generation `degraded`, and dispatches the otherwise valid request.

#### Availability rule

An unsupported requested level, a model with no selectable level, a non-reasoning model, or a missing certified effort mapping is not by itself a failure condition. The Adapter produces the strongest valid request allowed by I1-I3 and dispatches it. A request may still fail for an independent existing reason such as an incompatible audited payload shape, duplicate final-field ownership, invalid final Provider request construction, malformed consumed input, or a security/permission constraint. Never send an illegal level or fabricated reasoning capability merely to avoid failure.

### 1.2 Codex five-slot catalog projection

Codex catalog injection is a Client capability projection, not Provider request projection. It follows one direction only:

```text
real Provider-supported strengths
→ resolved Model.thinkingLevelMap
→ Pi supported keys from getSupportedThinkingLevels(model)
→ Codex routed supported_reasoning_levels
```

Token routed rows expose exactly five Codex slots. The JSON `effort` field uses the lowercase Codex key; Light, Medium, High, Extra high, and Ultra are the corresponding user-facing slots.

| Pi enabled key | Codex injected key | Codex slot |
| -------------- | ------------------ | ---------- |
| `minimal`      | `low`              | Light      |
| `low`          | `low`              | Light      |
| `medium`       | `medium`           | Medium     |
| `high`         | `high`             | High       |
| `xhigh`        | `xhigh`            | Extra high |
| `max`          | `max`              | Ultra      |

Projection rules:

1. Start only from `getSupportedThinkingLevels(model)` minus `off`; never inspect or inject Provider wire strings directly.
2. Map each supported Pi key through the table above, preserve Pi order, and deduplicate the Codex keys. When both `minimal` and `low` are supported, Codex advertises one `low` slot.
3. A `minimal`-only model advertises Codex `low`. If Codex later requests `low`, the protocol-owned runtime plan clamps it back to the model's supported Pi `minimal`, records `degraded`, and emits the certified Provider representation.
4. A reasoning model with no selectable Pi key and a non-reasoning model both inject `supported_reasoning_levels: []`.
5. Routed rows never inject `minimal`, `off`, or `ultra` as Codex effort keys. Responses input may still normalize the separate Token `ultra` alias to Pi `max`; that alias is not a sixth routed Codex slot.
6. Intersect the five projected keys with the exact installed Codex parser vocabulary and attach descriptions accepted by that runtime. A missing installed key is omitted with a generation warning rather than invented.
7. Codex projection does not alter `thinkingLevelMap`; Provider projection still maps the later Pi-selected key to final Provider Wire under I1-I3.

## 2. Authority

1. [Repository instructions](../../AGENTS.md)
2. [OpenAI Responses Semantic Conversion Architecture Specification](./TokenOpenAIResponsesSemanticConversionArchitectureSpec.md)
3. [Anthropic Semantic Conversion Architecture Specification](./TokenAnthropicSemanticConversionArchitectureSpec.md)
4. [Semantic Conversion Architecture Specification](./TokenSemanticConversionArchitectureSpec.md)
5. [Codex Model Catalog Specification](./TokenCodexModelCatalogSpec.md)
6. pinned Pi AI source, the exact installed Codex runtime, and existing final-wire certification tests

If this plan conflicts with a protocol architecture specification, the specification wins and this plan must be corrected before implementation continues.

## 3. Confirmed current behavior

### 3.1 Pi model-state classification

Classify a resolved model through Pi's public interface, not by scanning for string values:

```ts
const enabledLevels = getSupportedThinkingLevels(model).filter(
  (level) => level !== "off",
);
```

| State               | Condition                                                   | Meaning                                            |
| ------------------- | ----------------------------------------------------------- | -------------------------------------------------- |
| selectable          | `model.reasoning === true` and `enabledLevels.length > 0`   | Pi exposes at least one selectable non-`off` level |
| no-selectable-level | `model.reasoning === true` and `enabledLevels.length === 0` | Pi exposes no selectable non-`off` level           |
| non-reasoning       | `model.reasoning === false`                                 | Pi exposes only `off`                              |

This distinction matters for partial or absent maps. In the pinned Pi version, `null` excludes a level; absent `minimal`/`low`/`medium`/`high` entries retain Pi defaults; absent `xhigh`/`max` entries do not. A raw `string`/`null` scan therefore does not reproduce Pi behavior.

### 3.2 Responses client intent

| Client request                                     | Normalized Responses intent                                           |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| `reasoning` absent or `{}`                         | `provider-default`                                                    |
| `reasoning: { effort: "none" }`                    | `disabled`                                                            |
| `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | `enabled(level)`                                                      |
| `ultra`                                            | `enabled(max)` plus normalization notice                              |
| unknown string                                     | configured normalization policy; current default is `max` plus notice |

Normalization is model-independent. It does not select a supported model level.

### 3.3 Verified change drivers

| #   | Current behavior                                                                                                                                                                                | Evidence                                                                                                       | Required correction                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| P1  | Responses projection has a local `THINKING_LEVELS` order and `clampedEnabledLevel()` implementation in addition to Pi's `clampThinkingLevel()`                                                  | `src/protocols/openai-responses/semantic/reasoning/adapters/payload.ts`; pinned Pi `models.ts`                 | remove the local selector and consume a protocol-owned plan selected through Pi            |
| P2  | Responses and Anthropic request conversion write the normalized client level into Pi options before a resolved `Model` is available; later projection compares or recomputes effective behavior | `src/protocols/openai-responses/request.ts`; `src/protocols/anthropic/request.ts`; protocol reasoning Adapters | keep conversion model-independent and select after model resolution                        |
| P3  | CommandCode Private calls Pi's clamp but then applies a second hardcoded key-to-wire fallback (`minimal`/`low` → `low`)                                                                         | `packages/provider-commandcode-private/src/provider.ts`                                                        | map the Pi-selected key strictly through the explicit CommandCode table                    |
| P4  | CommandCode source facts store `reasoningEfforts`; `projectThinkingLevels()` deterministically derives the full Pi table                                                                        | `packages/commandcode-model-catalog/src/models.ts`; `projection.ts`                                            | make the explicit table the sole source representation without changing projected behavior |
| P5  | GOAT endpoint/serializer compatibility is not a pure CommandCode model capability and is currently resolved outside the shared facts                                                            | GOAT model projection and protocol target Adapters                                                             | certify it at the GOAT projection layer, not in shared facts                               |

P4 is a representation and auditability change, not evidence that two conflicting CommandCode tables currently exist. The current `reasoningEfforts` list is the single source and its projection must be frozen before migration.

### 3.4 Fixed constraints, not defects

| Constraint                                                                                     | Required treatment                                                                                                 |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `commandcode-private` is a real custom API identity                                            | keep the API ID; registries and response interpretation continue to use its actual provenance                      |
| Private uses `/alpha/generate` and line-delimited private events                               | keep its serializer, transport, assembler, failure capture, and trace                                              |
| GOAT uses `openai-completions` and Pi transport                                                | keep the standard Pi provider path                                                                                 |
| `OpenAICompletionsCompat` contains endpoint/serializer facts                                   | keep it in the GOAT projection layer; do not add it to shared CommandCode model facts                              |
| Mistral, Bedrock, and OpenAI-completions target Adapters contain compatibility selection rules | preserve those rules during effort unification; replace one only in a separate evidence-backed compatibility audit |

## 4. Binding design decisions

### D1. Protocol locality is preserved

Responses and Anthropic may both call the same pinned Pi functions, but they do not import one another's intent, plan, Adapter input, outcome, error, or execution Module. No shared Token effort kernel or shared outcome type is introduced.

### D2. Pi is the mechanical selection authority

Use `getSupportedThinkingLevels(model)` for state classification and `clampThinkingLevel(model, requested)` for enabled-level selection. Do not add `nearestAvailableEnabledLevel()` or another wrapper shared across Client Protocols.

The pinned Pi contract is:

1. exact supported level;
2. otherwise first supported level at or above the request;
3. otherwise first supported level below the request;
4. otherwise `off`.

Token tests freeze this dependency behavior, including absent and partial `thinkingLevelMap` cases.

### D3. Prepared effort plans contain structural facts only

A protocol-owned plan carries intent and selection facts, not final projection outcomes. The Responses shape is conceptually:

```ts
type ResponsesEffortPlan =
  | { kind: "provider-default" }
  | { kind: "disabled" }
  | {
      kind: "enabled";
      requested: ResponsesReasoningEffortLevel;
      selection:
        | { kind: "selected"; level: ResponsesReasoningEffortLevel }
        | { kind: "no-selectable-level" }
        | { kind: "non-reasoning" };
    };
```

Anthropic defines its own equivalent structural facts inside the Anthropic Module. The type above is not exported to or imported by Anthropic.

### D4. Final Provider Wire owns one availability-first outcome

Preparation does not emit an effort `pi-native`, `payload-projected`, `degraded`, or `failed` result. The selected target Adapter emits exactly one final effort outcome after it verifies or repairs the Pi-built payload.

For enabled effort:

- `selected === requested` is exact level selection;
- `selected !== requested` is a named nearest-level degradation even if Pi wrote the selected wire shape correctly;
- `no-selectable-level` removes every graded strength control and uses a certified binary-enable or Provider-default fallback;
- `non-reasoning` removes every graded or enabling control and dispatches ordinary generation;
- an unavailable certified wire mapping removes the graded control and uses the Adapter's strongest valid fallback.

Every bounded fallback records `degraded` when the Client requested a stronger semantic. If a degraded selection also requires payload repair, the single final effort outcome remains `degraded`; its projector and warning identify the applied target fallback. Do not record a second effort outcome for the repair. Effort capability mismatch never emits `failed`; only an independent existing validity or safety failure may prevent dispatch.

### D5. Provider-default is target semantics

Omitting `options.reasoning` is not proof that final Provider Wire retained provider default. Some Pi serializers emit an implicit disabled shape. Target Adapters keep their provider-default verification and certified repair, including removal of known Pi-implicit off fields.

The binding behavior for omitted effort and Responses `none` is:

| Resolved model state | Client effort omitted | Client effort is `none` |
| -------------------- | --------------------- | ----------------------- |
| selectable reasoning | omit `options.reasoning`; remove any Pi-implicit off/grade field so final Wire retains Provider default | use only a certified `off`/disabled representation; when none exists, remove reasoning controls, record `degraded`, and dispatch with Provider default |
| no selectable level  | omit `options.reasoning`; final Wire contains no graded or indirect-strength control and retains Provider default | use a certified model/target disable representation when one exists; otherwise remove reasoning controls, record `degraded`, and dispatch with Provider default; never substitute the lowest level |
| non-reasoning        | omit `options.reasoning`; final Wire contains no grade, budget, or reasoning-enabling field | same ordinary non-reasoning request; remove any stray Pi reasoning field and dispatch without claiming a capability; this is not an effort-capability failure |

An omitted effort does not record `degraded`, because the Client requested neither a level nor explicit disablement. An unrepresentable `none` records `degraded` only for a reasoning model that may still reason under Provider default. A non-reasoning model already satisfies `none` without approximation.

### D5.1. Projection verifies; it does not select effort

The preparation stage is the only owner of state classification and nearest-level selection. A target Adapter receives the prepared structural plan and may only:

1. compute the target's certified wire representation for the already-selected Pi key;
2. verify the Pi-built final payload;
3. repair that exact certified field or remove known unsupported/implicit controls;
4. record the single final effort outcome.

A projector must not call `clampThinkingLevel()`, traverse level order, replace the selected key with another key, reinterpret an unknown Client value, or infer model capability from the payload. Cleanup for `no-selectable-level` and `non-reasoning` executes the prepared classification; it is not a second effort decision.

### D6. Key-to-wire mapping remains Adapter-owned

The selected Pi key is not a universal wire string. It may become `reasoning_effort`, `thinking`, `enable_thinking`, `chat_template_kwargs`, a token budget, Mistral `promptMode`, or another certified target shape. Each target Adapter maps and verifies its own shape from the selected key plus model and compatibility facts. It also owns the positive list of fields that express graded strength or reasoning enablement for that target, so it can enforce I1-I3 without a cross-protocol payload scanner.

### D7. Model-dependent work starts after model resolution

Request converters normalize client intent only. Responses selects in `prepareResponsesReasoning()`. Anthropic selects in `prepareAnthropicReasoning()`. Both functions receive the resolved `Model`.

### D8. CommandCode representation migration and data correction are separate changes

First replace `reasoningEfforts` with an explicit `thinkingLevelMap` while proving every projected CommandCode model is unchanged. Only then may an individual table cell change, with provider evidence and final-wire certification. Do not combine speculative data correction with the zero-behavior migration.

### D9. Private API identity and shared model facts remain honest

Do not rename `commandcode-private` to `openai-completions`. Do not add endpoint `compat` to provider-independent CommandCode facts. Provider isomorphism here means shared model capability data and selection mechanics, not identical transport or API provenance.

### D10. Codex projection owns only Codex vocabulary

`src/integrations/codex` owns Pi-key-to-Codex-slot projection because it creates and consumes the injected catalog contract. It receives the resolved `Model` and installed Codex vocabulary, then emits only the five-slot projection in section 1.2. Semantic Conversion Modules do not import Codex catalog types, and Codex integration does not map final Provider Wire.

## 5. Protocol-owned selection algorithm

Each Client Protocol implements this flow locally using Pi's public functions:

```text
normalize source intent before model resolution

after model resolution:
  provider-default → structural provider-default plan
  disabled         → structural disabled plan
  enabled(level):
    if model.reasoning === false
      → structural non-reasoning selection
    else if getSupportedThinkingLevels(model) excluding off is empty
      → structural no-selectable-level selection
    else
      selected = clampThinkingLevel(model, level)
      assert selected !== off and selected is in Pi's supported levels
      → structural selected(requested=level, level=selected)

Pi options:
  selected          → options.reasoning = selected
  every other case  → omit options.reasoning; target Adapter owns final meaning

target Adapter finalization:
  selected with certified wire mapping
    → verify/repair the legal selected representation; dispatch
  selected without certified wire mapping
    → remove graded controls; use certified binary/default fallback; degraded; dispatch
  no-selectable-level
    → remove every graded or indirect strength control
    → optionally retain certified binary enablement; degraded when level requested; dispatch
  non-reasoning
    → remove every graded, budget, and enablement control
    → retain only a target-required explicit disabled marker; ordinary-generation degraded; dispatch

  reject only for an independent invalid or unsafe request condition
```

Examples that freeze Pi selection, not a Token copy of it. Each row uses a full explicit map: the named non-`off` keys map to identity strings, every unnamed non-`off` key is `null`, and `off` is `null`.

| String-valued non-`off` keys             | Request           | Pi-selected key            |
| ---------------------------------------- | ----------------- | -------------------------- |
| `high`, `max`                            | `low`             | `high`                     |
| `high`, `max`                            | `xhigh`           | `max`                      |
| `low`, `high`                            | `max`             | `high`                     |
| `low`, `high`, `max`                     | `medium`          | `high`                     |
| `low`, `high`                            | `high`            | `high`                     |
| every non-`off` key is explicitly `null` | any enabled level | `no-selectable-level` plan |
| `reasoning=false`                        | any enabled level | `non-reasoning` plan       |

Partial and absent maps require separate tests because Pi treats missing lower levels differently from missing `xhigh`/`max`.

## 6. Phased execution

### Phase 0 — Freeze dependency and migration baselines

| Item       | Content                                                                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose    | make Pi behavior and current CommandCode projection observable before refactoring                                                                                                   |
| Add        | focused contract tests for pinned Pi `getSupportedThinkingLevels()` and `clampThinkingLevel()` using absent, partial, full, all-null, and non-reasoning maps                        |
| Add        | a projected-CommandCode golden or structural snapshot covering every current model (currently 58), including `thinkingLevelMap`                                                     |
| Capture    | exact installed Codex version, accepted reasoning vocabulary, and descriptions through the existing isolated Codex catalog gates                                                    |
| Keep       | existing source-facts fingerprint; expect it to change only when the source representation changes                                                                                  |
| Completion | tests fail if Pi selection order/default support changes, if the later catalog migration changes projected models, or if installed Codex vocabulary changes without recertification |
| Risk       | low                                                                                                                                                                                 |

### Phase 1 — Add protocol-owned structural plans

| Item      | Responses                                                     | Anthropic                                                                                                                       |
| --------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Location  | `src/protocols/openai-responses/semantic/reasoning/levels.ts` | local implementation in `src/protocols/anthropic/semantic/reasoning/request.ts` unless a separate file earns a deeper Interface |
| Interface | `resolveResponsesEffortPlan(model, intent)`                   | extend `PreparedAnthropicReasoning` with an Anthropic-owned effort-selection fact                                               |
| Mechanism | call pinned Pi state/selection functions                      | call pinned Pi state/selection functions                                                                                        |
| Output    | structural plan only                                          | structural plan only                                                                                                            |
| Tests     | test through the plan Interface                               | test through `prepareAnthropicReasoning()`                                                                                      |
| Guardrail | no target wire values or outcomes                             | no Responses imports, target wire values, or effort outcomes                                                                    |

Completion: both protocols classify the three model states according to Pi and return requested plus selected keys where selection succeeds. No production behavior changes yet.

### Phase 2 — Select after model resolution and write only the selected Pi key

| Item       | Content                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remove     | raw `piReasoning` / `validated.reasoning` authority in Responses request construction; raw specified effort authority in Anthropic request construction |
| Keep       | protocol-owned normalization, notices, original requested intent, activation, budgets, and continuity facts                                             |
| Apply      | `prepareResponsesReasoning()` and `prepareAnthropicReasoning()` set `options.reasoning` only for `selection.kind === "selected"`                        |
| Carry      | prepared protocol-owned selection to that protocol's projection operation without placing it in Pi IR or another protocol's invocation                  |
| Files      | Responses request/reasoning contract and preparation; Anthropic request/reasoning contract, execution, and projection Interface                         |
| Completion | Pi receives the selected key; target Adapters can inspect both requested and selected facts; no effort outcome exists before projection                 |
| Risk       | medium                                                                                                                                                  |

### Phase 3 — Consume plans in target Adapters and remove duplicate selection

| Item         | Content                                                                                                                                                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Responses    | remove local `THINKING_LEVELS` and `clampedEnabledLevel()`; map from the prepared selected key; retain target provider-default repair, disabled semantics, compatibility mapping, and final-shape verification                                                  |
| Anthropic    | update every Adapter that consumes a specified effort to use the Anthropic prepared selection; at minimum cover `pi-messages`, `openai-completions` (including GOAT), `commandcode-private`, and every other registered graded-effort target found by the audit |
| Outcomes     | each target Adapter emits exactly one effort outcome; add named effort fallbacks to the protocol-owned outcome union where needed                                                                                                                               |
| Invariants   | each Adapter positively identifies its target's graded, indirect-strength, enablement, and explicit-disable fields; final projection enforces I1-I3 and removes unsupported controls before dispatch                                                            |
| Availability | nearest legal level, binary enablement, Provider default, then ordinary generation are the bounded fallback order where each representation is certified; capability mismatch records `degraded` and remains dispatchable                                       |
| Preserve     | Mistral model compatibility, Bedrock Claude detection, and OpenAI-completions format resolution; this phase does not certify, expand, or delete those target rules                                                                                              |
| Completion   | `rg` finds no Token upward/downward level traversal; final-wire tests prove exact, repaired, and degraded behavior; every effort-capability mismatch dispatches a request satisfying I1-I3                                                                 |
| Risk         | medium to high because all affected target shapes must remain certified                                                                                                                                                                                         |

### Phase 4A — Migrate CommandCode facts to explicit tables with zero behavior change

| Item       | Content                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Change     | replace `reasoningEfforts` with a provider-independent explicit `thinkingLevelMap` in `CommandCodeModelFacts`; `projectCommandCodeModel()` passes it through |
| Invariant  | `reasoning=false` has no map; `reasoning=true` declares all seven keys (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) as `string` or `null`     |
| State 2    | a reasoning model with no selectable effort declares every non-`off` key `null`; `off` is also explicit                                                      |
| Baseline   | every projected model must deep-equal the Phase 0 snapshot before and after migration                                                                        |
| Tests      | update catalog validation and source-facts fingerprint; retain projection snapshot equality                                                                  |
| Completion | the explicit table is the only CommandCode level fact and final projected `Model` objects are unchanged                                                      |
| Risk       | medium: broad data edit, but behavior is mechanically frozen                                                                                                 |

### Phase 4B — Correct individual CommandCode table entries only with evidence

| Item          | Content                                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| Trigger       | a current table cell is contradicted by CommandCode source data, upstream documentation, or provider online evidence |
| Change unit   | one evidenced model/table correction with provenance recorded in test or adjacent source comment                     |
| Certification | both GOAT and Private final Provider Wire are tested for every changed selectable level and `off` behavior           |
| Completion    | every intentional projection delta is enumerated; unrelated models remain equal to the Phase 0 baseline              |
| Risk          | high; if no evidence exists, make no behavioral data change                                                          |

### Phase 4C — Certify GOAT endpoint compatibility at the GOAT layer

| Item       | Content                                                                                                                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audit      | compare GOAT final wire with the pinned Pi OpenAI-completions compatibility resolver                                                                                                                             |
| Apply      | express certified GOAT endpoint/serializer compatibility in `packages/provider-commandcode-goat`, either as an explicit provider-owned compat constant or a version-bound resolver proved identical to pinned Pi |
| Exclude    | no `OpenAICompletionsCompat` in shared CommandCode facts; no Private API relabeling                                                                                                                              |
| Completion | GOAT compatibility is deterministic and covered by final-wire tests for each affected compatibility class                                                                                                        |
| Risk       | medium; exact values require evidence rather than inference from model name or URL                                                                                                                               |

### Phase 4D — Project Pi capabilities into the Codex five-slot catalog

| Item       | Content                                                                                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract   | update `TokenCodexModelCatalogSpec.md` so routed reasoning derives `Provider facts → Pi supported key → five-slot Codex key`, using section 1.2                                                                                                                                              |
| Generator  | replace exact-name intersection in `src/integrations/codex/catalog.ts` with the explicit Pi-to-Codex projection and stable deduplication; continue intersecting with the installed Codex vocabulary for parser compatibility                                                                      |
| Closed set | routed `supported_reasoning_levels[].effort` is limited to `low`, `medium`, `high`, `xhigh`, and `max`; never inject `minimal`, `off`, Provider wire strings, or Codex `ultra`                                                                                                                    |
| Tests      | cover every Pi key, `minimal`-only, `minimal+low` deduplication, partial maps, all-null, non-reasoning, missing installed vocabulary, deterministic order, and installed-CLI parser acceptance; the `minimal`-only case continues through a captured final Provider request                       |
| Online     | run representative real Codex CLI requests for the five injected keys actually exposed by current callable targets; when a callable `minimal`-only target exists, additionally prove injected `low` → Responses `low` → runtime Pi `minimal`; never invent an online target solely for the matrix |
| Isolation  | every parser, prompt, and real-CLI process uses a newly created temporary `CODEX_HOME` under the repository's Codex test guard                                                                                                                                                                    |
| Completion | every routed Codex effort is one of the five legal slots and every advertised slot reaches a legal final Provider request for that model                                                                                                                                                          |
| Risk       | medium because this changes the visible Codex model picker and selected request effort                                                                                                                                                                                                            |

### Phase 5 — Make CommandCode Private consume the explicit table strictly

| Item         | Content                                                                                                                                                                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change       | remove `mapReasoningLevel()` hardcoded fallbacks; after Pi selection, require a string mapping for the selected non-`off` key                                                                                                                         |
| Keep         | `commandcode-private` API ID, payload shape, transport, assembler, response provenance, failure capture, and trace                                                                                                                                    |
| Availability | when the selected key lacks a certified string mapping, omit `reasoning_effort`, use CommandCode Provider default, publish a bounded notice, and let the protocol Adapter record `degraded`; do not invent a value or reject solely for this mismatch |
| Tests        | Private body builder plus Responses and Anthropic end-to-end final-wire tests; response interpretation/provenance remains unchanged                                                                                                                   |
| Completion   | GOAT and Private read the same CommandCode table and use Pi mechanics; missing or invalid effort mappings still produce a legal dispatch without `reasoning_effort`, while their wire Adapters remain distinct                                        |
| Risk         | medium                                                                                                                                                                                                                                                |

### Phase 6 — Final certification and Pi upgrade contract

| Matrix              | Required coverage                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| State and intent    | three Pi-classified states × all protocol-supported intents, including Responses `none`, `ultra`, and unknown policy                                                           |
| Pi map shape        | absent map, partial lower-level map, explicit `xhigh`/`max`, all-null full map, and non-reasoning model                                                                        |
| Selection           | exact, upward fallback, downward fallback, no-selectable, and non-reasoning                                                                                                    |
| Final-wire I1       | selectable model emits only a certified allowed level; unavailable requested level clamps upward/downward and dispatches with `degraded`                                       |
| Final-wire I2       | no-selectable model emits no direct or indirect strength control; certified binary enablement or Provider default still dispatches                                             |
| Final-wire I3       | non-reasoning model emits no level, budget, or enablement control; ordinary generation still dispatches with `degraded`                                                        |
| Availability        | missing effort mapping and every state/intent capability mismatch produce a valid dispatch; tests reject any effort-only failure path                                          |
| Independent failure | incompatible payload shape, duplicate ownership, invalid final payload, malformed consumed input, and security/permission failures remain unchanged and are tested separately  |
| Codex projection    | `minimal` and `low` both inject one Codex `low`; the other four Pi keys map to `medium/high/xhigh/max`; routed rows contain no other effort key                                |
| Codex round trip    | local final-wire certification covers every routed model/advertised slot; representative isolated real Codex CLI runs cover each distinct injected key and compatibility class |
| CommandCode         | Responses and Anthropic × GOAT and Private; assert full final Provider request and Private response provenance                                                                 |
| Architecture        | dependency tests prove no Responses↔Anthropic semantic imports and no new shared semantic executor/outcome/plan                                                                |
| Pi upgrade          | golden payloads per `Client Protocol × provider/API × model compatibility class`; rerun with the Pi public level-contract tests on every upgrade                               |

Provider/API alone is not a sufficient golden key: models under the same API can select different wire formats or compatibility behavior.

## 7. Dependencies and execution order

```text
Phase 0 baseline
   ├─→ Phase 1 protocol-owned plans
   │      ↓
   │   Phase 2 post-resolution options
   │      ↓
   │   Phase 3 target Adapter convergence
   │
   └─→ Phase 4A zero-behavior catalog migration
           ├─→ Phase 4B evidenced data corrections (only when evidence exists)
           ├─→ Phase 4D Codex five-slot projection
           └─→ Phase 5 Private strict table consumption

Phase 4C GOAT compatibility audit may run after Phase 0 in parallel.
Phase 6 grows with every phase and closes the work.
```

Do not begin Phase 4A before the projected-model baseline exists. Do not begin Phase 4B as part of the mechanical Phase 4A edit.

## 8. Explicit non-goals

- renaming `commandcode-private` to `openai-completions`;
- replacing Private transport with Pi OpenAI transport;
- sharing protocol intent, prepared plan, projection outcome, failure, registry, or semantic execution;
- representing all target wire semantics as `expectedWireValue: string`;
- treating `no-selectable-level` as universally provider-default or universally disabled;
- rejecting an otherwise valid request solely because its requested effort or reasoning capability is unavailable;
- injecting Provider wire values, Pi `minimal`, Pi `off`, or Codex `ultra` into routed Codex reasoning slots;
- deleting target compatibility rules merely because they mention a provider, model, or endpoint;
- changing all CommandCode table entries without per-entry evidence;
- modifying Pi or `node_modules` instead of using the pinned public interface.

## 9. First implementation slice

Start with Phase 0 and the Responses half of Phase 1. The first reviewable slice is complete when:

1. Pi absent/partial/all-null/non-reasoning behavior is frozen in tests;
2. all current CommandCode projected models have a migration baseline;
3. `resolveResponsesEffortPlan()` returns structural facts for the full Responses intent matrix;
4. no main request path, Provider payload, or projection outcome has changed.

This slice proves the seam before request-path and data migrations begin.
