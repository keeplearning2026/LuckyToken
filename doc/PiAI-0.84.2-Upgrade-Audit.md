# Pi AI 0.84.2 Upgrade Audit

**Date:** 2026-08-20
**LuckyToken baseline:** `fd7601d78aaed3fb0aca0ee9479faf5bcf2c5575`
**Vendored Pi baseline:** `pi-agent@914cf1472e715297caa30db4b9535d534a9eb718` (`v0.84.2`)
**Upgrade under review:** `@earendil-works/pi-ai` `0.84.1` → `0.84.2`

## 1. Conclusion

This is not only a package-version bump, but it also does not require every adjacent SDK or data-plane lane to be rewritten.

The required synchronization falls into four groups:

1. **Dependency and compatibility identity:** bump the root Pi package, LuckyToken provider peer dependencies, lockfile, certification pins, and the LuckyToken Pi compatibility baseline.
2. **Pi model-config schema:** add Pi 0.84.2's new `OpenAIResponsesCompat.supportsAdditionalTools` field to LuckyToken's extracted `models.json` schema and bump the schema/baseline identity to 0.84.2.
3. **OpenAI Responses ↔ Pi IR semantics:** update LuckyToken to use the new real `ToolCall.namespace` Pi IR slot for tool-call history/output. The existing namespace-tool declaration flattening is still needed because Pi `Tool` itself still has no namespace slot.
4. **Specifications and evidence:** update active protocol specifications and re-anchor the Pi adapter evidence used by usage declarations. Several current documents explicitly assert that installed Pi has no `ToolCall.namespace`; that becomes false under 0.84.2.

The following do **not** require a matching architectural rewrite:

- Anthropic SDK remains `0.91.1` in Pi 0.84.2.
- Provider Native Responses should remain a raw-wire preservation lane and should not start importing Pi's OpenAI SDK or semantic request builders.
- CommandCode Private already rejects non-representable `ToolCall.namespace`; the functional policy is already prepared, although types/tests/docs should be simplified and synchronized.
- `AssistantMessage.endTurn` is diagnostics-only in Pi 0.84.2 and does not require invention of an Anthropic or CommandCode wire field.

## 2. Primary-source basis

### Pre-upgrade LuckyToken baseline

`package.json` and `node_modules/@earendil-works/pi-ai/package.json` show:

- `@earendil-works/pi-ai`: `0.84.1`
- `@anthropic-ai/sdk`: `0.91.1`
- Pi 0.84.1 transitively uses:
  - `openai`: `6.26.0`
  - `@earendil-works/pi-telemetry`: `0.84.1`
  - `@mistralai/mistralai`: `2.2.6`

Sources:

- `package.json`
- `node_modules/@earendil-works/pi-ai/package.json`
- `node_modules/@anthropic-ai/sdk/package.json`

### Pi 0.84.2 source

The vendored `pi-agent` tree is exactly tag `v0.84.2` at `914cf1472`.

`pi-agent/packages/ai/package.json` shows Pi 0.84.2 uses:

- `@anthropic-ai/sdk`: `0.91.1` — unchanged
- `openai`: `6.40.0` — upgraded from 6.26.0
- `@earendil-works/pi-telemetry`: `^0.84.2` — upgraded
- `@mistralai/mistralai`: removed — Mistral transport is now native HTTP
- `@google/genai`: `1.52.0` — unchanged
- `@aws-sdk/client-bedrock-runtime`: `3.1048.0` — unchanged
- `typebox`: `1.3.7` — unchanged

The published-package install lock in `pi-agent/packages/coding-agent/install-lock/package-lock.json` independently confirms the 0.84.2 package graph.

Sources:

- `pi-agent/packages/ai/package.json`
- `pi-agent/packages/ai/CHANGELOG.md`
- `pi-agent/packages/coding-agent/install-lock/package-lock.json`

## 3. Public Pi contract delta

The public `types.ts` diff from `v0.84.1` to `v0.84.2` adds three relevant optional fields and does not remove a LuckyToken-used required field:

### `ToolCall.namespace?: string`

