# 09 — Convert tools, strict semantics, and the frozen schema subset

**What to build:** Convert every accepted Anthropic client tool into a truthful Pi tool and onward CommandCode definition, preserving schema semantics and strict enforcement requirements while rejecting source-invalid schemas separately from source-valid unsupported features.

**Blocked by:** 05 — Implement Anthropic source-profile and closed-world validation.

**Status:** complete

- [x] Tool name is exact, present description is exact, and omitted description uses only the frozen required-shape projection.
- [x] Tool fields are allowlisted; cache, caller, deferred-loading, eager-input, examples, server-tool, and future behavioral controls are rejected unless explicitly supported.
- [x] Source-schema validity is evaluated before the LuckyToken subset check and retains `InvalidRequest` ownership.
- [x] The exact recursive v1 keyword allowlist is enforced at every schema-valued position, including schema-valued `additionalProperties`.
- [x] `enum`, `const`, `default`, and `examples` remain value data and are not recursively reinterpreted as schemas.
- [x] Source-valid unsupported schema features such as references, compositions, formats, type arrays, cycles, and unknown semantic keywords produce `UnsupportedFeature` without silent deletion.
- [x] Request-wide strict limits of 20 tools, 24 optional parameters, and 16 union parameters are counted across participating strict schemas.
- [x] `strict=true` maps to Pi JSON-schema constrained sampling with `require`; false/omitted remains absent and is never downgraded based on target capability.
- [x] CommandCode wire definitions contain only name, description, and the complete accepted input schema.
