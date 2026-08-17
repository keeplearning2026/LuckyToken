# 06 — Delete native Windows control-pipe implementation

**What to build:** Remove the native Windows Control Plane transport and its Rust build path once the pure TypeScript transport is the certified production path.

**Blocked by:** 05 — Cut Control Plane endpoint to address and capability.

**Status:** ready-for-agent

- [ ] Production Control Plane startup and client attachment no longer load or require a native Windows control-pipe package.
- [ ] Native control-pipe build scripts, package dependencies, Rust sources, Cargo metadata, and Windows-specific composition code are removed rather than disabled.
- [ ] Windows Control Plane transport and distribution tests pass using only the TypeScript/Node implementation.
- [ ] A clean install/build no longer invokes Cargo or a native control-pipe build step.
- [ ] No compatibility branch remains for the removed native transport.
