# 06 — Settings-driven protocol, port, and LAN controls

## Parent

[GitHub Issue #1](https://github.com/keeplearning2026/LuckyToken/issues/1)

**What to build:** Let users configure stable application behavior from Settings/Developer Lab. Each Client Protocol can be independently enabled or disabled, all can be stopped while the Control Plane stays available, the Data Plane uses a fixed configurable port, and non-loopback plaintext listening requires a one-time confirmation. Only actively registered Developer Lab settings are exposed.

**Blocked by:** 02 — Windows Desktop Shell and empty Dashboard; 03 — Dashboard-managed Runtime Supervisor.

**Status:** completed

## Implementation method

Use the `$tdd` skill. Confirm Settings commands/queries/events and Data Plane HTTP reachability as the test seams. Test declared behavior and validation, not the storage format or UI form implementation.

## Acceptance criteria

- [x] Every stable setting and Developer Lab entry declares type, default, validation, sensitivity, and hot-apply or restart-required mode.
- [x] Anthropic Messages and OpenAI Responses can be enabled or disabled independently through UI and CLI using the same commands.
- [x] Disabling every Client Protocol stops all model routes while the local Control Plane remains usable.
- [x] Changing a restart-required port reports pending versus effective values and takes effect only through the declared lifecycle.
- [x] Loopback is the default bind scope and never requires a warning.
- [x] Changing to a non-loopback bind requires explicit one-time confirmation for that enable/change action; accepted plaintext HTTP does not produce a permanent warning.
- [x] Enabling LAN affects only model Data Plane routes; Control Plane operations remain unreachable remotely.
- [x] Unknown internal variables and unregistered experimental flags never appear in Developer Lab.
