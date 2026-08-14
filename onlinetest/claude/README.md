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
`.claude/settings.json` with that server's base URL, a random local client
token, and `commandcode-private/deepseek/deepseek-v4-flash`. The upstream key
is read from git-ignored `../../CommandcodeAPIKey.txt` and is never written to
Claude settings or artifacts.

The generated LuckyToken configuration declares
`providerPackages["@luckytoken/provider-commandcode-private"]`. The server
exercises the generic Provider Package loader and resolves the installed
package from `node_modules`; it does not use a static Core import. The certified
run is 17 scenarios × 3 batches = 51/51 with Claude Code `2.1.210`.

Every Claude child runs non-interactively with an isolated config/session
directory, no MCP servers, and `--dangerously-skip-permissions` inside a
git-ignored per-scenario `.runs` workspace.
