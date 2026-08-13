# 15 — Complete Responses function/custom/namespace tool lifecycles

**What to build:** Function, custom, and namespace tools/calls/results round-trip through Pi with safe argument handling, reversible family identity, and Responses-owned lifecycle repair.

**Blocked by:** 01 — configuration; 02 — notices/journal; 13 — Responses prompts/options/handles.

**Status:** completed

## Module seam

Tool definition conversion, call/result correlation, namespace flattening, reverse render metadata, and missing-result repair remain private inside the Responses adapter. The external request conversion interface returns only Pi tools/messages plus opaque Responses render state.

## Information lifecycle

Correlation and reverse-family maps are request-local and destroyed after response rendering/state storage. Flattened names never become a process-global registry. Synthetic results close only known missing calls.

## Acceptance criteria

- [x] Function definitions preserve name/description/parameters/strict into Pi Tool.
- [x] Custom definitions use the approved freeform object schema; Lark/regex grammar maps to Pi constrainedSampling variants.
- [x] Function arguments: missing/blank→{}; valid object→lossless object; invalid JSON/non-object→conversion error.
- [x] Custom call freeform input maps to `{input:string}` with a Responses-local notice and reverses to custom output family.
- [x] Namespace uses a reversible Responses-owned naming scheme, supports function/custom children, detects collisions, and retains reverse metadata only in render state.
- [x] status absent/completed is eligible; in_progress/incomplete/unknown structured status errors.
- [x] Duplicate result fixed error; orphan output follows Responses-local error|ignore default error; ignore emits notice.
- [x] Unresolved call follows Responses-local error|xrepair default xrepair using its own frozen literal/helper/tests.
- [x] Real result identity/content/error semantics are never altered by repair.
- [x] Output images remain Pi ToolResult images on the Client side.
- [x] Tests cover round-trip family reversal, collisions, argument cases, orphan/duplicate/unresolved, multiple calls, ordering, and concurrency.
- [x] No Anthropic/CommandCode repair helper or configuration is imported.

## Out of scope

Hosted/BYOT family classification beyond function/custom/namespace (16).

