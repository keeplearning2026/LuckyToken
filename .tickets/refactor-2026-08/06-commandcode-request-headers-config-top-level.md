# 06 — Align CommandCode request headers, config, and top-level fields

**What to build:** A Pi invocation for the CommandCode private provider is
converted into the CommandCode `GenerateRequest` HTTP shape — method,
endpoint, application headers, `config`, and top-level fields — following
`PI AI IR-Commandcode Private Conversion.md` Part I §1–§4, with the exact
fixed/default/derived construction rules and no cross-side leakage.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Endpoint is `POST <model.baseUrl>/alpha/generate` preserving any
  existing base path (never `new URL("/alpha/generate", baseUrl)`); no other
  base URL fallback; invalid baseUrl → error.
- [ ] Headers match §2 exactly: fixed `Content-Type/Accept/User-Agent/
  x-command-code-version:1.9.0/x-cmd-zdr:"1"`, defaults
  `x-taste-learning:"false"`, `x-co-flag:"false"`,
  `x-cli-environment:"production"` with `"prod"→"production"`,
  `x-project-slug: slugify(projectDir) || "root"` when cwd present else
  `"root"`, `x-session-id` shared with body `threadId` (single resolution),
  `Authorization:"Bearer <apiKey>"` when non-empty else omitted,
  `x-oss-primary-provider` preserved when present; `traceparent` is
  attempt-owned and never built by semantic conversion.
- [ ] `metadata.projectDir` rules: absent/empty → empty config without
  reading filesystem/git and without `process.cwd()`; non-empty string →
  project-bound config; present-but-not-string → error.
- [ ] `config` is a complete `ServerConfig` with all required fields; the
  empty config is the stable documented JSON; `date` is UTC
  `new Date().toISOString().split("T")[0]` only for project-bound config;
  `environment = process.platform`.
- [ ] `structure` is a single `readdir(cwd)` of immediate names, hidden
  names removed, fixed case-sensitive exclusions removed, JavaScript default
  sort, extra workspace roots appended as `scope:<formatted-path>` after
  sorting; readdir failure → scope entries only.
- [ ] Git fields follow §3.3 exactly: `rev-parse --git-dir` gates
  isGitRepo; `branch --show-current` (trim); `symbolic-ref ...origin/HEAD`
  fallback chain (`branch -r` → `origin/main`/`origin/master`/default
  `"main"`); `status --porcelain` (`"Working tree clean"` for empty);
  `log --oneline -3` (split by newline); `GitOutput` distinguishes
  success-with-empty-output from failure.
- [ ] Top-level fields: `memory/taste/skills:null` (explicit, never omitted);
  `permissionMode` mapping `plan→plan`, `bypass|auto-accept→auto-accept`,
  else `standard`; `threadId` single session identity with header; `mode`
  omitted (no source).
- [ ] The whole `config` is constructed once per logical completion and
  reused; no second project read producing a different config.
- [ ] Unit tests cover header/config/top-level construction branches,
  including empty vs. project-bound config, readdir failure, and git
  fallback chains.

**Out of scope:** params scalars (07), messages/tools (08), final assembly
and serialization (10).