Pi 0.84.2 can now preserve an OpenAI Responses function/custom tool-call namespace in Pi IR.

Source:

- `pi-agent/packages/ai/src/types.ts`
- `pi-agent/packages/ai/src/api/openai-responses-shared.ts`
- `pi-agent/packages/ai/test/openai-responses-namespace.test.ts`

### `AssistantMessage.endTurn?: boolean`

OpenAI Codex Responses can preserve terminal `response.end_turn` in Pi IR. The Pi changelog explicitly describes this as diagnostics-only; it currently does not alter agent control flow.

Source:

- `pi-agent/packages/ai/src/types.ts`
- `pi-agent/packages/ai/src/api/openai-codex-responses.ts`

### `OpenAIResponsesCompat.supportsAdditionalTools?: boolean`

This advertises support for message-anchored `additional_tools` when Pi handles deferred tools.

Source:

- `pi-agent/packages/ai/src/types.ts`
- `pi-agent/packages/ai/src/api/openai-responses.ts`
- `pi-agent/packages/ai/src/api/openai-codex-responses.ts`
- `pi-agent/packages/coding-agent/src/core/model-config.ts`
- `pi-agent/packages/ai/scripts/generate-models.ts`

## 4. Impact matrix

| Area | 0.84.2 change | Current LuckyToken state | Verdict | Required action |
|---|---|---|---|---|
| Root Pi dependency | Pi package version | Root still pins 0.84.1 | **Must update** | `package.json` + lockfile → 0.84.2 |
| Provider package peers | Pi type/provider contract version | both provider packages peer-pin exact 0.84.1 | **Must update** | bump both peer dependencies to 0.84.2 |
| Pi model-config schema | adds `supportsAdditionalTools` | extracted schema lacks it | **Must update** | sync `models-json-schema.ts` |
| Compatibility baseline | model-config schema changed | baseline/literals still say 0.84.1 | **Must update** | baseline + control-plane contract/wire + related tests |
| Responses request → Pi IR | `ToolCall.namespace` now exists | call items do not read `rawItem.namespace` | **Must update** | preserve call namespace in Pi `ToolCall` |
| Pi IR → Responses | Pi provider may now emit `ToolCall.namespace` | renderer only reconstructs namespace from request-local flatten map | **Must update** | render real Pi namespace and validate conflicts with reverse-map metadata |
| Namespace tool declarations | Pi `Tool` still has no namespace | declaration children are flattened to `<namespace>.<child>` | **Keep, with revised rationale** | retain flattening for tool catalog; do not mistake ToolCall support for Tool support |
| `additional_tools` client input | Pi provider supports new deferred mode | LuckyToken already parses `additional_tools`, but Core v1 rejects tool-search/deferred discovery | **No forced feature expansion** | keep current Core policy unless separately choosing deferred-tool support |
| CommandCode request conversion | namespace becomes a real Pi field | already throws when a ToolCall has namespace | **Behavior already correct** | simplify cast/test and update spec; preserve explicit failure |
| CommandCode response → Pi IR | optional new fields | CommandCode wire has no namespace/endTurn evidence | **No semantic change** | omit optional fields rather than invent them |
| Anthropic request → Pi IR | no relevant Pi request contract removal | current conversion unaffected | **No required semantic change** | regression test after package bump |
| Pi IR → Anthropic | namespace/endTurn may be present | renderer already allows both and does not leak them | **Mostly prepared** | decide whether namespace omission should remain silent or become warning/failure; no SDK bump |
| Provider Native Responses | Pi's internal Responses provider improved | LuckyToken forwards raw request/response with lane-owned auth/endpoint rules | **No semantic code change** | keep raw preservation; run native-lane regression tests |
| Anthropic SDK | unchanged at 0.91.1 | root already 0.91.1 | **No update** | keep 0.91.1 |
| OpenAI SDK | Pi internal dep 6.26 → 6.40 | LuckyToken does not import `openai` directly | **Transitive only** | let Pi own 6.40.0; do not add a LuckyToken direct dep |
| Pi telemetry | 0.84.1 → 0.84.2 | no LuckyToken direct import | **Transitive only** | lockfile will resolve 0.84.2 |
| Mistral SDK | removed from Pi | no LuckyToken direct import | **Dependency removal only** | allow lockfile to remove it when no other package needs it |
| Usage evidence | several Pi adapter files changed/reflowed; Mistral rewritten | LuckyToken pins 0.84.1 commit/line evidence | **Must re-audit evidence** | re-check semantics and update source anchors, not blind text replacement |
| Active protocol docs | installed-Pi assumptions change | several docs still assert 0.84.1/no namespace | **Must update** | revise Pi IR, Responses, CommandCode, architecture/audit docs |

