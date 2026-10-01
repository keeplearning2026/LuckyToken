# Token OpenAI Codex P1: Error-Classification Evidence

**Date:** 2026-10-01

**Scope:** P1 gate evidence for classifying external `auth.json` failures
observed through the one-shot `codex app-server`
`account/read {"refreshToken": true}` call. Read-only investigation; no Token
source changed. Companion:
[TokenOpenAICodexP1AppServerContract.md](./TokenOpenAICodexP1AppServerContract.md).

## 1. Method

Five cases, each in a fresh temp `CODEX_HOME`, synthetic fixtures only:

| Case | Fixture |
| --- | --- |
| `no-auth` | no `auth.json` |
| `invalid-json` | truncated JSON in `auth.json` |
| `auth-dir` | a directory named `auth.json` (read fails) |
| `fake-expired-refresh` | ChatGPT-mode fake tokens, expired access JWT, fake refresh token, 30-day-old `last_refresh`, request with `refreshToken: true` |
| `fake-expired-no-refresh` | same fixture, request with `refreshToken: false` |

## 2. Observed results

| Case | RPC result | stderr evidence | `auth.json` after | Latency |
| --- | --- | --- | --- | --- |
| `no-auth` | `account: null`, `requiresOpenaiAuth: true` | none | absent | 64 ms |
| `invalid-json` | same | none | unchanged (hash match) | 63 ms |
| `auth-dir` | same | none | unchanged | 63 ms |
| `fake-expired-refresh` | same | 5× `ERROR Failed to refresh token: Your access token could not be refreshed. Please log out and sign in again.` (`codex_login::auth::manager`) | unchanged (hash match) | 64 ms (initialize 3962 ms) |
| `fake-expired-no-refresh` | same | the same 5× refresh errors | unchanged (hash match) | 63 ms (initialize 2584 ms) |

Key observations:

1. **The RPC does not distinguish failure classes.** Missing file, invalid
   JSON, an unreadable path, and a rejected refresh all returned the same
   `account: null / requiresOpenaiAuth: true` result.
2. **Refresh failure is only visible as stderr message text.** No structured
   error code or typed field was surfaced. The plan's rule stands: never parse
   stderr text to guess a terminal state.
3. **`refreshToken: false` did not suppress the observed refresh attempts** for
   an expired stored credential; the attempts may originate from startup auth
   loading. Callers must not use this flag as a "no refresh" control.
4. **In the tested rejected-refresh case, `auth.json` stayed byte-identical.**
   This is not generalized: a save failure, process crash, or concurrent
   writer can still produce a partial or rewritten file (the reference writer
   truncates before writing, `storage.rs:214`), and that window was not
   measured. The revision check remains necessary because it detects any
   content change that does occur.
5. **RPC success is not refresh success.** Token must re-read the file and
   verify account identity and validity before using any credential.

## 3. Classification rules derived from the evidence

| Class | Observable evidence | Evidence sufficiency | Rule |
| --- | --- | --- | --- |
| missing | `account: null`, no refresh logs | sufficient for "no usable credential" | treat as unavailable; prompt Codex login; bounded retry because the file may appear |
| invalid JSON | same RPC shape as missing | not distinguishable from RPC alone | classify with Token's own tolerant parse (see plan §3.4); bounded transient retry, never permanent |
| unreadable | same RPC shape as missing | not distinguishable from RPC alone | bounded transient; the file may be mid-rewrite or repaired |
| expired + refresh rejected | `account: null` plus stderr error text; file unchanged in this case (save-failure/crash windows untested) | **insufficient** for terminal | bounded transient attempts; do not lock a permanent reconnect state; if the file revision never advances after the budget, show an actionable "refresh through Codex" state that recovers when the file changes |
| transport/timeout | not observed in this run | insufficient | bounded transient; retry with backoff |
| valid credential | not tested (needs a dedicated login) | pending P4 | P4 gate |

## 4. Contract conclusions

1. Error classification cannot be derived from the `account/read` RPC result;
   Token's own re-read and verification are the authoritative signals.
2. The installed runtime does not expose a structured terminal signal for a
   rejected refresh on this path. The plan therefore keeps "insufficient
   evidence → bounded transient" and never fabricates a terminal state from
   stderr text.
3. `refreshToken: false` is not a guard against refresh attempts for an
   expired credential, so Token's own freshness boundary must prevent an
   expired external credential from being handed to any Pi refresh path.
4. A rejected refresh left the file unchanged in the tested case; this does
   not cover save failures, crashes, or concurrent writers. The revision check
   stays necessary and must tolerate a partially written file.

## 5. Limitations

- Synthetic credentials only; no successful rotation was observed.
- Network failure modes (timeout, DNS, 5xx) were not simulated.
- Results are from codex-cli 0.159.2 on one Windows host; the
  `reference/codex` sources may lag the installed runtime.
- The "file unchanged" observation is limited to the synthetic
  rejected-refresh case; the truncate/write save-failure window, process
  crashes, and concurrent writers were not measured.
- P4 must repeat this matrix with a dedicated test login and record
  success/failure/skip separately.
