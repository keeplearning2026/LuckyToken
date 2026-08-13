# 14 — Convert Responses text, images, files, and reasoning continuity

**What to build:** Responses text/refusal/image/reasoning history reaches Pi without silent loss, invented placeholders, or cross-authority opaque replay.

**Blocked by:** 02 — notices/journal; 13 — Responses prompts/options/handles.

**Status:** completed

## Module seam

Content parsing/materialization is private to the Responses request converter. Image/resource resolution uses narrow injected ports with production and test adapters. Reasoning continuity uses a Responses-owned versioned envelope; its schema is not a general Pi signature framework.

## Information lifecycle

Inline/resolved bytes become Pi ImageContent and source handles are discarded. Generic files are dropped/recorded without entering Provider metadata. Opaque reasoning state is wrapped with adapter provenance and only unwrapped by the same authority.

## Acceptance criteria

- [x] input_text/output_text/message strings map exactly; refusal preserves visible text.
- [x] message phase is stored in a versioned Responses-owned text signature, not injected into model text.
- [x] Valid base64 data images map bytes/MIME exactly; malformed base64/MIME errors.
- [x] file_id/remote image URL requires trusted Responses-owned resolver with auth scope, abort, redirect, timeout, byte and MIME controls; missing resolver errors.
- [x] Generic non-image input_file drops/records without fabricated marker; provable image file may materialize to Pi image.
- [x] Readable reasoning becomes Pi ThinkingContent.
- [x] Responses-native continuity state enters a versioned provenance-bearing thinkingSignature.
- [x] Only a verified current-adapter/authority envelope restores encrypted_content; arbitrary Provider signatures never do.
- [x] Reasoning-only assistant messages are preserved; trailing reasoning never disappears.
- [x] status absent/completed converts; in_progress errors; incomplete preserves representable text/reasoning plus non-model-visible diagnostic and never injects notice text or guesses length.
- [x] Tests cover resolver failures, size/MIME/redirect/abort, provenance mismatch, reasoning-only history, and no cross-request state.
- [x] No Anthropic signature/content helper is reused.

## Out of scope

Structured tool calls/results (15–16) and response rendering (17).

