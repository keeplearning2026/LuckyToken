# 25 — Actionable desktop notifications and tray aggregate state

## Parent

[GitHub Issue #1](https://github.com/keeplearning2026/Token/issues/1)

**What to build:** Surface only operational events that need user action as Windows notifications, while keeping ordinary model failures out of notification spam. The tray icon/menu summarizes gateway health and aggregate request failure state and can take the user to the relevant management page.

**Blocked by:** 04 — Tray Close, Show, and Quit entry points; 05 — Headless ownership and graceful application exit; 07 — Permanent Runtime Diagnostics and universal credential redaction; 13 — Provider-owned account/subscription authentication projection; 18 — Request Lifecycle Ledger tracer; 23 — History export/deletion and persistence-failure degradation.

**Status:** integrated

## Implementation method

Use the `$tdd` skill. Confirm the typed operational-event projection and thin Windows notification/tray smoke seam. Drive one public event to one visible result per red → green cycle; do not test native notification library calls directly.

## Acceptance criteria

- [x] Windows notifications are emitted for Data Plane startup failure, fixed-port conflict, persistence Critical, and Provider login invalidation.
- [x] Ordinary individual request failures never emit desktop notifications.
- [x] Tray state aggregates running/stopped/failed gateway health and recent request failures without exposing request bodies, credentials, or real model IDs unnecessarily.
- [x] Selecting an actionable notification or tray state opens/focuses the existing window at the relevant Dashboard, Providers, Requests, or Diagnostics context.
- [x] Duplicate unchanged events are coalesced so persistent faults do not repeatedly notify the user.
- [x] Recovery updates the tray state and permits the actionable notification condition to clear without deleting its permanent Diagnostics record.
- [x] Attaching a non-owner desktop UI projects the active instance state and does not create duplicate system notifications for one event.
- [x] Windows smoke tests cover the four actionable categories, ordinary-failure suppression, coalescing, navigation, recovery, and credential-free content.
