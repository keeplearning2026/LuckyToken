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

Every Claude child runs non-interactively with an isolated config/session
directory, no MCP servers, and `--dangerously-skip-permissions` inside a
git-ignored per-scenario `.runs` workspace.
