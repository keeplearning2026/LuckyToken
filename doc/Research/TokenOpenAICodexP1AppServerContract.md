# Token OpenAI Codex P1: App-Server Contract Evidence

**Date:** 2026-10-01

**Scope:** P1 gate evidence for the one-shot `codex app-server` invocation used
to delegate in-place `auth.json` refresh. Read-only investigation; no Token
source changed. The plan is
[TokenOpenAICodexProviderPlan.md](../Spec/TokenOpenAICodexProviderPlan.md).

## 1. Environment and isolation

- Host: Windows 10.0.26200, x86_64.
- Runtime used: `%LOCALAPPDATA%\OpenAI\Codex\bin\de8a38d2100ae498\codex.exe`;
  both this binary and the npm shim report `codex-cli 0.159.2`.
- Every case used a newly created `%TEMP%\Token-p1-<random>\<case>` as
  `CODEX_HOME`, passed explicitly to the child process. No user `auth.json`,
  config, catalog, cache, session, or log was read or copied. The temp root was
  removed in `finally`; a post-run check found no `Token-p1-*` leftovers.
- The probe never used the user's real credentials; credential fixtures were
  synthetic fake tokens created explicitly inside the temp home.

## 2. Handshake and lifecycle

Sequence per case:

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"token-p1-probe","title":"Token P1 probe","version":"0.0.0"}}}
{"method":"initialized"}
{"id":2,"method":"account/read","params":{"refreshToken":true}}
```

Observed results:

| Observation | Result |
| --- | --- |
| `initialize` response | `userAgent: Codex Desktop/0.159.2 (Windows 10.0.26200; x86_64)`, `codexHome` echoing the temp home, `platformFamily/platformOs: windows` |
| `codexHome` echo | Proves the child used the explicit temp home |
| `initialized` | Accepted, no error |
| `account/read` result | `{account: null, requiresOpenaiAuth: true, workspaceRouting: null}` in all five cases |
| Exit on stdin close | Exit code 0 within 5 s in all five cases; no kill required |
| `initialize` latency | 202–3962 ms (fake-token cases slower) |
| `account/read` latency | 63–64 ms |
| Total per case | 277–4038 ms |

## 3. Startup side effects (the app-server is not side-effect free)

A fresh temp home gains, before any thread is started:

- `state_5.sqlite` (+ `-shm`, `-wal`; WAL ~1.99 MB),
- `logs_2.sqlite` (+ WAL ~119 KB), `goals_1.sqlite`, `memories_1.sqlite`,
  `queue_1.sqlite` (each with `-shm`/`-wal`),
- `installation_id`,
- `.tmp\git-*` scratch directories,
- `plugins.sync.lock`,
- a copied `.system` skills tree (`imagegen`, `openai-docs`, `review-agent`,
  `skill-creator`, `skill-installer`; ~100 KB+ of files).

stderr also carries a warning that the app-server refused to create PATH
aliases because `CODEX_HOME` is under the temp directory. The probe enumerated
only the temp home; it did not independently monitor writes outside it.
Confirmed scope: the child used the explicit temp home (echoed by
`initialize`), and the artifacts listed above are what appeared inside it.

Conclusion: the v3.1/v3 plan wording stands — Token's only *intended* mutation
is the auth refresh. The startup writes above are Codex-owned behavior that
Token cannot claim away. An isolation configuration that avoids them while
keeping auth in the original `CODEX_HOME` was not found and must not be assumed
(copying auth is forbidden).

## 4. Model catalog measurement refresh

`codex debug models --bundled` on 0.159.2 reports 11 rows, 8 listable:
gpt-6-astra, gpt-6.1-sol, gpt-6-sol, gpt-6-luna, gpt-5.6-sol,
gpt-5.6-terra, gpt-5.6-luna, gpt-5.5.

This adds `gpt-6.1-sol` relative to the 2026-09-30 0.158.0 measurement
(10 rows, 7 listable) and re-confirms the native-first premise: the local
catalog changes independently of the pinned Pi package.

## 5. Contract conclusions

1. The initialize/initialized/account-read sequence is accepted by the
   installed runtime; no extra handshake is required.
2. The explicit temp `CODEX_HOME` is honored and echoed by the server.
3. A one-shot process exits cleanly when stdin closes; bounded timeouts of
   15 s (initialize) and 30 s (account/read) are sufficient on this host.
4. Startup side effects are real and inventoried inside the temp home; the
   plan's narrowed guarantee is the correct wording, and P1 must not promise a
   clean home. Writes outside the temp home were not monitored.
5. RPC success does not carry refresh success; verification by re-reading the
   file remains mandatory (see the companion error-classification evidence).

## 6. Limitations

- No successful refresh was observed; that requires a dedicated test login
  (P4 gate).
- Timing and side-effect sizes are from one Windows host and one CLI version
  (0.159.2); the `reference/codex` sources may lag the installed runtime.
- The probe did not test whether configuration flags can bound the startup
  side effects while auth still points at the original home.
- The probe did not monitor process-level writes outside the temp home, so
  "no external writes" is not proven; only the temp-home inventory is
  evidence.
