# 07 — Map Anthropic sampling, thinking budgets, and cache policy

**What to build:** Anthropic request controls that Pi can represent reach the selected model as Pi options; unsupported auxiliary controls degrade without breaking the main conversation and without claiming false defaults.

**Blocked by:** 01 — adapter-owned configuration; 02 — request-local notices; 04 — complete Pi options composer.

**Status:** completed

## Module seam

Anthropic owns source parsing and mapping into Pi option facts. The neutral composer validates only Pi. Keep effort/budget precedence, cache marker folding, and Anthropic nullability inside this adapter.

## Information lifecycle

Wire controls are normalized once into Pi values. Local cache-breakpoint positions disappear after policy evaluation. Dropped controls are neither copied into messages nor retained in Provider-facing metadata.

## Acceptance criteria

- [x] top_p/top_k map to Pi samplingParams and survive composition.
- [x] metadata.user_id maps to Pi metadata; null/absence omits it.
- [x] output_config.effort low–max maps exactly to Pi reasoning; null/absence omits.
- [x] thinking.enabled validates budget, chooses level by frozen precedence/ladder, and preserves exact budget in the normalized Pi thinkingBudgets key.
- [x] xhigh/max budgets use the high budget slot while reasoning retains xhigh/max.
- [x] thinking.disabled/adaptive/display apply documented omission/drop semantics without fabricating off or injecting text.
- [x] local cache controls use Anthropic-local `ignore|promote`, default ignore; promote folds 1h→long and otherwise 5m/default→short and emits notice.
- [x] stop_sequences, unsupported tool_choice controls, output format, container, inference_geo, and service_tier drop without blocking the core request.
- [x] Source nullability and invalid numeric bounds produce Anthropic Client errors, never composition 500s.
- [x] Tests assert the final immutable Pi options snapshot for every branch.
- [x] No Responses effort/cache policy is imported or consulted.

## Out of scope

Provider interpretation/clamping after the Pi seam.
