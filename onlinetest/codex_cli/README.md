# Codex CLI online test

From this directory:

```powershell
npm test
```

Pass a batch count to repeat the 20-scenario real-client matrix:

```powershell
npm test -- 3
```

To certify the exact three-field Codex injection instead of the legacy test
profile overrides, supply a Codex-safe public alias and one scenario:

```powershell
npm test -- --injected-config --alias commandcode-private/deepseek-v4-flash --scenario chain_basic
```

This mode builds `token-model-catalog.json` from the installed bundled
catalog plus Pi model facts, runs the installed CLI preflight in a temporary
`CODEX_HOME`, enables the real integration authority, and launches Codex
without command-line overrides for `model_provider`, `openai_base_url`, or
`model_catalog_json`. It restores the nullable preimage after the run.

The runner starts a fresh Token server, reads the git-ignored
`../../CommandcodeAPIKey.txt`, creates an isolated temporary `CODEX_HOME`, and
runs the real Codex CLI against `/v1/responses`. Test child processes use
`--dangerously-bypass-approvals-and-sandbox` only inside per-scenario temporary
working directories.

This online harness intentionally constructs the CommandCode package through the
generic Provider Package test path so it can characterize that boundary directly.
That is **test-only composition**: production Token treats
`@token/provider-commandcode-private` as a bundled reserved product Provider
and rejects it in user `providerPackages`. The certified run is 20 scenarios ×
3 batches = 60/60 with Codex CLI `0.147.0`.