## 5. OpenAI Responses ↔ Pi IR: the most important semantic change

### 5.1 Current LuckyToken design

`src/protocols/openai-responses/request.ts` currently flattens namespace tool definitions into names such as:

```text
mcp.read
```

and stores the reverse mapping only in request-local `namespaceReverse` render state.

That was correct for Pi 0.84.1 because installed Pi `ToolCall` had no namespace slot.

### 5.2 What changes in Pi 0.84.2

Pi 0.84.2's OpenAI Responses provider now records upstream function/custom call namespaces directly on:

```ts
ToolCall.namespace
```

and can replay that namespace when the target Responses model can safely accept it.

LuckyToken's request converter currently constructs call history as:

```ts
{
  type: "toolCall",
  id,
  name,
  arguments
}
```

and never reads `rawItem.namespace`.

LuckyToken's response renderer currently derives namespace only from `namespaceReverse[name]`. Therefore a Pi 0.84.2 provider response such as:

```ts
{
  type: "toolCall",
  name: "lookup",
  namespace: "dynamic_tools",
  ...
}
```

can lose `namespace` when converted back to the client Responses wire.

### 5.3 Required new rule

Tool **declarations** and ToolCall **instances** must be treated separately:

- Pi `Tool` still has no namespace field → namespace declaration flattening remains necessary for a representable client-executed catalog.
- Pi `ToolCall` now has a namespace field → call history/output should use the exact IR slot rather than intentionally erasing it.

For outbound Responses rendering, a safe rule is:

1. no reverse-map entry + Pi namespace present → emit the Pi name + Pi namespace;
2. reverse-map entry + Pi namespace absent → retain existing reverse-map behavior;
3. reverse-map entry + matching Pi namespace → emit reversed child name + namespace;
4. reverse-map entry + conflicting Pi namespace → fidelity failure, not arbitrary precedence.

This preserves old flattened declaration support while adopting the new real Pi call contract.

## 6. `additional_tools`: compatibility metadata must update, Client Core policy need not

Pi 0.84.2 adds `supportsAdditionalTools` because its OpenAI/OpenAI-Codex provider can place dynamically loaded deferred tools in a message-anchored `additional_tools` item.

LuckyToken already recognizes `additional_tools` input items and merges their tool declarations while converting a concrete client request. That is separate from enabling Pi's deferred tool-discovery lifecycle.

Current LuckyToken Core v1 intentionally rejects:

- `tool_search_call` / `tool_search_output` lifecycle conversion;
- `defer_loading=true` that requires deferred discovery.

The Pi package upgrade alone does not require changing that product contract. What **is** required is allowing `supportsAdditionalTools` through LuckyToken's Pi-compatible `models.json` schema so a valid Pi 0.84.2 model configuration is not rejected or stripped.

## 7. Strict tool schemas: provider behavior changed, but do not duplicate it in client adapters

Pi 0.84.2 adds a strict-schema transformation for provider constrained sampling:

- object schemas are closed with `additionalProperties=false`;
- all object properties become required;
- formerly optional non-nullable properties become nullable for provider strict mode;
- unsupported strict schema constructs are rejected when strict behavior is required;
- null values for optional non-nullable tool arguments are normalized to omission before validation.

This is Pi Provider execution behavior. LuckyToken's external protocol adapters should continue to convert source semantics into Pi `Tool` / `constrainedSampling`; they should not independently clone Pi's provider-specific strict-schema rewrite.

