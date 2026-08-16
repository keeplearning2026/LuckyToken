# 10 — Pinned Pi modelOverrides, headers, and authentication compatibility

## Parent

[GitHub Issue #1](https://github.com/keeplearning2026/LuckyToken/issues/1)

**What to build:** Complete static models.json behavior for modelOverrides, Provider/model headers, compat controls, authHeader, supported OAuth declarations, and API/base URL precedence. A valid configuration produces the same callable Provider/model facts and relevant errors as the pinned Pi implementation.

**Blocked by:** 09 — Pinned Pi Provider overlay and model-upsert compatibility.

**Status:** accepted-pending-wave-validation

## Implementation method

Use the `$tdd` skill. Confirm models.json apply and effective catalog queries as the public seams, with a controlled Provider invocation only where effective request behavior must be observed. Work one compatibility rule per red → green cycle.

## Acceptance criteria

- [x] modelOverrides select and apply to their intended canonical models with pinned Pi merge and precedence semantics.
- [x] Provider-level and model-level headers merge or override exactly as the pinned baseline specifies.
- [x] compat fields retain their pinned schema meaning and are not generalized into unrelated LuckyToken flags.
- [x] authHeader affects Provider-facing authentication construction without entering Client Protocol or model-visible semantic state.
- [x] Supported OAuth/auth declarations compose without hardcoding Provider-specific flows in LuckyToken configuration code.
- [x] Explicit API/base URL fields follow the pinned built-in, Provider, model, and environment precedence rules.
- [x] Secret-source configuration is never copied into public catalog projections, Diagnostics, or errors.
- [x] A pinned compatibility matrix covers field combinations, deletion/absence, precedence conflicts, invalid forms, and effective controlled invocation facts.
