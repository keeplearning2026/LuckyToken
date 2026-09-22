# Token Reasoning Effort Unification Plan

Status: **SUPERSEDED — current runtime boundary is clean upstream Pi AI 0.87.0**

This document is retained only as a decision record. Its former Client Protocol target
projectors, Provider payload repair, and semantic `onPayload` lifecycle are not part of
the current architecture.

The following decisions remain current:

1. `Model.thinkingLevelMap` is the reasoning level data authority.
2. Pi public `getSupportedThinkingLevels()` and `clampThinkingLevel()` are the selection
   mechanics authority.
3. Availability is preferred: unsupported enabled reasoning degrades to ordinary
   generation or Provider default with a warning unless the Client contract makes the
   constraint mandatory.
4. Omission, explicit disable, and enabled level are distinct:

   ```text
   reasoning omitted → Provider/model default
   reasoning "off"  → explicit disable
   reasoning level  → resolved-model selection and Provider-native mapping
   ```

5. Provider-native fields such as `reasoning_effort`, `thinking`,
   `output_config.effort`, and Google thinking configuration belong exclusively to Pi
   Provider/API adapters.
6. Historical reasoning and opaque continuity remain Client-protocol codecs over Pi
   semantic content fields; they never mutate Provider requests.
7. The Client output-token value is a hard total output ceiling and must not be widened
   by reasoning budget allocation or Provider minimums.

Current normative sources:

- `TokenSemanticConversionArchitectureSpec.md`;
- `TokenOpenAIResponsesSemanticConversionArchitectureSpec.md`;
- `TokenAnthropicSemanticConversionArchitectureSpec.md`;
- `TokenPiAI0861BoundaryConvergenceRefactoringPlan.md`.