CommandCode Private already owns its own documented degradation policy for constrained sampling, so this Pi built-in-provider change does not justify changing CommandCode wire semantics.

Sources:

- `pi-agent/packages/ai/src/api/constrained-sampling.ts`
- `pi-agent/packages/ai/src/utils/validation.ts`
- `pi-agent/packages/ai/src/api/anthropic-messages.ts`
- `pi-agent/packages/ai/src/api/openai-responses-shared.ts`

## 8. CommandCode Private

`packages/provider-commandcode-private/src/provider.ts` already guards against a ToolCall namespace using a compatibility cast and throws:

```text
CommandCode cannot map a ToolCall namespace
```

That is the correct failure direction after 0.84.2. CommandCode has no proven namespace field, and silently dropping namespace can change tool identity.

After upgrading Pi:

- remove the compatibility cast and read `block.namespace` directly;
- keep the explicit rejection;
- update tests so `namespace` is ordinary typed Pi input rather than a future-field cast;
- update the conversion specification that currently says installed Pi has no namespace.

No `endTurn` field should be invented on CommandCode output. CommandCode → Pi simply leaves it undefined unless a future CommandCode wire contract supplies an authoritative equivalent.

## 9. Anthropic conversion

Pi 0.84.2 still depends on `@anthropic-ai/sdk@0.91.1`, exactly matching LuckyToken's current direct dev dependency.

LuckyToken's Anthropic response renderer is already future-prepared:

- `AssistantMessage.endTurn` is accepted in its message allowlist and not emitted to Anthropic wire;
- `ToolCall.namespace` is accepted in its content allowlist and is currently omitted from Anthropic `tool_use`.

No Anthropic SDK upgrade is required by Pi 0.84.2.

One policy question should be made explicit during implementation: now that namespace is a real Pi tool-call semantic field, is dropping it when converting Pi → Anthropic always safe? If it can distinguish two executable tools with the same child name, the project conversion principle favors an explicit failure rather than silent loss. This is a protocol-policy decision, not an SDK compatibility requirement.

## 10. Provider Native Responses

The native lane in:

- `src/provider-native-responses/index.ts`
- `src/provider-native-responses/openai.ts`
- `src/provider-native-responses/codex.ts`
- `src/provider-native-responses/azure.ts`

uses raw client wire as authority and performs only lane-owned model identity, credential/header, endpoint, and content-encoding work.

That lane already preserves new wire fields such as namespace, `additional_tools`, and terminal response metadata because it does not reconstruct the semantic body or response.

Pi 0.84.2 does not justify importing Pi's `openai` package or `openai-responses` semantic builders into this lane. Doing so would weaken the three-lane isolation contract.

The OpenAI Codex provider's 0.84.2 User-Agent refactor still produces the same `pi (<platform> <release>; <arch>)` shape that LuckyToken's native sender already emits.

## 11. Models.json compatibility baseline

LuckyToken explicitly extracts Pi Coding Agent's `model-config.ts` schema into:

```text
src/providers/models-json-schema.ts
```

The file itself says it must stay in sync with upstream.

Between Pi 0.84.1 and 0.84.2, of LuckyToken's pinned compatibility-source quartet:

- `model-config.ts` **changed** — adds `supportsAdditionalTools`;
- `provider-composer.ts` did not change;
- `model-runtime.ts` did not change;
- `resolve-config-value.ts` did not change.

Therefore:

- schema extraction must change;
- composition/runtime/config-resolution algorithms do not need functional rewrites solely for this upgrade;
- the compatibility identity in `src/providers/pi-baseline.ts` must become 0.84.2 because its schema source changed.

The exact literals also propagate through:

- `packages/application-control-plane/src/contracts.ts`
- `packages/application-control-plane/src/wire.ts`
- effective-catalog tests and control-plane fixtures.

## 12. Version pins: do not globally replace every `0.84.1`

### Definitely upgrade

