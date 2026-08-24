---
status: accepted
---

# Preserve Anthropic conversion usability without inventing semantics

Anthropic Messages Semantic Conversion accepts bounded loss for non-critical request preferences so that selecting a less capable target does not make ordinary requests unusable: Pi owns audited common-option mappings, unsupported stop sequences and optional supplement facts are omitted with warnings, and responses are rendered only from Pi `AssistantMessage`. The existing converter first produces the strongest Pi IR/options, while a complete supplement preserves only the validated facts Pi cannot carry; the wrapper then selects an Adapter that projects only its proven subset, without requiring a target/field cross-product or no-op Adapters. LuckyToken still fails before dispatch for malformed source state, unsupported server tools and other critical semantics, or an audited `onPayload` projector receiving an incompatible payload shape; it never guesses a repair, simulates stopping in prompts/responses, or treats an empty thinking signature as exact continuity.
