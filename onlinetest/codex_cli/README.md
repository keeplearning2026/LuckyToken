# Codex CLI online test

From this directory:

```powershell
npm test
```

Pass a batch count to repeat the 20-scenario real-client matrix:

```powershell
npm test -- 3
```

The runner starts a fresh LuckyToken server, reads the git-ignored
`../../CommandcodeAPIKey.txt`, creates an isolated temporary `CODEX_HOME`, and
runs the real Codex CLI against `/v1/responses`. Test child processes use
`--dangerously-bypass-approvals-and-sandbox` only inside per-scenario temporary
working directories.

The generated LuckyToken configuration declares
`providerPackages["@luckytoken/provider-commandcode-private"]`. The server
therefore exercises the generic Provider Package loader and resolves the
installed package from `node_modules`; it does not use a static Core import.
The certified run is 20 scenarios × 3 batches = 60/60 with Codex CLI `0.147.0`.
