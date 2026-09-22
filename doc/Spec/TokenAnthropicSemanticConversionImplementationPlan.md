# Anthropic Messages Semantic Conversion Implementation Record

Status: **IMPLEMENTED HISTORICAL PLAN — current runtime boundary is clean upstream Pi AI 0.87.0**

## Delivered structure

```text
request.ts
  → semantic/source-validation.ts
  → semantic/source-semantics.ts
  → semantic/invocation.ts
  → semantic/reasoning/*
  → semantic/execution.ts
  → neutral execution capability
  → Pi Models
response.ts / sse.ts
```

Deleted:

- `semantic/projection/`;
- `semantic/supplement/`;
- `semantic/pi-execution.ts`;
- target Provider registry and payload outcome types;
- projector-only and Client-mutated final-wire fixtures.

Source parsing helpers formerly colocated with Supplement were retained under names that
describe their actual responsibility: immutable JSON, source validation, and source
semantics.

## Request behavior

The converter emits Pi `Context`, Pi public options, and Anthropic-owned response or
continuity state. It maps initial system text, supported messages/images, ordinary tools,
tool relationships, max output, temperature, basic tool choice, and reasoning.

Provider-private preferences warn and remain outside Pi. Required, named, and serial
tool constraints map to Pi's neutral `toolChoice`/`parallelToolCalls` contract. Tool
references that imply mid-conversation catalog changes, invalid tool relationships, and
non-degradable content fail before dispatch.

## Reasoning behavior

- omission requests no Pi reasoning level; the selected Pi adapter determines the resulting thinking/off/default behavior;
- disabled thinking is omitted from Pi reasoning options with a bounded warning because clean Pi 0.87 exposes no neutral explicit-off value;
- enabled/adaptive effort uses resolved model metadata and Pi selection helpers;
- opaque thinking/text/tool signatures restore only under matching provenance;
- incompatible opaque state is discarded while visible content is preserved.

No reasoning code sees a Provider request object.

## Execution behavior

The protocol coordinator calls the neutral execution operation with Pi Context/options.
It does not create `onPayload`. Diagnostics use a separate immutable fail-open
observation capability.

## Verification

Required suites:

1. Anthropic Wire → Pi invocation tests;
2. Pi `AssistantMessage` → Anthropic JSON/SSE tests;
3. pinned Pi parser certification;
4. complete-history continuity replay through pinned Pi adapters;
5. CommandCode Private exact-wire and Anthropic online certification;
6. architecture guards proving projector/supplement deletion and boundary direction.

Any future Anthropic field must first receive one disposition in the Anthropic
architecture ledger. Reintroducing a target projector is forbidden.
