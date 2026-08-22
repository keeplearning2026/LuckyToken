# LuckyToken Codex Model Catalog Specification v1.0

**Status:** IMPLEMENTED / VALIDATED ON CODEX 0.149.0

**Date:** 2026-08-21

**Observed Codex runtime:** `codex-cli 0.149.0`

**Scope:** `luckytoken-model-catalog.json` generation, the three Codex root routing fields, restore behavior, and CLI/online certification

This document defines the implemented contract. Sections labelled **Confirmed** record observed source or runtime behavior. Contract rules state what LuckyToken implements and what future Codex versions must continue to prove.

## 1. Outcome

LuckyToken must generate a Codex catalog that is both:

1. structurally accepted by the installed Codex runtime; and
2. semantically honest about each routed model and LuckyToken's Responses conversion path.

Parser acceptance alone is insufficient. A field may parse successfully while falsely advertising reasoning levels, image detail, verbosity, hosted search, parallel tools, service tiers, or another capability.

The integration owns one file under the resolved Codex home:

```text
<CODEX_HOME>/luckytoken-model-catalog.json
```

It changes only these three root-level `config.toml` fields while enabled:

```toml
model_provider = "openai"
openai_base_url = "http://127.0.0.1:<LuckyToken port>/v1"
model_catalog_json = "<absolute path to CODEX_HOME/luckytoken-model-catalog.json>"
```

It must not edit Codex's native catalog, `models_cache.json`, provider tables, authentication state, or unrelated configuration.

## 2. Evidence and authority

### 2.1 Authority order

Use the narrowest authority that owns each fact:

| Fact | Authority |
| --- | --- |
| Fields and enum values accepted by the installed Codex parser | The exact installed runtime, exercised through `codex debug models` and `codex debug prompt-input` |
| Native Codex rows and current Codex reasoning descriptions | `codex debug models --bundled`; read-only `models_cache.json` remains the existing fallback when bundled discovery is unavailable |
| Routed identity and callability | LuckyToken Public Model alias snapshot and resolved Pi `Models` collection |
| Input modalities and context window | The resolved Pi `Model` |
| Routable reasoning controls | Pi `getSupportedThinkingLevels(model)` and `Model.thinkingLevelMap`, intersected with the installed Codex vocabulary |
| Tool/search/verbosity/summary behavior | LuckyToken's OpenAI Responses request/response implementation and end-to-end tests |
| Official OpenAI model capabilities | Official OpenAI model documentation; this is model evidence, not the external catalog parser schema |
| Restore result | User-configured `integrations.codex.preimage.*` values |

No reference project is authoritative for LuckyToken. Reference implementations provide failure evidence and useful strategies only.

### 2.2 Confirmed local evidence

- [LuckyToken catalog generator](../../src/integrations/codex/catalog.ts) projects native rows plus callable aliases.
- [Native catalog source](../../src/integrations/codex/native-catalog-source.ts) invokes `codex debug models --bundled` first and reads `models_cache.json` only as a fallback; it never reconstructs native identity from Pi.
- [Codex integration authority](../../src/integrations/codex/integration.ts) owns the three root keys and the LuckyToken catalog path.
- [Codex catalog tests](../../test/unit/codex-catalog.test.ts) currently cover native-row preservation, alias identity, collisions, unavailable targets, and the one-slash boundary.
- [Native source tests](../../test/unit/codex-native-catalog-source.test.ts) cover installed-runtime discovery and the read-only cache fallback.
- [CommandCode model capabilities](../../packages/commandcode-model-catalog/src/index.ts) contain per-model context, modalities, reasoning status, and reasoning-effort data without volatile pricing. Private and Goat project those facts into their own Pi Model identities. For example, DeepSeek V4 Flash exposes `high/max`, Qwen 3.8 Max exposes `low/medium/xhigh`, Grok 4.5 exposes `low/medium/high`, and GPT-5.6 Luna exposes `low/medium/high/xhigh/max`.
- Pi's installed `Model` contract says missing `thinkingLevelMap` keys use provider defaults, while `null` means unsupported. Its `getSupportedThinkingLevels` implementation exposes `xhigh/max` only when explicitly mapped: [types](../../node_modules/@earendil-works/pi-ai/dist/types.d.ts) and [implementation](../../node_modules/@earendil-works/pi-ai/dist/models.js).
- LuckyToken converts freeform custom/apply-patch and shell tools, but rejects deferred `tool_search` lifecycles: [Responses request conversion](../../src/protocols/openai-responses/request.ts) and [request tests](../../test/unit/openai-responses-request.test.ts).
- The current Responses conversion drops `text.verbosity` and the request's `parallel_tool_calls` auxiliary field; therefore the catalog must not infer those capabilities merely from Codex defaults.
- Official OpenAI model pages publish capabilities per model rather than as one global family ladder. For example, [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) lists `none/low/medium/high/xhigh/max`, a 1,050,000-token context window, and a 128,000-token maximum output.