- root `package.json` Pi dependency;
- root `package-lock.json` Pi package graph;
- `packages/provider-contract/package.json` Pi peer dependency;
- `packages/provider-commandcode-private/package.json` Pi peer dependency;
- Pi compatibility baseline version/schema;
- certification assertions that pin the installed package/lock integrity;
- `pi-models-json` compatibility metadata because the supported model-config schema changed;
- active docs whose claim is explicitly about the installed Pi contract.

### Re-audit rather than blind replacement

`src/providers/usage-declarations.ts` stores source commit/version commentary and exact line anchors into Pi adapter implementations. Several source files changed and Mistral transport was rewritten. The semantic declarations appear broadly compatible, but the evidence must be re-verified and re-anchored against v0.84.2.

### Do not automatically upgrade historical/package-release references

Examples include:

- Pi's own `CHANGELOG.md` section headings;
- Git logs;
- historical captures such as `anthropic_request.json`;
- documents intentionally describing a past audit baseline.

### `pi-auth-json` backup metadata needs semantic treatment

`src/backup/configured.ts` currently labels both `pi-models-json` and `pi-auth-json` with `0.84.1`.

The backup `version` is copied into manifest contract metadata; it is not mechanically resolved from the installed npm package. No relevant auth-storage contract change was found between 0.84.1 and 0.84.2, while the model-config schema definitely changed.

Therefore:

- `pi-models-json` should move to the 0.84.2 compatibility identity;
- `pi-auth-json` should not be changed merely because the package version changed. Keep it if it denotes the unchanged file-format contract, or rename/version it only if the project decides this field is meant to identify package provenance rather than schema format.

Sources:

- `src/backup/configured.ts`
- `src/backup/authority.ts`
- Pi 0.84.1 → 0.84.2 coding-agent source diff

## 13. Documentation inconsistencies already present

Some current documentation already mixes future vendored Pi fields with a 0.84.1 installed-package provenance.

### `doc/Protocols/Pi AI IR Protocol.md`

The header/provenance says `@earendil-works/pi-ai 0.84.1`, but the body already documents:

- `ToolCall.namespace?: string`
- `AssistantMessage.endTurn?: boolean`

That is internally inconsistent with the actual root 0.84.1 install and should be re-frozen against 0.84.2.

### `doc/Protocols/OpenAI Responses-Pi AI IR Conversion Method.md`

It explicitly states that installed Pi 0.84.1 `Tool/ToolCall` has no namespace and therefore all namespace behavior must be adapter-local flattening. After upgrading, the `Tool` half remains true but the `ToolCall` half becomes false.

### `doc/Protocols/PI AI IR-Commandcode Private Conversion.md`

It explicitly says `ToolCall.namespace` is only a newer vendored field and not part of installed Pi. This becomes false.

### `doc/ProtocolConversion-Completeness-Audit.md`

Finding C-15 currently disproves the statement that installed Pi has ToolCall namespace. That finding must be marked resolved/superseded under the new 0.84.2 baseline.

Other active version references to re-check include:

- `doc/LuckyTokenArchitecture.md`
- `doc/HANDOFF.md`

## 14. Recommended implementation sequence

1. **Dependency red gate**
   - update expected versions/peers/certification to 0.84.2;
   - add/update tests for the new compatibility baseline and schema field;
   - add failing Responses namespace tests using typed Pi 0.84.2 `ToolCall.namespace`.
2. **Install package graph**
   - root Pi → 0.84.2;
   - let npm resolve Pi-owned `openai@6.40.0`, `pi-telemetry@0.84.2`, and remove the now-unused Mistral SDK transitively.
3. **Sync model-config boundary**
   - `supportsAdditionalTools` schema;
   - baseline 0.84.2 identity through control-plane wire/contracts.
4. **Sync Responses semantic boundary**
   - preserve incoming call `namespace` into Pi IR;
   - render Pi namespace back out;
   - keep namespace declaration flattening where Pi `Tool` lacks a slot;
   - detect namespace/reverse-map conflicts.
5. **Simplify CommandCode compatibility code**
   - use typed `block.namespace` while keeping explicit non-representable failure.
