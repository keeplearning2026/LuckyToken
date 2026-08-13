# 01 — Establish adapter-owned configuration seams

**What to build:** Operators can configure Anthropic conversion, Responses conversion, CommandCode conversion/transport, and failure logging without creating a central semantic switch. Each adapter receives one immutable, fully defaulted configuration snapshot containing only its own vocabulary.

**Blocked by:** None — can start immediately.

**Status:** completed

## Module seam

The composition root binds one opaque adapter-specific snapshot to each adapter. Parsing, defaults, enum validation, unknown-key rejection, and policy meaning live behind each adapter's configuration interface. Runtime does not branch on protocol policy values.

Anthropic and Responses use separate types and parsers even where values coincide. CommandCode configuration contains no Client Protocol terms. Failure logging is a protocol-neutral runtime capability with its own configuration.

## Information lifecycle

Raw configuration exists only during startup. Each owner validates, normalizes, freezes, and exposes the smallest snapshot its implementation needs. File paths and raw config objects never enter Pi invocation facts, messages, notices, or Provider calls.

## Acceptance criteria

- [x] Configuration supports every frozen request/response conversion key and default for all three adapters, adapter-owned transport/error-capture settings, and top-level failure logging.
- [x] Unknown keys, invalid enums, unsafe numeric ranges, and invalid nested shapes fail startup with a precise configuration path.
- [x] Anthropic and Responses do not import one another's configuration types, parsers, defaults, or policy helpers.
- [x] CommandCode does not import Client Protocol configuration or vocabulary.
- [x] Composition only binds snapshots/capabilities; it contains no semantic protocol-option branching.
- [x] Snapshots are immutable and cannot change between retries or during a request.
- [x] Existing auth/state/model configuration remains compatible or receives an explicit migration error.
- [x] Architecture tests fail if one Client Protocol imports another Client Protocol's modules.
- [x] Unit tests cover every default, enum, invalid value, unknown key, path resolution, and immutable snapshot.
- [x] Typecheck, lint, build, and configured-composition tests pass.

## Out of scope

Implementing the behaviours controlled by the new snapshots.
