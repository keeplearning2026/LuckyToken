# 20 — Close Pi runtime fidelity gaps for the certified route

**What to build:** Patch Pi at the owning layer or narrow the accepted route whenever current Pi behavior changes an accepted Anthropic/CommandCode semantic, so the LuckyToken converters remain direct and do not compensate through guessing or a second IR.

**Blocked by:** 07 — Convert conversation text, images, and history; 08 — Convert and validate tool-use and tool-result turns; 09 — Convert tools, strict semantics, and the frozen schema subset; 10 — Compose closed-world Pi invocation options; 15 — Convert committed CommandCode results into a Pi lifecycle; 17 — Render schema-complete Anthropic JSON success.

**Status:** ready-for-agent

- [ ] The accepted max-token value reaches the Provider unchanged, or the accepted request surface is narrowed so shared context clamping is provably identity.
- [ ] Accepted history is not changed by image placeholder insertion, cross-model thinking transformation, tool-ID normalization, synthetic orphan results, or whitespace filtering.
- [ ] Every accepted tool schema keyword reaches the model-visible upstream schema; non-strict conversion does not truncate it to type/properties/required.
- [ ] Generic v1 excludes auth paths that inject or rewrite model-visible system, tool, or conversation semantics.
- [ ] Provider tool-ID adaptation is injective or collision-detecting and preserves result correlation and order.
- [ ] Runtime tool arguments are object-tree validated at completion despite Pi's permissive streaming parser.
- [ ] Every reachable client-visible termination semantic is preserved through Pi with required companion state, or is proven unreachable; refusal and model-context-window exhaustion are explicitly resolved.
- [ ] Thinking, citations, server-tool caller state, container/service/inference metadata, and opaque provenance are either faithful, replay-inert/reconstructible, or unreachable on the certified route.
- [ ] Changes to reference/Pi-owned code are the smallest coherent upstream-style patch set with provenance and focused regression tests; unrelated Agent/TUI/session code remains untouched.

