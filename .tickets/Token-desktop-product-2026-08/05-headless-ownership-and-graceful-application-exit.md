# 05 — Headless ownership and graceful application exit

## Parent

[GitHub Issue #1](https://github.com/keeplearning2026/Token/issues/1)

**What to build:** Ensure one active Token application instance has explicit ownership. A desktop UI attaches to a headless instance instead of starting a second backend, closing that attached UI does not kill the headless owner, and an authorized owner Quit drains active requests before a configurable timeout and then aborts remaining work. Users can optionally start Token at Windows sign-in.

**Blocked by:** 03 — Dashboard-managed Runtime Supervisor; 04 — Tray Close, Show, and Quit entry points.

**Status:** completed

## Implementation method

Use the `$tdd` skill. Confirm the Control Plane ownership/lifecycle seam and thin Windows shell smoke seam. Use controlled long-running requests and a deterministic clock for red → green tests; do not assert on private process locks.

## Acceptance criteria

- [x] Starting a second backend detects and connects to the one active instance rather than binding another Data Plane.
- [x] A desktop UI can attach to an instance launched by the headless CLI and accurately reports that ownership.
- [x] Closing or detaching a non-owner desktop UI never stops the headless-owned gateway.
- [x] Owner Quit stops accepting new requests, waits for active requests to complete, and exits when the active set becomes empty.
- [x] After the configured drain timeout, remaining requests are aborted and the owner exits with an observable timeout outcome.
- [x] Non-owner Quit behavior is explicit and cannot silently terminate a user-started headless process.
- [x] Windows login auto-start can be enabled or disabled and its effective registration status is queryable.
- [x] Lifecycle tests cover single-instance discovery, attachment, owner/non-owner Quit, successful drain, timeout abort, and auto-start projection.