### 2.3 Confirmed reference evidence

cc-switch:

- Clones a template and then overwrites routed identity/context fields: [catalog entry construction](../../reference/cc-switch/src-tauri/src/codex_config.rs#L551).
- Separates proxy-chat, native Responses, and Anthropic tool profiles because a tool declaration is valid only if the selected path can execute it: [tool profiles](../../reference/cc-switch/src-tauri/src/codex_config.rs#L117).
- Obtains a template from `models_cache.json`, then `codex debug models --bundled`, then a static fallback, and backfills parser-required fields without overwriting existing values: [template loading](../../reference/cc-switch/src-tauri/src/codex_config.rs#L1102).
- Places `model_catalog_json` at the TOML root and applies an ownership rule before replacing a user's catalog pointer: [config projection](../../reference/cc-switch/src-tauri/src/codex_config.rs#L1241).
- Its native template deliberately removes freeform custom tools when a direct gateway cannot accept them: [native Responses template](../../reference/cc-switch/src-tauri/src/resources/codex_native_responses_template.json).

OpenCodex:

- Preserves native rows, clones a native template for routed rows, removes native-only service/WebSocket data, and treats `models_cache.json` as a separate cache: [catalog SOT](../../reference/opencodex/structure/03_catalog-and-subagents.md).
- Normalizes the closed `input_modalities` enum to `text/image/audio`, defaults missing context conservatively, and strips native-only fields from routed rows: [catalog parsing](../../reference/opencodex/src/codex/catalog/parsing.ts#L298).
- Rewrites the cloned native model identity and applies exact provider/model reasoning metadata instead of keeping the native GPT identity: [catalog sync](../../reference/opencodex/src/codex/catalog/sync.ts#L241).
- Pairs `tool_mode: "code_mode_only"` with its own deferred-tool execution path. LuckyToken does not currently implement that path, so copying this pair would be incorrect: [routed tool discovery](../../reference/opencodex/structure/03_catalog-and-subagents.md#routed-tool-discovery-and-hosted-search).

## 3. Installed CLI contract

### 3.1 Probe method

**Confirmed on `codex-cli 0.149.0`:** the following commands are available:

```powershell
codex --version
codex debug models --help
codex debug prompt-input --help
codex exec --help
```

`codex debug models --bundled` returned eight native rows on 2026-08-21. The rows contained exact per-model reasoning ladders and a union of fields including:

```text
slug, display_name, description, supported_reasoning_levels,
default_reasoning_level, shell_type, visibility, supported_in_api,
priority, model_messages, base_instructions, support_verbosity,
truncation_policy, input_modalities, context_window,
max_context_window, supports_search_tool, tool_mode,
multi_agent_version, service_tiers, additional_speed_tiers,
use_responses_lite, include_*_usage_instructions, node_repl_*
```

The bundled catalog is authoritative for native rows and current Codex vocabulary. The presence of a field on a native OpenAI row does not prove that a routed third-party model supports the same capability.

### 3.2 Required entry fields

**Confirmed by incremental real-CLI probes:** starting from `{"models":[{}]}`, `codex debug models` rejected one missing field at a time. The smallest accepted routed entry required the following fields:

| Field | Required shape | LuckyToken value |
| --- | --- | --- |
| `slug` | non-empty string | Public Model alias; skip an invalid/colliding alias |
| `display_name` | string | Same alias; never use Pi marketing `name` as public identity |
| `supported_reasoning_levels` | array | Always present; exact policy in section 4 |
| `shell_type` | accepted shell enum | `"shell_command"` |
| `visibility` | accepted visibility enum | `"list"` for routed aliases |
| `supported_in_api` | boolean | `true` only after target callability is confirmed |
| `priority` | integer | Deterministic, collision-free routed ordering after native rows |
| `support_verbosity` | boolean | `false` until LuckyToken preserves `text.verbosity` end to end |
| `truncation_policy` | object | `{ "mode": "tokens", "limit": 10000 }` from the current bundled client contract |
| `experimental_supported_tools` | array | `[]` until a named experimental tool is supported and certified |

The CLI then requires at least one instruction source:

```text
base_instructions
OR
model_messages.instructions_template
```

For routed LuckyToken entries, `base_instructions` is the selected source. `model_messages` is not copied from a native model.

`description` is optional in the 0.149.0 parser; omission normalizes to `null`. LuckyToken should still emit a stable alias-oriented description for picker usability.

Every member of `supported_reasoning_levels` must contain both a string `effort` and a string `description`. An empty array is valid. The current parser accepts an arbitrary effort string, so parser acceptance does not make an effort semantically valid.

`truncation_policy.mode` is a closed enum: `"tokens"` or `"bytes"`. `input_modalities` is a closed enum: `"text"`, `"image"`, or `"audio"`. One `"video"` value caused the entire catalog to fail parsing.

### 3.3 Reproduced current failure

**Confirmed before the generator correction:** the existing file at `<CODEX_HOME>/luckytoken-model-catalog.json` contained routed non-reasoning rows without `supported_reasoning_levels`. A real isolated CLI invocation failed with:

```text
missing field `supported_reasoning_levels`
```

This rejects the entire catalog rather than only the bad row. Catalog validation is therefore an injection precondition, not a warning after injection.

## 4. Routed reasoning contract

### 4.1 Exact derivation

Calculate the advertised ladder as an intersection:

```text
PiSupported = getSupportedThinkingLevels(model) minus "off"
CodexVocabulary = efforts with valid descriptions in the installed bundled catalog
Advertised = PiSupported intersect CodexVocabulary
```

Rules:

1. If `model.reasoning === false`, emit `supported_reasoning_levels: []`.
2. If `model.reasoning === true`, use Pi's supported-level function; do not construct a fixed global ladder.
3. A `thinkingLevelMap` value of `null` removes that client effort.
4. `xhigh` and `max` appear only when Pi explicitly exposes them.
5. A level absent from the installed Codex vocabulary is omitted because LuckyToken cannot provide a current Codex description for it.
6. `off` is never advertised. LuckyToken currently degrades Responses `reasoning.effort: "none"` to omission, so it cannot promise an explicit-off control.
7. `ultra` is never synthesized. Pi's current thinking-level contract has no `ultra`; LuckyToken's Responses conversion degrades incoming `ultra` to `max`.
8. If the intersection is empty, emit `[]` and a generation warning. Do not invent a level.
9. Emit `default_reasoning_level` only when an authoritative model source supplies a default and that default is in the advertised ladder. Otherwise omit it.

Descriptions come from the installed Codex bundled catalog for the same effort. They are client vocabulary, not provider capability evidence.

## 5. Routed field policy

### 5.1 Always emitted

In addition to the required fields, routed entries must explicitly emit these conservative facts:

| Field | No information | Authoritative information available |
| --- | --- | --- |
| `description` | `LuckyToken model: <alias>` | May use another stable LuckyToken-owned alias description; do not expose credentials or private target state |
| `base_instructions` | LuckyToken neutral fallback: `You are Codex, a coding agent powered by the selected model.` | Reuse the installed Codex behavioral harness only after replacing native GPT/OpenAI identity claims with the neutral LuckyToken identity |
| `input_modalities` | `['text']` | Exact Pi `Model.input`, filtered to Codex-supported enum values |
| `context_window` | `128000` | Positive safe Pi `Model.contextWindow` |
| `max_context_window` | Same as `context_window` | Same as routed context unless a distinct routed maximum has its own authority |
| `effective_context_window_percent` | `95` | Installed Codex value if it remains valid |
| `supports_parallel_tool_calls` | `false` | `true` only after the provider/model and LuckyToken conversion are both certified |
| `supports_image_detail_original` | `false` | `true` only after original-detail semantics are preserved end to end; image input alone is insufficient |
| `supports_search_tool` | `false` | `true` only after LuckyToken supports the matching deferred discovery lifecycle |
| `supports_reasoning_summaries` | `false` | `true` only after request control and response summary semantics are certified |

`input_modalities` must be emitted even though it is optional to the parser. On 0.149.0, omission normalized to `['text','image']`, which can over-advertise vision.

### 5.2 Optional fields emitted only with proof

| Field | Proposed policy |
| --- | --- |
| `apply_patch_tool_type` | `"freeform"` is allowed because LuckyToken currently converts and round-trips freeform custom/apply-patch calls; keep an online apply-patch gate |
| `default_reasoning_level` | Emit only under section 4 rule 9 |
| `default_verbosity` | Omit while `support_verbosity` is false |
| `default_reasoning_summary` | Omit while summary controls are unsupported |
| `auto_compact_token_limit` | Omit unless LuckyToken intentionally owns a tested client compaction threshold |
| `prefer_websockets` / `supports_websockets` | Omit, or explicitly use `false`; never inherit native OpenAI WebSocket metadata |
| `include_apps_usage_instructions`, `include_plugin_usage_instructions`, `include_skills_usage_instructions` | Do not infer from model identity. Rely on installed Codex defaults until their routed prompt effect is explicitly tested |
| `multi_agent_version` | Omit until routed subagent behavior is independently certified |
| `node_repl_*` | Omit until the corresponding client surface is certified |

Runtime contract: on `codex-cli 0.149.0`, the built-in `openai` provider may first attempt a WebSocket Responses connection even when the routed catalog says `prefer_websockets: false`. The LuckyToken local listener is HTTP-only: while it is accepting traffic, every WebSocket upgrade receives `426 Upgrade Required` with code `websocket_transport_not_supported`, regardless of method or path. Codex treats that status as the signal to retry the turn over HTTP. Rejected upgrades do not enter runtime dispatch, authentication, model resolution, request accounting, or any data-plane lane. Non-WebSocket upgrade protocols retain the server's prior close behavior, and ordinary HTTP requests remain unchanged.

The catalog field is therefore a capability declaration, not a proven global transport-disable switch. LuckyToken does not add a fourth owned root config field to suppress this behavior.

Likewise, `supports_search_tool: false` prevents LuckyToken from advertising hosted search as a routed model capability, but it does not disable a user's independent global Codex web-search setting. LuckyToken continues to own only the three routing fields in section 7.

### 5.3 Forbidden inheritance and inference

Routed entries must not inherit or synthesize:

- native GPT/OpenAI identity text;
- `model_messages` copied from a native model;
- `availability_nux` or `upgrade` messages;
- `service_tier`, `service_tiers`, `default_service_tier`, or `additional_speed_tiers`;
- `use_responses_lite`;
- `tool_mode: "code_mode_only"` while LuckyToken rejects deferred `tool_search`/`defer_loading` lifecycles;
- `web_search_tool_type` while hosted web search is dropped by conversion;
- `comp_hash` without a real cache/version contract;
- reasoning `max/ultra`, verbosity, parallel tools, original image detail, search, summaries, audio, or video from model-name heuristics;
- a capability merely because a native Codex template contains it.

No hash or automatic config preimage is required by this contract.

## 6. Native and routed composition

### 6.1 Native rows

**Proposed:** preserve every valid bare-slug native row from the selected native snapshot without reconstructing or normalizing its semantic fields. Native identity belongs to Codex.

The bundled installed catalog remains the preferred source. The existing read-only `models_cache.json` fallback may preserve availability when the executable cannot be queried, but it never defines the routed parser contract. Any catalog built from the fallback must still pass the exact installed CLI preflight before injection.

LuckyToken must never write or invalidate `models_cache.json` under this contract. A Codex restart is the explicit refresh mechanism.

### 6.2 Routed rows

Only an explicit, currently callable Public Model alias is emitted. The order is deterministic:

1. preserved native rows in native-source order;
2. callable aliases sorted by alias;
3. deterministic routed priorities after the native priority range.

A native bare slug wins a collision. An alias with more than one `/` is excluded at the Codex projection boundary because the current metadata lookup cannot represent it reliably. The internal target remains the canonical `(providerId, modelId)` and is not inferred back from the alias.

The final document shape is:

```json
{
  "models": [
    { "...preserved native row...": true },
    { "...generated routed row...": true }
  ]
}
```

Generation is deterministic and the LuckyToken-owned file is atomically rewritten on every injection/sync.

## 7. Injection and restore boundary

### 7.1 Enable/sync

**Proposed sequence:**

1. Resolve the current LuckyToken endpoint, Public Model generation, native snapshot, and routed entries.
2. Build candidate catalog bytes without changing Codex files.
3. Run the parser and prompt-input gates in section 8 against the candidate.
4. If either gate fails, report failure and leave `config.toml` and the published catalog unchanged.
5. Atomically publish `<CODEX_HOME>/luckytoken-model-catalog.json`.
6. Converge exactly the three root fields to the active target.
7. Atomically publish `config.toml` and read it back.
8. Report `restartRequired: true`; never claim that an already-running Codex process reloaded the catalog.

The catalog path stored in TOML must resolve exactly to the LuckyToken-owned file inside the resolved Codex home. An absolute path is used so behavior does not depend on the launching process's working directory.

If root fields contain a malformed string assignment or the final readback does not match the target, fail with a visible conflict. Unrelated root fields, tables, comments, authentication files, and caches remain untouched.

### 7.2 Disable/shutdown

Restore is target-driven, not history-driven. The user configures:

```text
integrations.codex.preimage.modelProvider
integrations.codex.preimage.openaiBaseUrl
integrations.codex.preimage.modelCatalogJson
```

Each setting is independently interpreted:

| Setting value | Restore action |
| --- | --- |
| string | Set the corresponding root field to exactly that string |
| `null` / blank UI value | Remove the corresponding root field |

Defaults are all `null`: [settings catalog](../../src/settings/catalog.ts#L189). The UI intentionally maps an empty field to `null`: [Advanced settings](../../packages/desktop-shell/src/renderer/settings/AdvancedSettings.tsx#L91).

LuckyToken does not guess what was previously present and does not continuously update these restore targets from `config.toml`. Changing the configured preimage while the integration is enabled changes the next restore result by user choice.

After restore, read back all three root values before clearing managed state. The LuckyToken catalog file may remain on disk because the restored `model_catalog_json` no longer references it; it is LuckyToken-owned and will be overwritten by the next injection.

## 8. Validation gates

All gates are required. Passing a lower gate does not waive a higher one.

### Gate A: deterministic unit contract

Tests must prove:

- every routed row contains every required 0.149.0 field;
- non-reasoning rows carry `supported_reasoning_levels: []`;
- exact CommandCode ladders such as DeepSeek `high/max` are preserved;
- unsupported/null Pi levels are absent;
- no unproven `ultra`, verbosity, parallel, search, original-detail, service-tier, or WebSocket claim appears;
- modalities stay within `text/image/audio`, with no empty result;
- native rows remain unchanged;
- neutral base instructions contain no false native GPT identity;
- catalog generation is deterministic;
- failure before commit leaves both Codex files unchanged;
- enable produces the exact three root fields and disable restores all eight presence/value combinations for three nullable fields.

### Gate B: installed CLI parser

Use a process-specific temporary Codex home; never modify the user's real config during this gate.

Conceptual PowerShell invocation:

```powershell
$probeHome = Join-Path $env:TEMP "luckytoken-codex-catalog-probe"
$env:CODEX_HOME = $probeHome
codex -c 'model_catalog_json="<absolute candidate catalog path>"' debug models
```

Acceptance requires exit code 0, valid JSON output, every expected native/routed slug present exactly once, and no capability field normalized to a different meaning.

Do not use `--strict-config` with `codex debug`; 0.149.0 reports that this combination is unsupported.

### Gate C: model-visible prompt

For at least one routed non-reasoning model and one routed reasoning model:

```powershell
codex -m <alias> -c 'model_catalog_json="<absolute candidate catalog path>"' debug prompt-input "catalog contract probe"
```

Acceptance requires exit code 0 and confirms:

- the selected alias resolves;
- the supplied probe prompt appears in the model-visible input list;
- the expected Codex tool/prompt surface is generated.

On 0.149.0 this command renders the input list but does not echo the catalog's top-level `base_instructions`. Neutral identity and absence of the copied GPT identity are therefore verified directly on the generated entry in Gate A; they must not be inferred from absent `prompt-input` text.

### Gate D: staged three-field config

Create an isolated Codex home containing the candidate catalog and a `config.toml` with exactly the three active root fields plus any unrelated fixture content. Run `debug models` and `debug prompt-input` without overriding those three fields. Read the fixture back and prove that unrelated content remains byte-equivalent except for the three owned root assignments.

### Gate E: real online `codex exec`

This is the release gate and must use a newly launched real Codex CLI process against a running LuckyToken Data Plane. It must read the injected configuration; do not override `model_provider`, `openai_base_url`, or `model_catalog_json` on the command line.

Minimum scenarios:

1. Non-reasoning routed alias returns a non-empty final agent message with the expected marker.
2. A model with an exact reasoning ladder completes at one advertised effort, and LuckyToken's captured request proves the expected effective reasoning value.
3. Shell execution completes through the declared `shell_command` surface.
4. Freeform apply-patch completes and its call/output relationship round-trips.
5. One image-capable alias accepts an image; one text-only alias is not advertised as image-capable.

Use `codex exec --ephemeral --json -m <alias> ...` or a process-specific temporary `CODEX_HOME` to avoid persisting a user session. Success requires all of:

- CLI exit code 0;
- a completed turn event;
- a non-empty final agent message;
- LuckyToken capture shows the same public alias resolving to the expected canonical target;
- the upstream response completed rather than a fixture or cached response;
- no catalog/config parser warning occurred.

The existing real-client harness is reusable evidence for wire behavior: [online Codex CLI suite](../../test/online/run-codex-cli.ts). The injection certification must additionally omit routing-field overrides so the test proves the injected `config.toml` and `luckytoken-model-catalog.json`, not merely the endpoint.

### Gate F: restore

After the online gate:

1. disable the integration;
2. verify the three root fields equal the configured nullable preimage exactly;
3. launch a fresh `codex debug models` or harmless Codex command to prove the restored config parses;
4. confirm the LuckyToken catalog file is no longer referenced;
5. confirm no `models_cache.json`, native catalog, or auth file was changed by LuckyToken.

### Validation record: 2026-08-21

All gates were exercised with the installed `codex-cli 0.149.0`. Every run used a newly created temporary `CODEX_HOME`; the user's real Codex configuration, native catalog/cache, and authentication files were outside the test target. The online CLI received only `-m <public alias>` for routing, so `model_provider`, `openai_base_url`, and `model_catalog_json` came from the injected `config.toml` rather than command-line overrides.

| Routed case | Observed catalog fact | Real CLI result |
| --- | --- | --- |
| DeepSeek V4 Flash basic | reasoning `high/max`, text input | passed |
| MiniMax M2.5 basic | `supported_reasoning_levels: []`, text input | passed |
| DeepSeek V4 Flash reasoning | selected `high`; captured request retained `reasoning.effort: high` | passed |
| DeepSeek V4 Flash shell | `shell_type: shell_command` | passed |
| DeepSeek V4 Flash apply patch | `apply_patch_tool_type: freeform` | passed |
| Qwen 3.8 Max image | reasoning `low/medium/xhigh`, text/image input | passed |

Each enable first passed the installed-CLI parser and prompt preflight against the complete candidate catalog. Each disable restored the three nullable preimage values to `null` by removing those root fields while preserving unrelated fixture configuration. Codex itself appended a project trust table during some runs; restore deliberately preserved that unrelated Codex-owned change.

Some first online attempts received an upstream CommandCode `502` timeout and passed unchanged on retry. Those failures occurred after catalog/config parsing and routing; they are external provider availability evidence, not catalog schema failures.

## 9. Version drift policy

The parser contract is versioned by the installed Codex runtime, not by this document alone.

On every supported Codex CLI upgrade:

1. record `codex --version`;
2. capture and inspect `codex debug models --bundled`;
3. rerun the incremental minimal-entry parser probe;
4. update required fields and enum normalization tests only from observed evidence;
5. rerun Gates A through F.

Official OpenAI model documentation is a useful capability cross-check, but no public page located during this investigation documented the external `model_catalog_json` entry schema. Therefore current CLI behavior remains the primary parser evidence.

## 10. Completion criterion

The Codex synchronization feature is complete only when:

- the generated catalog follows sections 3 through 6;
- preflight failure changes no active Codex routing state;
- the three root fields converge and read back exactly;
- a new real CLI process completes the online scenarios through LuckyToken;
- disabling restores the user-configured nullable preimage exactly; and
- evidence shows LuckyToken did not modify Codex native catalogs, caches, or authentication state.

Gates A through F passed on `codex-cli 0.149.0` using the validation record above. A different installed Codex version must be re-certified under section 9; parser preflight remains mandatory before every publish.
