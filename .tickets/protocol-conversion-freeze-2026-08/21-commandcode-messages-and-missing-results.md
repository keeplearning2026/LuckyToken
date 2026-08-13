# 21 — Convert Pi messages and CommandCode-local missing results

**What to build:** Pi history becomes valid ordered CommandCode messages while preserving all representable content and ToolResult identity/error semantics; CommandCode adjacency repair remains wholly Provider-local.

**Blocked by:** 02 — notices/journal; 20 — scalar options/synchronous execution.

**Status:** ready-for-agent

## Module seam

Message conversion is private implementation inside the CommandCode request module. Its only input is Pi Context; its output is CommandCode messages. Do not expose or accept Client Protocol repair/configuration.

## Information lifecycle

Pending call state contains ID/name/order only and dies after request construction. Pi historical stopReason/provenance is consumed/dropped after content conversion. Synthetic results exist only in the target message list and a Provider-local notice.

## Acceptance criteria

- [ ] Every historical AssistantMessage stopReason value, including pending/error/aborted/deferred/future runtime strings, is ignored as a targetless field while content is still converted.
- [ ] Text, ordinary thinking, and ToolCall content preserve order and target-valid values.
- [ ] Redacted thinking/signatures/provenance with no target representation drop without fabricating plaintext; other message content remains.
- [ ] ToolCall preserves ID/name/lossless object arguments; malformed content still errors independently of stopReason.
- [ ] Real ToolResult preserves toolCallId and non-empty toolName.
- [ ] Real isError=false maps text; isError=true maps error-text; real content is never replaced by synthetic policy.
- [ ] ToolResult images drop, text remains; image-only result emits empty string and remains paired.
- [ ] Missing result repair triggers only for a known unresolved call at adjacency/history boundaries and uses Provider-local configured text|error-text default text.
- [ ] Synthetic result uses pending call ID/name and exactly `No result — the tool call did not complete (interrupted or lost).`; it never repairs orphan/duplicate/mismatched results.
- [ ] Tests cover all historical stop reasons, mixed content, real/synthetic results, image-only, multiple calls, malformed states, and ordering.
- [ ] No Client Protocol repair code/config/state is imported.

## Out of scope

Client-side lifecycle repair and Tool definitions (22).
