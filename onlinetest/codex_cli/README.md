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

This online harness intentionally constructs the CommandCode package through the
generic Provider Package test path so it can characterize that boundary directly.
That is **test-only composition**: production LuckyToken treats
`@luckytoken/provider-commandcode-private` as a bundled reserved product Provider
and rejects it in user `providerPackages`. The certified run is 20 scenarios ×
3 batches = 60/60 with Codex CLI `0.147.0`.