6. **Re-audit Pi implementation evidence**
   - especially usage declaration anchors and Mistral semantics.
7. **Synchronize active specs/docs**
   - update provenance and remove 0.84.1-only assertions.
8. **Quality gates**
   - typecheck/build;
   - protocol unit + integration tests;
   - provider-native preservation tests;
   - certification tests;
   - full lint/test/release-layout gates.

## 15. Expected package graph after upgrade

LuckyToken should conceptually own only the dependency it actually uses:

```text
LuckyToken
└── @earendil-works/pi-ai 0.84.2
    ├── @anthropic-ai/sdk 0.91.1
    ├── openai 6.40.0
    ├── @earendil-works/pi-telemetry 0.84.2
    ├── @google/genai 1.52.0
    ├── @aws-sdk/client-bedrock-runtime 3.1048.0
    └── ...
```

Do not add `openai` as a direct LuckyToken dependency merely to mirror Pi's internal implementation. `src/`, `packages/`, and `test/` currently have no direct `openai` imports.

## 16. Final classification

### Must change before calling the upgrade complete

- Pi npm dependency + lockfile;
- provider-contract and CommandCode provider peer pins;
- Pi models-json schema + compatibility baseline/control-plane literals;
- OpenAI Responses ToolCall namespace request/response conversion;
- affected tests/certification;
- active protocol documentation and stale installed-Pi assertions;
- usage evidence source anchors after re-verification.

### Validate, but do not redesign by default

- Anthropic ↔ Pi conversion;
- Provider Native Responses;
- credential/model runtime APIs;
- CommandCode response conversion;
- built-in Pi provider behavior affected by strict schema, retry, DeepSeek, Google, Bedrock, Mistral fixes.

### No independent LuckyToken package bump required

- `@anthropic-ai/sdk` (already 0.91.1 and unchanged upstream);
- `openai` (Pi-owned transitive dependency moves to 6.40.0);
- `@earendil-works/pi-telemetry` (Pi-owned transitive dependency moves to 0.84.2);
- `@mistralai/mistralai` (removed by Pi 0.84.2 rather than upgraded).

## 17. Implementation outcome (2026-08-20)

The upgrade was implemented without changing LuckyToken's three-lane architecture. Provider Native Responses remains a raw-wire preservation lane; no OpenAI SDK or Pi semantic conversion was introduced into it.

### Dependency result

- `@earendil-works/pi-ai` is pinned to `0.84.2` at the root and in both LuckyToken Provider peer contracts.
- Pi-owned transitive dependencies resolve to `@earendil-works/pi-telemetry@0.84.2` and `openai@6.40.0`.
- `@anthropic-ai/sdk` remains `0.91.1`.
- `@mistralai/mistralai` is no longer present in LuckyToken's resolved dependency tree.

### Namespace result

The final Responses rule is more precise than a blanket “copy namespace into Pi” rule:

- namespace tool declarations still flatten to `<namespace>.<child>` because Pi `Tool` has no namespace slot;
- a historical namespaced call that matches such a request-owned declaration is canonicalized to the same flattened Pi ToolCall name, keeping `Context.tools`, ToolCall, and ToolResult on one identity;
- a historical namespaced call without a matching flattened declaration preserves the exact namespace at the Client Wire → Pi IR conversion boundary, then fails closed before Pi Provider execution because Core v1 has no certified Provider replay identity for that unmatched namespace;
- Pi → Responses renders direct `ToolCall.namespace` returned by a Pi Provider, retains the existing reverse-map behavior, and fails closed if the two namespace authorities conflict;
- Anthropic and CommandCode fail conversion for namespace-bearing Pi ToolCalls because neither target contract has a safe namespace identity slot.

`AssistantMessage.endTurn` remains diagnostic-only on semantic conversion lanes. It is not used to synthesize Anthropic, standard Responses, or CommandCode terminal semantics.

### Configuration and evidence result

