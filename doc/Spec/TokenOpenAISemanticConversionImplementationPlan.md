# OpenAI Responses Semantic Conversion Implementation Record

Status: **IMPLEMENTED — Pi AI 0.86.1 boundary convergence**

## Delivered structure

```text
request.ts
  → semantic/invocation.ts
  → semantic/reasoning/* (Pi semantics and continuity only)
  → semantic/execution.ts
  → neutral execution capability
  → Pi Models
response.ts / sse.ts
```

Deleted:

- `semantic/projection/`;
- `semantic/supplement/`;
- `semantic/pi-execution.ts`;
- reasoning payload projection;
- target Provider registry and payload outcome types;
- final-wire fixtures whose correctness depended on Client payload mutation.

## Request behavior

The converter emits Pi `Context`, Pi public options, and Responses-owned render or
continuity state. It maps messages, tools, reasoning, max output, temperature, cache
retention, and basic tool choice only where Pi has a neutral contract.

Unrepresentable optional controls warn and remain outside Pi. Required/named/hosted tool
choice and critical tool identity/history failures reject before dispatch. Client
metadata remains response echo/state only.

## Reasoning behavior

- omitted effort: Provider default;
- `none`: Pi `reasoning: "off"`;
- enabled effort: resolved model `thinkingLevelMap` plus Pi selection helpers;
- historical visible reasoning and opaque continuity: Pi content/signature fields with
  provenance checks;
- summary preference: omission warning until Pi defines a neutral option.

No reasoning code sees a Provider payload.

## Execution behavior

The protocol coordinator prepares Pi semantics and calls the neutral execution operation.
It does not create `onPayload`. Request/response evidence is supplied as a separate
infrastructure observation capability that cannot mutate execution.

## Verification

Required suites:

1. Responses Client Wire → Pi invocation tests;
2. Pi `AssistantMessage` → Responses JSON/SSE tests;
3. complete-history continuity replay through pinned Pi adapters;
4. CommandCode Private Provider exact-wire tests;
5. real Codex CLI fixture replay and online Responses certification;
6. architecture guards proving projector/supplement deletion and import direction.

Any future Responses field must first receive one disposition in the Responses
architecture ledger. Reintroducing a target projector is not an extension mechanism.
