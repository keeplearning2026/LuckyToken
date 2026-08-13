# 15 — Complete Responses function/custom/namespace tool lifecycles

**What to build:** Function, custom, and namespace tools/calls/results round-trip through Pi with safe argument handling, reversible family identity, and Responses-owned lifecycle repair.

**Blocked by:** 01 — configuration; 02 — notices/journal; 13 — Responses prompts/options/handles.

**Status:** ready-for-agent

## Module seam

Tool definition conversion, call/result correlation, namespace flattening, reverse render metadata, and missing-result repair remain private inside the Responses adapter. The external request conversion interface returns only Pi tools/messages plus opaque Responses render state.

## Information lifecycle

Correlation and reverse-family maps are request-local and destroyed after response rendering/state storage. Flattened names never become a process-global registry. Synthetic results close only known missing calls.

## Acceptance criteria

- [ ] Function definitions preserve name/description/parameters/strict into Pi Tool.
- [ ] Custom definitions use the approved freeform object schema; Lark/regex grammar maps to Pi constrainedSampling variants.
- [ ] Function arguments: missing/blank→{}; valid object→lossless object; invalid JSON/non-object→conversion error.
- [ ] Custom call freeform input maps to `{input:string}` with a Responses-local notice and reverses to custom output family.
- [ ] Namespace uses a reversible Responses-owned naming scheme, supports function/custom children, detects collisions, and retains reverse metadata only in render state.
- [ ] status absent/completed is eligible; in_progress/incomplete/unknown structured status errors.
- [ ] Duplicate result fixed error; orphan output follows Responses-local error|ignore default error; ignore emits notice.
- [ ] Unresolved call follows Responses-local error|xrepair default xrepair using its own frozen literal/helper/tests.
- [ ] Real result identity/content/error semantics are never altered by repair.
- [ ] Output images remain Pi ToolResult images on the Client side.
- [ ] Tests cover round-trip family reversal, collisions, argument cases, orphan/duplicate/unresolved, multiple calls, ordering, and concurrency.
- [ ] No Anthropic/CommandCode repair helper or configuration is imported.

## Out of scope

Hosted/BYOT family classification beyond function/custom/namespace (16).

