# Diagnostics v5 verification

Date: 2026-09-30. Scope: the unredacted-body revision of
[TokenRequestJourneyDiagnosticsSpec](../Spec/TokenRequestJourneyDiagnosticsSpec.md).

## Result

The implementation uses one current v5 store and Control Plane v8. Body files
preserve complete boundary bytes; object artifacts preserve bounded boundary
snapshots. Retained folders are `full-journeys-v5/YYYY-MM-DD/<requestId>/`, where
the date is UTC admission time and the folder name is the exact request ID.
No older-store reader, migration, dual writer, body redactor, obsolete descriptor
field, or artifact `partial` state remains in production.

Offline release gates passed, including the final write-fault/retention,
manifest/UI, settings-snapshot, and obsolete-wire rejection assertions.
Online capture validation passed for all ten exchanges. Eight exchanges succeeded;
both Anthropic Native exchanges received an upstream 403. Its live success path
is unverified, and the online runner intentionally exits nonzero for that gap.
This report does not attribute the 403 to a particular subscription or credential
policy because that cause was not independently established.

## Offline evidence

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `git diff --check`: passed.
- Composed HTTP matrix: five protocol/lane combinations × four switch combinations,
  each covering success, failure, actual connection cancellation, and an externally
  owned interruption seal while the real lane is active. Twenty matrix tests passed.
- Raw artifact tests: exact JSON/JSONL/SSE bytes, duplicate keys, invalid syntax,
  malformed UTF-8, empty body, binary/unsupported media, incomplete capture,
  acquisition limits, unsafe directory IDs, provisional writes and cleanup,
  raw Control Plane reads, SQLite-only backup, and exclusion of synthetic older data.
- Fault/retention tests: actual file-write and rename faults preserve serving,
  worker crash/unavailability/stalls/saturation remain contained, and age/count/disk
  eviction removes saved bodies while retaining historical descriptor counts.
- The assembled release Backend was rebuilt with the same current contracts.
- Targeted diagnostics/Journey/contract suite: 51 files, 191 tests passed.
- Final `npm test`: 75 release/architecture certifications, 291 Backend test
  files (2699 tests), and 21 Desktop test files (145 tests) passed.

All state-reaching processes used repository sandbox leases and temporary
`CODEX_HOME`. Test data, compiler output, credentials, and captures were removed
by their owners in `finally`; no user auth, native catalogs, sessions, or caches
were copied.

## Live Commandcode evidence

Command: `npm run test:online-diagnostics`.
Credential input: `CommandcodeAPIKey.txt`, read only in memory and never logged.
Each row ran with `stream=false` and `stream=true`.

| Client Protocol / lane | Model / transport | JSON / streaming HTTP | Evidence per exchange |
|---|---|---|---|
| Responses / Direct | `deepseek/deepseek-v4.1-flash`, Commandcode gateway fixture | 200 / 200 | 4 byte artifacts |
| Responses / Provider Native | `commandcode-goat/deepseek/deepseek-v4.1-flash` | 200 / 200 | 5 byte artifacts |
| Responses / Semantic | `commandcode-private/deepseek/deepseek-v4.1-flash` | 200 / 200 | 2 client wires + request payload + terminal Pi IR |
| Anthropic / Provider Native | Anthropic model fixture `claude-haiku-4-5-20251001` at Commandcode Messages gateway | 403 / 403 | 4 byte artifacts; truthful failed outcome |
| Anthropic / Semantic | `commandcode-private/deepseek/deepseek-v4.1-flash` | 200 / 200 | 2 client wires + request payload + terminal Pi IR |

Each exchange reopened the persisted files and compared them byte for byte with
the test's client/transport boundary. Semantic payload and terminal IR were
compared with their public Pi boundary snapshots. Explicit artifact reads were
base64-decoded before comparison. Checks also verified exact request-ID directory
names, omitted credential values in safe envelopes, absence of body canaries and
the API key from facts and SQLite/WAL/SHM, and absence of Semantic upstream-wire
collection. The streaming 403 cases are JSON error evidence, not successful SSE.

The Direct check uses a test-only URL gateway from Direct's fixed endpoint to
`https://api.commandcode.ai/provider/v1/responses`. Node fetch decodes compression,
so this gateway drops the remote compressed length/encoding headers before handing
those decoded bytes to Direct. It changes no production transport. This proves
Direct composition and capture over a live gateway, not access to the actual
Codex endpoint. Anthropic Native uses an existing certified `anthropic` model
fixture at `https://api.commandcode.ai/provider`; no production certification
entry or capture point was added to enable it.

The online helper compiles the current sources with TypeScript before running
them, matching release execution of the serialized diagnostics actor. It avoids
tsx's injected module-scope function-name helper, which cannot travel inside
`Function.toString()` to an isolated child process. Compiler output is disposable;
there is no alternate storage or compatibility runtime.

To certify Anthropic Native's live success, rerun the same command with a credential
accepted by the Messages gateway. The current 403 evidence is retained only in this
sanitized result record; all raw online capture files have been removed.

## Repeat run

Repeated on 2026-09-30 at approximately 19:20 America/Los_Angeles
(2026-10-01 02:20 UTC), using `npm run test:online-diagnostics` and the same
credential file. Results were unchanged: Responses Direct/Native/Semantic and
Anthropic Semantic returned 200 in both JSON and streaming modes (eight successful
exchanges); Anthropic Native returned upstream 403 in both modes. All ten exchanges
passed persisted-byte/snapshot equality, decoded body reads, exact request-ID
directory naming, safe-envelope omission, and index-secret exclusion. The runner
exited 1 because Anthropic Native's live success remains unverified. Disposable
compiler output and capture/state directories were removed.

## Windows installer

`npm run build` completed successfully on 2026-09-30. The release Backend and
Electron bundles were rebuilt from the current sources. The packaged Electron
renderer destruction/reconstruction certification passed with an isolated
temporary `CODEX_HOME` before NSIS generation.

The retained Windows x64 installer is `installer/Token-Setup.exe`, version 1.4.1,
138,155,289 bytes. Build outputs remain excluded from Git.
