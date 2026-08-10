# 04 — Propagate project identity end to end

**What to build:** Carry an Auth-established project directory through Pi metadata to the CommandCode Private Provider, where it becomes the authoritative source for project snapshot and project-slug wire state, while a request without project identity remains explicitly project-less.

**Blocked by:** 03 — Complete the HTTP, client-auth, and session lifecycle.

**Status:** complete

- [x] Auth exposes only `projectDir?`; token/project lookup internals do not escape the boundary.
- [x] Option composition carries the fact only as `metadata.projectDir` with Auth as the sole producer.
- [x] A non-empty project directory remains project-bound even when filesystem or Git inspection encounters expected failures.
- [x] A missing, empty, or non-string project fact produces the typed project-less CommandCode config without filesystem, Git, or implicit cwd discovery.
- [x] Project-bound config follows the CommandCode protocol's structure, UTC date, Git command ordering, and successful-empty versus failure rules.
- [x] `x-project-slug` is derived late from the same project fact with the pinned compatibility behavior; no second long-lived project-slug authority is retained.
- [x] Project snapshot work is request-local, abort-aware where possible, computed once per logical Provider invocation, and not repeated on retry.