- the extracted Pi `models.json` schema now accepts `supportsAdditionalTools`;
- the effective catalog/control-plane compatibility baseline is `0.84.2`;
- configured `pi-models-json` backup metadata follows that baseline;
- `pi-auth-json` backup metadata intentionally remains `0.84.1` because the Pi credential types/auth-storage format did not change between 0.84.1 and 0.84.2;
- usage declarations were re-audited against upstream `v0.84.2` (`914cf1472`); Mistral changed transport from generated SDK to native HTTP but retained the same canonical prompt/cache/output usage partition.

### Regression discovered during upgrade

The full suite exposed one stale pinned-catalog fixture: Cloudflare AI Gateway no longer contains `claude-3-5-haiku` in the 0.84.2 Anthropic catalog. The integration test was updated to the current `claude-haiku-4-5` model while retaining its original passthrough URL, credential-header, and HTTP-success assertions. This was a catalog-baseline synchronization issue, not a Native Preservation transport regression.

### Verification completed

- `npm run typecheck`: passed across Provider packages, Application Control Plane, root, and desktop shell.
- targeted affected seams: 197 tests passed before the final full run.
- `npm run test:certification`: 39/39 passed after rebinding normative-document hashes and the conformance record revision.
- `npm test`: root 207 test files / 2087 tests passed; desktop shell 17 test files / 76 tests passed.
- `npm run lint`: passed for root and desktop shell.
- `npm run build`: passed, including release-backend assembly and Electron packaging.
- `npm run release:verify-layout`: 4/4 release-layout/version checks passed.
- `npm run test:distribution`: passed, including distribution tarball Provider resolution, desktop tests, and 6 packaged Electron product E2E journeys.
- `git diff --check`: passed after normalizing the Pi protocol header formatting.
- two-request real online smoke using a temporary current-contract PublicModelAuthority alias: OpenAI Responses → Pi IR → CommandCode Private returned HTTP 200 with the expected marker; Anthropic Messages → Pi IR → CommandCode Private returned HTTP 200 with the expected marker. The temporary data directory was removed after the run.

## 18. Code-review follow-up and full online recertification (2026-08-21)

A second Standards/Spec review found two correctness gaps that did not require any three-lane architectural change:

1. the Application Control Plane effective-catalog decoder accepted any non-empty baseline strings and then type-asserted them as the current 0.84.2 literals, so an old 0.84.1 wire could be misrepresented as current;
2. an unmatched Responses `ToolCall.namespace` could survive Client Wire → Pi IR and then be silently dropped by Pi providers whose target protocol has no namespace representation.

Both were fixed test-first. The Control Plane decoder now accepts only the exact current baseline literals. Semantic Responses execution now rejects a remaining namespace-bearing historical ToolCall before Pi Provider execution; namespace calls that match a request-owned namespace declaration continue to use the existing flattened canonical identity and are unaffected.

The review also found that the old `serving-conformance-v2` online evidence was stale: it was executed at repository revision `22ed328a...`, where the runtime still used `@earendil-works/pi-ai@0.84.1`. That evidence has been replaced by `test/fixtures/certification/online-validation-2026-08-21.json`, which explicitly records Pi 0.84.2, its package integrity, current CLI versions, the working-tree base revision, and an implementation fingerprint over the upgrade/runtime/online-harness files.

The full online recertification on Pi 0.84.2 produced 254/254 successful certified cases:

- direct Pi IR ↔ CommandCode Private probe: 23/23;
- Anthropic Client → Pi IR → CommandCode Private: 60/60;
- OpenAI Responses Client → Pi IR → CommandCode Private: 60/60;
- real Codex CLI: three independent complete 20-case batches, 60/60 total;
- real Claude CLI: three independent complete 17-case batches, 51/51 total.

The online work also corrected test-harness defects rather than hiding them: SQLite-backed stores are explicitly closed before temporary-state deletion; Responses and Codex restart coverage now rebuilds a fresh composition/runtime against persisted state; cases that assert thinking explicitly request high reasoning effort; and real CLI prompts name the actually advertised tool and prohibit unrelated planning/delegation/artifact inspection. Failed/transient attempts remain recorded in the new evidence artifact and are excluded from the 254/254 passed count.
