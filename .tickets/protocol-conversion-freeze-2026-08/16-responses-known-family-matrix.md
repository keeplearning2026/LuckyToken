# 16 — Cover every known Responses input-item and tool family

**What to build:** Every installed Responses input-item and tool-definition discriminator has a tested exact, degradation, drop, resolver, or error outcome based on execution ownership—not Provider/tool-name guesses.

**Blocked by:** 14 — content/reasoning; 15 — core tool lifecycle.

**Status:** ready-for-agent

## Module seam

Keep the complete family table private to the Responses adapter. It may dispatch to private content/tool classifiers, but callers still use one request conversion interface. Do not expose one handler per discriminator through composition.

## Information lifecycle

Provider-hosted lifecycle metadata is consumed and discarded after ordered content/transcript creation. Client/BYOT calls enter the request-local lifecycle map. Resolver state never crosses Pi. The classified executable catalog is frozen for the invocation.

## Acceptance criteria

- [ ] Tests enumerate the complete installed 23-family input-item union so a new SDK family causes an explicit review failure.
- [ ] Messages, reasoning, function/custom, compaction, and item_reference use tickets 13–15 rules.
- [ ] local_shell, shell, and apply_patch Client/BYOT calls/results become structured Pi ToolCall/ToolResult with complete lifecycle validation.
- [ ] computer and client MCP use structural mapping only when execution ownership is Client/BYOT; provider-hosted forms degrade to ordered content/transcript.
- [ ] file/web/image/code-interpreter hosted history preserves representable results/transcript and never advertises executable Pi tools.
- [ ] MCP list/approval lifecycle preserves model-visible decision text only; pure metadata drops; credentials/headers never enter Pi.
- [ ] tool_search call/output and defer-loading discovery are Core conversion errors.
- [ ] Tests enumerate the installed 15-family tool-definition union and verify function/custom/namespace/local shell/shell/apply patch/client-owned tools vs hosted drops.
- [ ] Forced tool choice depending on a dropped hosted tool errors instead of claiming compliance.
- [ ] Known malformed and future unknown remain distinct; extension families require explicit profile entries.
- [ ] No concrete Provider identity or Anthropic classification appears in implementation/tests.

## Out of scope

Future SDK families not yet installed; they intentionally trigger review.

