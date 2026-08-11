# 07 — Align CommandCode params scalar controls with the conversion method

**What to build:** The Pi `Model`, `Context`, and `SimpleStreamOptions`
produce the CommandCode `GenerateParams` scalar fields — `model`, `system`,
`max_tokens`, `stream`, `temperature`, `reasoning_effort` — with the exact
absence/default/error rules of `PI AI IR-Commandcode Private Conversion.md`
Part I §5.

**Blocked by:** 06 — CommandCode request headers, config, and top-level
fields.

**Status:** ready-for-agent

- [ ] `params.model = model.id`; never composed from `provider/api` or other
  identity fields; invalid model id → error.
- [ ] `params.system = context.systemPrompt` exactly when present (including
  empty string); absent → omit; no prefix/suffix/system additions.
- [ ] `params.max_tokens = options.maxTokens` when present and valid;
  absent → **64000** (CommandCode target default); never `model.maxTokens`
  fallback and no shared context-window clamp; invalid → error.
- [ ] `params.stream` is fixed literal `true`; no `stream:false` target.
- [ ] `params.temperature` preserves `0` (never omitted because falsy);
  absent → omit; non-finite → error.
- [ ] `reasoning_effort` construction: absent `options.reasoning` → omit;
  present → `clampThinkingLevel(model, level)`; `"off"` → omit; effective
  level → explicit `model.thinkingLevelMap?.[level]` first, else
  `minimal→low, low→low, medium→medium, high→high, xhigh→xhigh, max→max`;
  no extra `supportedReasoningEfforts` inventory; invalid explicit mapping →
  error.
- [ ] Uses Pi's `getSupportedThinkingLevels`/`clampThinkingLevel` public
  contracts; CommandCode conversion only maps the effective Pi level.
- [ ] Unit tests cover absence, defaults, `0`/`""` preservation, invalid
  values, and every thinking-level mapping branch.

**Out of scope:** messages/tools (08), sequence (09), assembly/serialization
(10).
