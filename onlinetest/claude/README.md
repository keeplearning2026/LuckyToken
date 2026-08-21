# Claude Code Anthropic online test

From this directory:

```powershell
npm test
```

Pass a batch count to repeat the real-client matrix:

```powershell
npm test -- 3
```

The runner starts a fresh LuckyToken server and rewrites the git-ignored
`.claude/settings.json` with that server's base URL, a placeholder SDK credential
required by the Claude client shape, and `commandcode-private/deepseek/deepseek-v4-flash`.
LuckyToken's loopback Data Plane has no global/project client-token authority;
the placeholder is not a LuckyToken access token. The upstream key is read from
git-ignored `../../CommandcodeAPIKey.txt` and is never written to Claude settings
or artifacts.

This online harness intentionally constructs the CommandCode package through the
generic Provider Package test path so it can characterize that boundary directly.
That is **test-only composition**: production LuckyToken treats
`@luckytoken/provider-commandcode-private` as a bundled reserved product Provider
and rejects it in user `providerPackages`. The certified run is 17 scenarios ×
3 batches = 51/51 with Claude Code `2.1.210`.

Every Claude child runs non-interactively with an isolated config/session
directory, no MCP servers, and `--dangerously-skip-permissions` inside a
git-ignored per-scenario `.runs` workspace.
