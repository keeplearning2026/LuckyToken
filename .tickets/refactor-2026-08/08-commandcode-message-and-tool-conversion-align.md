# 08 — Align CommandCode user/assistant/tool-result messages and tools
#
# with the conversion method

**What to build:** Pi `UserMessage`, `AssistantMessage`, `ToolResultMessage`,
and `Context.tools` are converted into CommandCode `params.messages`/
`params.tools` blocks with the exact target shapes and fidelity rules of
`PI AI IR-Commandcode Private Conversion.md` Part I §6–§8 and §10.

**Blocked by:** 07 — CommandCode params scalar controls.

**Status:** ready-for-agent

- [ ] `UserMessage` (§6): string content → one TextBlock; structured content
  iterated in source order (no merging/reordering/removal of empty text);
  `ImageContent → ImageBlock` only when `Model.input` includes `"image"`
  (else error, never drop/convert); `image` is the complete data URL
  `data:<mimeType>;base64,<data>` built from the same authoritative
  `mimeType` used for the `mimeType` field; no re-encode/fetch/upload.
- [ ] `AssistantMessage` (§7): TextContent → TextBlock; ThinkingContent →
  ReasoningBlock only when `redacted !== true` (redacted → error, never
  dropped or converted); `ToolCall → ToolCallBlock` with
  `toolCallId/id`, `toolName/name`, `input = losslessJsonObject(arguments)`;
  `namespace` present → error; duplicate `toolCallId` in one assistant
  message → error; historical `toolName` not re-validated against current
  tools.
- [ ] `ToolResultMessage` (§8): each Pi result becomes one CommandCode
  `ToolMessage` with one `ToolResultBlock`; `toolName` is canonical `""`
  (never sourced from Pi); `output.type` from `isError`
  (`false→"text"`, `true→"error-text"`); `output.value` = all-text content
  joined with `"\n"` (empty content → `""`); any `ImageContent` in a tool
  result → error (no image representation).
- [ ] `params.tools` (§10): absent `Context.tools` → `[]`; each Pi Tool →
  `{name, description, input_schema}` preserving source order; parameters
  passed through as JSON Schema without rewrite; `constrainedSampling`
  absent/false → ordinary tool; `json_schema + strict:"prefer"` → ordinary
  tool (fallback, no error); `json_schema + strict:"require"` → error
  (CommandCode has no proven equivalent capability); `grammar` → ordinary
  tool (Pi-defined unsupported-provider fallback, no error).
- [ ] No silent JSON loss anywhere (arguments/parameters must serialize
  losslessly; failures are errors).
- [ ] Unit tests cover each block conversion, capability gates, fidelity
  errors, and ordering preservation.

**Out of scope:** cross-message tool-call/result sequence (09), assembly
(10), response reconstruction (11).
